import { createHmac } from "node:crypto";
import { z } from "zod";
import type { GitHubAuth } from "../auth/github.js";
import { GITHUB_API_ORIGIN, githubProgressFetch } from "../auth/github-progress-fetch.js";
import { GITHUB_APP_PERMISSION_VOCABULARY } from "../config/github-authority.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import { logger } from "../logger.js";
import {
  GitHubReplyOutputContextSchema,
  issueCommentPath,
  issueCommentsPath,
  repositoryPath,
} from "../triggers/github/reply.js";
import type { RunProgressMessage } from "../run-timeline/store.js";
import { retryAfterMs } from "./backoff.js";
import { allowsGitHubRepository } from "./mapping.js";
import type { RunProgressSettings } from "./settings.js";
import type {
  CredentialLocator,
  ProgressCall,
  ProgressProvider,
  RunScope,
  StoredRef,
} from "./types.js";

const visibilityTtlMs = 10 * 60_000;
const githubId = z.number().int().positive();
const repositoryName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."));
const notificationContext = z.object({
  provider: z.literal("github_notification"),
  event: z.object({
    github_notification: z.object({ repo: repositoryName, number: githubId.nullable() }),
  }),
});
const repositoryMetadata = z.object({ id: githubId, private: z.boolean() });
const commentId = z.object({ id: githubId });
const responseIdentity = commentId.extend({
  status: z.union([z.number(), z.string()]).optional(),
  message: z.never().optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
  data: z.never().optional(),
  documentation_url: z.never().optional(),
});
const commentIdentity = responseIdentity.extend({
  issue_url: z.string().optional(),
  html_url: z.string().optional(),
});
const lockedIssue = z.object({ locked: z.literal(true) });
const commentList = z.array(
  commentIdentity.extend({
    body: z.string().nullable(),
    user: z.object({ id: githubId }).nullable(),
  }),
);
const rejection = z.object({ rejected: z.boolean(), partial: z.boolean() });
const markerPrefix = "<!-- paseo-run-progress:";
const unknownWrite = { status: "retry", afterMs: 0, notCreated: false, transient: true } as const;
const targetMismatch = { status: "refused", code: "target_mismatch" } as const;
const installationNotOwned = { status: "refused", code: "installation_not_owned" } as const;
const invalidCredential = { status: "refused", code: "invalid_credential" } as const;
const credentialRejected = { status: "unavailable", code: "credential_rejected" } as const;
const visibilityUnknown = { status: "unavailable", code: "visibility_unknown" } as const;
const noCredential = { status: "unavailable", code: "no_credential" } as const;

type GitHubLocator = Extract<CredentialLocator, { kind: "installation" | "progress-token" }>;
type Destination = StoredRef & {
  credential: GitHubLocator;
  repository: string;
  issueNumber: number;
};
type Refusal = Extract<ProgressCall, { status: "refused" | "unavailable" }>;
interface GitHubResponse {
  status: number;
  headers: Headers;
  data: unknown;
}
type GitHubRequest = (
  signal: AbortSignal,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: string,
) => Promise<GitHubResponse>;
type Binding =
  | { kind: "progress-token"; slug: string }
  | {
      kind: "installation";
      connectionId: string;
      accountId: string;
      recordId: string;
      repositoryId: number;
    };
type Visibility = Pick<RunProgressMessage, "visibility" | "visibilityCheckedAt">;
interface VisibilityCheck extends Visibility {
  now: number;
  expectedRepositoryId: number | undefined;
  force: boolean;
  record: (visibility: Visibility) => void;
}
interface Authorization {
  run: RunScope;
  target: Destination;
  binding: Binding;
  repositoryId: number;
  request: GitHubRequest;
  secrets: readonly string[];
  marker: string;
  actorPath: string;
}

interface GitHubProgressOptions {
  database: Pick<
    Database,
    | "findTriggerRunForOrganization"
    | "findOrganizationSlugById"
    | "findGitHubConnection"
    | "findGitHubRepositoryForOrganization"
  >;
  settings: Pick<RunProgressSettings, "githubToken" | "githubOrgs" | "publicRepos">;
  app?: {
    id: string;
    slug: string;
    privateKey: string;
    auth: Pick<GitHubAuth, "createInstallationOctokit">;
  };
  fetch?: typeof fetch;
}

const warnedAboutScopes = new WeakSet<GitHubProgressOptions["settings"]>();

export class GitHubProgressProvider implements ProgressProvider {
  readonly name = "github";
  readonly maxBodyChars = 4_000;
  private readonly authorized = new WeakMap<CredentialLocator, Authorization>();
  private readonly fetch: typeof fetch;

  constructor(private readonly options: GitHubProgressOptions) {
    this.fetch = githubProgressFetch(options.fetch ?? fetch);
  }

  destination(run: AcceptedTriggerRunRecord): Destination | undefined {
    const app = GitHubReplyOutputContextSchema.safeParse(run.outputContext);
    if (app.success) {
      const repository = repositoryName.safeParse(app.data.target.repository);
      const issueNumber = app.data.event.github.item?.number;
      if (!repository.success || issueNumber === undefined) return undefined;
      return {
        credential: { kind: "installation", installationId: app.data.target.installationId },
        repository: repository.data,
        issueNumber,
      };
    }
    const notification = notificationContext.safeParse(run.triggerContext);
    if (!notification.success) return undefined;
    const { repo, number } = notification.data.event.github_notification;
    return number === null
      ? undefined
      : { credential: { kind: "progress-token" }, repository: repo, issueNumber: number };
  }

  async authorize(
    locator: CredentialLocator,
    scope: RunScope,
    signal: AbortSignal,
    check?: VisibilityCheck,
  ) {
    this.authorized.delete(locator);
    signal.throwIfAborted();
    if (locator.kind !== "installation" && locator.kind !== "progress-token")
      return { refused: invalidCredential.code };
    const run = await this.options.database.findTriggerRunForOrganization(
      scope.organizationId,
      scope.id,
    );
    signal.throwIfAborted();
    const target =
      run?.outcome === "accepted" && run.projectId === scope.projectId
        ? this.destination(run)
        : undefined;
    if (
      run?.outcome !== "accepted" ||
      target === undefined ||
      !sameCredential(locator, target.credential)
    )
      return { refused: targetMismatch.code };
    const binding = await this.readBinding(run, target);
    signal.throwIfAborted();
    if ("status" in binding) return authorizationRefusal(binding);
    const client = await this.client(locator, signal);
    if ("status" in client) return authorizationRefusal(client);
    signal.throwIfAborted();
    if (!sameBinding(await this.readBinding(run, target), binding))
      return authorizationRefusal(bindingChanged(locator));
    signal.throwIfAborted();
    const metadata = await this.checkVisibility(target, client.request, signal, check);
    if ("status" in metadata) return authorizationRefusal(metadata);
    if (binding.kind === "installation" && binding.repositoryId !== metadata.repositoryId)
      return { refused: targetMismatch.code };
    const marker = createHmac("sha256", client.markerKey)
      .update(
        JSON.stringify([
          run.organizationId,
          run.id,
          target.repository.toLowerCase(),
          target.issueNumber,
        ]),
      )
      .digest("hex");
    this.authorized.set(locator, {
      run,
      target,
      binding,
      marker: `${markerPrefix}${marker} -->`,
      ...metadata,
      ...client,
    });
    return "ok" as const;
  }

  async secrets(locator: CredentialLocator, signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted();
    return this.authorized.get(locator)?.secrets ?? [];
  }

  create(ref: StoredRef, body: string, signal: AbortSignal): Promise<ProgressCall> {
    return this.write("POST", ref, body, signal);
  }

  edit(ref: StoredRef, body: string, signal: AbortSignal): Promise<ProgressCall> {
    return this.write("PATCH", ref, body, signal);
  }

  async adopt(run: AcceptedTriggerRunRecord, signal: AbortSignal): Promise<StoredRef | undefined> {
    const target = this.destination(run);
    if (target === undefined || (await this.authorize(target.credential, run, signal)) !== "ok")
      return undefined;
    const auth = this.takeAuthorization(target.credential);
    if (auth === undefined) return undefined;
    const actorResponse = await auth.request(signal, "GET", auth.actorPath);
    const actor = responseIdentity.safeParse(actorResponse.data);
    if (
      !jsonSuccess(actorResponse) ||
      !actor.success ||
      !matchingStatus(actor.data.status, actorResponse.status) ||
      !sameBinding(await this.readBinding(run, target), auth.binding)
    )
      return undefined;
    signal.throwIfAborted();
    const query = new URLSearchParams({ since: run.createdAt.toISOString(), per_page: "100" });
    const [owner, repo] = splitRepository(target);
    const response = await auth.request(
      signal,
      "GET",
      `${issueCommentsPath(owner, repo, target.issueNumber)}?${query}`,
    );
    if (!jsonSuccess(response)) return undefined;
    const comments = commentList.safeParse(response.data);
    if (
      !comments.success ||
      comments.data.length > 100 ||
      comments.data.some(
        (comment) =>
          !matchingStatus(comment.status, response.status) || !matchesIssue(comment, target),
      )
    )
      return undefined;
    const matches = comments.data.filter(
      ({ body, user }) => user?.id === actor.data.id && body?.endsWith(`\n\n${auth.marker}`),
    );
    if (matches.length !== 1) return undefined;
    const ref = storedReference(auth, matches[0]!.id);
    const serialized = JSON.stringify(ref);
    return auth.secrets.some((secret) => secret !== "" && serialized.includes(secret))
      ? undefined
      : ref;
  }

  private async readBinding(run: RunScope, target: Destination): Promise<Binding | Refusal> {
    const { database, app, settings } = this.options;
    const locator = target.credential;
    if (locator.kind === "progress-token") {
      if (settings.githubToken === undefined) return noCredential;
      const slug = await database.findOrganizationSlugById(run.organizationId);
      if (slug === undefined || !Object.hasOwn(settings.githubOrgs, slug))
        return { status: "refused", code: "org_not_mapped" };
      return allowsGitHubRepository(settings.githubOrgs[slug]!, target.repository)
        ? { kind: "progress-token", slug }
        : { status: "refused", code: "repo_not_allowed" };
    }
    if (app === undefined) return noCredential;
    const [connection, repository] = await Promise.all([
      database.findGitHubConnection(locator.installationId),
      database.findGitHubRepositoryForOrganization(run.organizationId, target.repository),
    ]);
    if (
      connection === undefined ||
      connection.status !== "active" ||
      connection.organizationId !== run.organizationId ||
      connection.installationId !== locator.installationId ||
      connection.providerApplicationId !== app.id ||
      repository === undefined ||
      repository.connectionId !== connection.id ||
      repository.organizationId !== run.organizationId ||
      repository.fullName.toLowerCase() !== target.repository.toLowerCase()
    )
      return installationNotOwned;
    return {
      kind: "installation",
      connectionId: connection.id,
      accountId: connection.accountId,
      recordId: repository.id,
      repositoryId: repository.repositoryId,
    };
  }

  private async client(
    locator: GitHubLocator,
    signal: AbortSignal,
  ): Promise<
    | {
        request: GitHubRequest;
        secrets: readonly string[];
        markerKey: string;
        actorPath: string;
      }
    | Refusal
  > {
    signal.throwIfAborted();
    if (locator.kind === "progress-token") {
      const token = this.options.settings.githubToken;
      if (token === undefined) return noCredential;
      return {
        request: (requestSignal, method, path, body) =>
          this.tokenRequest(token, requestSignal, method, path, body),
        secrets: [token],
        markerKey: token,
        actorPath: "/user",
      };
    }
    const { app } = this.options;
    if (app === undefined) return noCredential;
    const octokit = await app.auth
      .createInstallationOctokit(locator.installationId, {
        retries: "off",
        signal,
      })
      .catch((error: unknown) => octokitError(error));
    signal.throwIfAborted();
    if (octokit !== undefined && "status" in octokit && octokit.status === 401)
      return credentialRejected;
    if (octokit === undefined || "status" in octokit)
      throw new Error("GitHub progress installation client unavailable");
    const auth: unknown = await Promise.resolve(octokit.auth()).catch(() => undefined);
    const token = z.object({ token: z.string().min(1) }).safeParse(auth);
    if (!token.success) return noCredential;
    return {
      request: async (requestSignal, method, path, body) => {
        requestSignal.throwIfAborted();
        const result = await octokit
          .request(`${method} ${path}`, {
            headers: { "x-github-api-version": GITHUB_APP_PERMISSION_VOCABULARY.apiVersion },
            ...(body === undefined ? {} : { body }),
            request: { signal: requestSignal, redirect: "manual" },
          })
          .then(octokitResponse, (error: unknown) => octokitError(error));
        return result ?? { status: 0, data: undefined, headers: new Headers() };
      },
      secrets: [token.data.token, app.privateKey],
      markerKey: app.privateKey,
      actorPath: `/users/${encodeURIComponent(`${app.slug}[bot]`)}`,
    };
  }

  private async tokenRequest(
    token: string,
    signal: AbortSignal,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: string,
  ): Promise<GitHubResponse> {
    signal.throwIfAborted();
    const response = await this.fetch(`${GITHUB_API_ORIGIN}${path}`, {
      method,
      signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": GITHUB_APP_PERMISSION_VOCABULARY.apiVersion,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify({ body }) }),
    });
    const { settings } = this.options;
    if (response.ok && response.headers.has("x-oauth-scopes") && !warnedAboutScopes.has(settings)) {
      warnedAboutScopes.add(settings);
      logger.warn("GitHub progress token has broader scopes than needed");
    }
    const data: unknown = await response.json().catch(() => undefined);
    return { status: response.status, headers: response.headers, data };
  }

  private async checkVisibility(
    target: Destination,
    request: GitHubRequest,
    signal: AbortSignal,
    check: VisibilityCheck | undefined,
  ): Promise<{ repositoryId: number } | Refusal> {
    const cached = cachedVisibility(check);
    let metadata = cached;
    if (metadata === undefined) {
      const [owner, repo] = splitRepository(target);
      const fresh = await readRepository(request, repositoryPath(owner, repo), signal);
      if ("status" in fresh) {
        if (fresh === visibilityUnknown)
          check?.record({ visibility: "unknown", visibilityCheckedAt: new Date(check.now) });
        return fresh;
      }
      if (check?.expectedRepositoryId !== undefined && check.expectedRepositoryId !== fresh.id)
        return targetMismatch;
      metadata = { repositoryId: fresh.id, visibility: fresh.private ? "private" : "public" };
      check?.record({ visibility: metadata.visibility, visibilityCheckedAt: new Date(check.now) });
    }
    if (metadata.visibility === "public" && this.options.settings.publicRepos === "refuse")
      return {
        status: "refused",
        code: check?.visibility === "private" ? "visibility_changed" : "public_repository",
      };
    return { repositoryId: metadata.repositoryId };
  }

  private takeAuthorization(locator: CredentialLocator): Authorization | undefined {
    const auth = this.authorized.get(locator);
    this.authorized.delete(locator);
    return auth;
  }

  private async write(
    method: "POST" | "PATCH",
    ref: StoredRef,
    body: string,
    signal: AbortSignal,
  ): Promise<ProgressCall> {
    try {
      signal.throwIfAborted();
      const auth = this.takeAuthorization(ref.credential);
      if (auth === undefined) return invalidCredential;
      const comment = commentId.safeParse({ id: ref["commentId"] });
      if (method === "PATCH" && !comment.success)
        return { status: "unavailable", code: "invalid_reference" };
      const commentNumber = method === "PATCH" ? comment.data?.id : undefined;
      if (!matchesTarget(auth, ref, commentNumber !== undefined)) return targetMismatch;
      if (body.includes(markerPrefix) || auth.secrets.some((secret) => body.includes(secret)))
        return { status: "refused", code: "body_contains_secret" };
      if (!sameBinding(await this.readBinding(auth.run, auth.target), auth.binding))
        return bindingChanged(auth.target.credential);
      signal.throwIfAborted();
      const [owner, repo] = splitRepository(auth.target);
      const path =
        commentNumber === undefined
          ? issueCommentsPath(owner, repo, auth.target.issueNumber)
          : issueCommentPath(owner, repo, commentNumber);
      const response = await auth.request(
        signal,
        method,
        path,
        `${body}

${auth.marker}`,
      );
      return await mutationResult(auth, commentNumber, response, signal);
    } catch {
      return unknownWrite;
    }
  }
}

function cachedVisibility(check: VisibilityCheck | undefined) {
  if (check === undefined || check.force || check.expectedRepositoryId === undefined)
    return undefined;
  const { visibility, visibilityCheckedAt } = check;
  if (visibilityCheckedAt === null || check.now - visibilityCheckedAt.getTime() >= visibilityTtlMs)
    return undefined;
  if (visibility === "private" || visibility === "public")
    return { repositoryId: check.expectedRepositoryId, visibility };
  return undefined;
}

async function readRepository(request: GitHubRequest, path: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(2_500)]);
    const response = await request(readSignal, "GET", path).catch(() => undefined);
    signal.throwIfAborted();
    if (response?.status === 401) return credentialRejected;
    if (response?.status !== 200) continue;
    const metadata = repositoryMetadata.safeParse(response.data);
    if (metadata.success) return metadata.data;
  }
  return visibilityUnknown;
}

function matchesTarget(auth: Authorization, ref: StoredRef, edit: boolean): boolean {
  const repository = ref["repository"];
  return (
    ref["issueNumber"] === auth.target.issueNumber &&
    typeof repository === "string" &&
    repository.toLowerCase() === auth.target.repository.toLowerCase() &&
    (!edit || ref["repositoryId"] === auth.repositoryId)
  );
}

async function mutationResult(
  auth: Authorization,
  commentNumber: number | undefined,
  response: GitHubResponse,
  signal: AbortSignal,
): Promise<ProgressCall> {
  const create = commentNumber === undefined;
  if (response.status >= 200 && response.status < 300) {
    const comment = commentIdentity.safeParse(response.data);
    if (
      !jsonSuccess(response) ||
      !comment.success ||
      !matchingStatus(comment.data.status, response.status)
    )
      return unknownWrite;
    if (create) {
      return response.status === 201 && matchesIssue(comment.data, auth.target)
        ? { status: "ok", ref: storedReference(auth, comment.data.id) }
        : unknownWrite;
    }
    return comment.data.id === commentNumber ? { status: "ok" } : unknownWrite;
  }
  const failure = writeFailure(response, create);
  if (failure.status !== "unavailable" || failure.code !== "scope_missing") return failure;
  const [owner, repo] = splitRepository(auth.target);
  const issue = await auth
    .request(signal, "GET", `${repositoryPath(owner, repo)}/issues/${auth.target.issueNumber}`)
    .catch(() => undefined);
  return issue?.status === 200 && lockedIssue.safeParse(issue.data).success
    ? { status: "unavailable", code: "locked" }
    : failure;
}

function jsonSuccess(response: GitHubResponse): boolean {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return (
    response.status >= 200 &&
    response.status < 300 &&
    (type === "application/json" ||
      (type?.startsWith("application/") === true && type.endsWith("+json")))
  );
}

function matchingStatus(bodyStatus: number | string | undefined, status: number): boolean {
  return bodyStatus === undefined || bodyStatus === status || bodyStatus === String(status);
}

function matchesIssue(comment: z.infer<typeof commentIdentity>, target: Destination): boolean {
  const { issue_url, html_url } = comment;
  if (issue_url === undefined && html_url === undefined) return false;
  const repository = target.repository.toLowerCase();
  const issue = target.issueNumber;
  return (
    (issue_url === undefined ||
      matchingUrl(issue_url, GITHUB_API_ORIGIN, [`/repos/${repository}/issues/${issue}`], "")) &&
    (html_url === undefined ||
      matchingUrl(
        html_url,
        "https://github.com",
        [`/${repository}/issues/${issue}`, `/${repository}/pull/${issue}`],
        `#issuecomment-${comment.id}`,
      ))
  );
}

function matchingUrl(value: string, origin: string, paths: readonly string[], fragment: string) {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.origin === origin &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    (url.hash === "" || url.hash === fragment) &&
    paths.includes(url.pathname.toLowerCase())
  );
}

function sameBinding(current: Binding | Refusal, expected: Binding): boolean {
  if ("status" in current || current.kind !== expected.kind) return false;
  if (current.kind === "progress-token")
    return expected.kind === "progress-token" && current.slug === expected.slug;
  return (
    expected.kind === "installation" &&
    current.connectionId === expected.connectionId &&
    current.accountId === expected.accountId &&
    current.recordId === expected.recordId &&
    current.repositoryId === expected.repositoryId
  );
}

function sameCredential(a: GitHubLocator, b: GitHubLocator): boolean {
  return a.kind === "progress-token"
    ? b.kind === "progress-token"
    : b.kind === "installation" && a.installationId === b.installationId;
}

function authorizationRefusal(outcome: Refusal): { refused: string } | { unavailable: string } {
  return outcome.status === "refused" ? { refused: outcome.code } : { unavailable: outcome.code };
}

function bindingChanged(locator: GitHubLocator): Refusal {
  return locator.kind === "installation"
    ? installationNotOwned
    : { status: "refused", code: "org_not_mapped" };
}

function splitRepository(target: Destination): [string, string] {
  const [owner, repo] = target.repository.split("/");
  return [owner!, repo!];
}

function storedReference(auth: Authorization, id: number): StoredRef {
  return { ...auth.target, repositoryId: auth.repositoryId, commentId: id };
}

function octokitError(error: unknown): GitHubResponse | undefined {
  const parsed = z
    .object({
      response: z.object({
        status: z.number(),
        headers: z.record(z.string(), z.string()),
        data: z.unknown(),
      }),
    })
    .safeParse(error);
  return parsed.success ? octokitResponse(parsed.data.response) : undefined;
}

function octokitResponse(response: {
  status: number;
  headers: Record<string, unknown>;
  data: unknown;
}): GitHubResponse {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === "string" || typeof value === "number") headers.set(name, String(value));
  }
  return { status: response.status, data: response.data, headers };
}

function writeFailure({ status, headers, data }: GitHubResponse, create: boolean): ProgressCall {
  const evidence = rejection.safeParse(data);
  if (create && evidence.data?.partial === true) return unknownWrite;
  if (status === 401) return credentialRejected;
  if (status === 404 || status === 410)
    return create ? { status: "unavailable", code: "target_not_found" } : { status: "gone" };
  if (status === 422) return { status: "unavailable", code: "rejected" };
  if (status === 403 && headers.has("x-github-sso"))
    return { status: "unavailable", code: "sso_required" };
  const retryAfter = headers.get("retry-after");
  const exhausted = headers.get("x-ratelimit-remaining") === "0";
  if (status === 429 || (status === 403 && (retryAfter !== null || exhausted))) {
    if (create && evidence.data?.rejected !== true) return unknownWrite;
    return {
      status: "retry",
      afterMs: retryAfterMs(headers, Date.now()) ?? 60_000,
      notCreated: create,
    };
  }
  if (status === 403) return { status: "unavailable", code: "scope_missing" };
  return unknownWrite;
}
