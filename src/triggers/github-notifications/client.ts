import { z } from "zod";
import { GitHubNotificationThreadSchema, type GitHubNotificationThread } from "./notification.js";

const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 50;
/** A poll that needs more pages than this fails and leaves the cursor, so nothing is skipped. */
const MAX_PAGES = 40;

export type NotificationFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ListNotificationsInput {
  since: Date;
  /** The Last-Modified of the previous successful poll. */
  lastModified: string | null;
  signal?: AbortSignal;
}

export type ListNotificationsResult =
  | { status: "not_modified"; pollIntervalSeconds: number | undefined }
  | {
      status: "ok";
      notifications: GitHubNotificationThread[];
      lastModified: string | null;
      pollIntervalSeconds: number | undefined;
    };

export interface GitHubNotificationsClient {
  list(input: ListNotificationsInput): Promise<ListNotificationsResult>;
}

/** An API failure. The message never contains the token. */
export class GitHubNotificationsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubNotificationsError";
  }
}

export interface GitHubNotificationsClientOptions {
  token: string;
  fetch?: NotificationFetch;
  apiRoot?: string;
}

export function createGitHubNotificationsClient(
  options: GitHubNotificationsClientOptions,
): GitHubNotificationsClient {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const root = options.apiRoot ?? API_ROOT;
  const scrub = (text: string) =>
    options.token.length === 0 ? text : text.replaceAll(options.token, "[redacted]");

  return {
    async list({ since, lastModified, signal }) {
      const notifications: GitHubNotificationThread[] = [];
      let firstLastModified: string | null = null;
      let pollIntervalSeconds: number | undefined;
      let url: string | undefined = firstPage(root, since);
      for (let page = 0; url !== undefined; page++) {
        checkPageAvailable(page, signal);
        const response = await send({
          fetcher: request,
          target: url,
          token: options.token,
          ifModifiedSince: page === 0 ? lastModified : null,
          signal,
          scrub,
        });
        signal?.throwIfAborted();
        pollIntervalSeconds ??= readPollInterval(response);
        if (isFirstPageNotModified(response, page)) {
          return { status: "not_modified", pollIntervalSeconds };
        }
        if (!response.ok) {
          const error = await failure(response, scrub);
          signal?.throwIfAborted();
          throw error;
        }
        if (page === 0) firstLastModified = response.headers.get("last-modified");
        const threads = await readPage(response, scrub, signal);
        signal?.throwIfAborted();
        notifications.push(...threads);
        url = nextLink(response.headers.get("link"), root);
      }
      return {
        status: "ok",
        notifications,
        lastModified: firstLastModified,
        pollIntervalSeconds,
      };
    },
  };
}

function checkPageAvailable(page: number, signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
  if (page >= MAX_PAGES) {
    throw new GitHubNotificationsError("GitHub notifications exceeded the page limit.");
  }
}

function isFirstPageNotModified(response: Response, page: number): boolean {
  return response.status === 304 && page === 0;
}

interface SendOptions {
  fetcher: NotificationFetch;
  target: string;
  token: string;
  ifModifiedSince: string | null;
  signal: AbortSignal | undefined;
  scrub: (text: string) => string;
}

async function send({
  fetcher,
  target,
  token,
  ifModifiedSince,
  signal,
  scrub,
}: SendOptions): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "paseo-hub-github-notifications",
  };
  if (ifModifiedSince !== null) headers["if-modified-since"] = ifModifiedSince;
  try {
    return await fetcher(target, {
      method: "GET",
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : "request failed";
    throw new GitHubNotificationsError(scrub(`GitHub notifications request failed: ${reason}`));
  }
}

function firstPage(root: string, since: Date): string {
  const query = new URLSearchParams({
    all: "true",
    participating: "true",
    since: since.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    per_page: String(PAGE_SIZE),
    page: "1",
  });
  return `${root}/notifications?${query.toString()}`;
}

function readPollInterval(response: Response): number | undefined {
  const value = Number(response.headers.get("x-poll-interval"));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readPage(
  response: Response,
  scrub: (text: string) => string,
  signal: AbortSignal | undefined,
): Promise<GitHubNotificationThread[]> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    signal?.throwIfAborted();
    throw new GitHubNotificationsError("GitHub notifications returned a body that is not JSON.");
  }
  const parsed = z.array(GitHubNotificationThreadSchema).safeParse(body);
  if (!parsed.success) {
    throw new GitHubNotificationsError(
      scrub("GitHub notifications returned an unexpected response shape."),
    );
  }
  return parsed.data;
}

async function failure(
  response: Response,
  scrub: (text: string) => string,
): Promise<GitHubNotificationsError> {
  let detail = "";
  try {
    const body: unknown = await response.json();
    const message = z.object({ message: z.string() }).safeParse(body);
    if (message.success) detail = `: ${message.data.message}`;
  } catch {
    // The status alone is enough.
  }
  return new GitHubNotificationsError(
    scrub(`GitHub notifications returned ${String(response.status)}${detail}`),
    response.status,
  );
}

/** Follows `rel="next"` only when it stays on the API host the client was given. */
function nextLink(header: string | null, root: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(part);
    const target = match?.[1];
    if (target !== undefined && target.startsWith(`${root}/`)) return target;
  }
  return undefined;
}
