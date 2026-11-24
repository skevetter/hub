import { addAbortListener } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import jwt from "jsonwebtoken";
import { Octokit } from "octokit";
import { z } from "zod";
import { logger } from "../logger.js";
import { githubProgressFetch } from "./github-progress-fetch.js";
import { GITHUB_APP_PERMISSION_VOCABULARY } from "../config/github-authority.js";
import { GitHubInstallationSchema } from "./github-events.js";
import type { GitHubInstallation } from "./github-events.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;
const MAX_REVOKE_TIMEOUT_MS = 20_000;
const REVOKE_RETRY_DELAYS_MS = [500, 1_500] as const;

interface InstallationTokenCacheEntry {
  expiresAt: number;
  token: string;
}

export interface GitHubAppBotIdentity {
  id: number;
  login: string;
}

export interface GitHubInstallationAccessToken {
  token: string;
  expiresAt: number;
}

export type GitHubAppPermissionLevel = "read" | "write" | "admin";

const InstallationTokenResponseSchema = z
  .object({
    token: z.string(),
    expires_at: z.string(),
  })
  .loose();
const GitHubAppBotIdentitySchema = z.object({ id: z.number().int().positive(), login: z.string() });

interface ProgressOctokitOptions {
  retries: "off";
  signal?: AbortSignal;
  beforeTokenRequest?: () => Promise<void>;
}

export interface GitHubAuth {
  getInstallation(installationId: number): Promise<GitHubInstallation | undefined>;
  getInstallationToken(installationId: number): Promise<string>;
  mintInstallationToken(installationId: number): Promise<GitHubInstallationAccessToken>;
  mintInstallationAccessToken(input: {
    installationId: number;
    accountLogin: string;
    repositories: readonly string[];
    permissions: Readonly<Record<string, GitHubAppPermissionLevel>>;
  }): Promise<GitHubInstallationAccessToken>;
  getAppBotIdentity(appSlug: string, installationToken: string): Promise<GitHubAppBotIdentity>;
  revokeInstallationToken(token: string): Promise<void>;
  createInstallationOctokit(
    installationId: number,
    request?: ProgressOctokitOptions,
  ): Promise<Octokit>;
}

interface CreateGitHubAuthOptions {
  appId: string;
  privateKey: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  revokeTimeoutMs?: number;
  revokeRetryDelaysMs?: readonly [number, number];
  now?: () => number;
  /** Octokit retry (one attempt) and fail-fast write throttling stay on unless a caller turns them off. */
  octokitPlugins?: { retry?: boolean; throttle?: boolean };
}

export function createGitHubAuth(options: CreateGitHubAuthOptions): GitHubAuth {
  const client = new GitHubAppClient(options);
  return {
    getInstallation: (installationId) => client.getInstallation(installationId),
    getInstallationToken: (installationId) => client.getInstallationToken(installationId),
    mintInstallationToken: (installationId) => client.mintInstallationToken(installationId),
    mintInstallationAccessToken: (input) => client.mintInstallationAccessToken(input),
    getAppBotIdentity: (appSlug, installationToken) =>
      client.getAppBotIdentity(appSlug, installationToken),
    revokeInstallationToken: (token) => client.revokeInstallationToken(token),
    createInstallationOctokit: (installationId, progress) =>
      client.createInstallationOctokit(installationId, progress),
  };
}

interface TokenRestrictions {
  repositories: readonly string[];
  permissions: Readonly<Record<string, GitHubAppPermissionLevel>>;
}

class GitHubAppClient {
  private readonly installationTokenCache = new Map<number, InstallationTokenCacheEntry>();
  private readonly appBotIdentityCache = new Map<string, Promise<GitHubAppBotIdentity>>();
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: CreateGitHubAuthOptions) {
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    validateRequestTimeout(this.requestTimeoutMs);
  }

  async getInstallation(installationId: number): Promise<GitHubInstallation | undefined> {
    const octokit = await this.getAppOctokit();
    try {
      const response = await octokit.request("GET /app/installations/{installation_id}", {
        installation_id: installationId,
      });
      return GitHubInstallationSchema.parse(response.data);
    } catch (error) {
      if (hasHttpStatus(error, 404)) return undefined;
      throw error;
    }
  }

  async getInstallationToken(
    installationId: number,
    progress?: ProgressOctokitOptions,
  ): Promise<string> {
    progress?.signal?.throwIfAborted();
    const cachedEntry = this.installationTokenCache.get(installationId);
    const refreshWindowMs = 60_000;

    if (cachedEntry !== undefined && cachedEntry.expiresAt - refreshWindowMs > this.now()) {
      return cachedEntry.token;
    }

    const data = await this.requestInstallationToken(installationId, undefined, progress);

    this.installationTokenCache.set(installationId, {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    });

    if (progress === undefined)
      logger.debug({ installationId, expiresAt: data.expires_at }, "refreshed installation token");

    return data.token;
  }

  async mintInstallationToken(installationId: number): Promise<GitHubInstallationAccessToken> {
    const data = await this.requestInstallationToken(installationId);
    logger.debug({ installationId, expiresAt: data.expires_at }, "minted installation token");
    return { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  }

  async mintInstallationAccessToken(input: {
    installationId: number;
    accountLogin: string;
    repositories: readonly string[];
    permissions: Readonly<Record<string, GitHubAppPermissionLevel>>;
  }): Promise<GitHubInstallationAccessToken> {
    const data = await this.requestInstallationToken(input.installationId, {
      repositories: repositoryNamesForAccount(input.repositories, input.accountLogin),
      permissions: { ...input.permissions },
    });
    logger.debug(
      { installationId: input.installationId, expiresAt: data.expires_at },
      "minted scoped installation token",
    );
    return { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  }

  async revokeInstallationToken(token: string): Promise<void> {
    const octokit = this.plainOctokit(token);
    const signal = AbortSignal.timeout(
      Math.min(this.options.revokeTimeoutMs ?? MAX_REVOKE_TIMEOUT_MS, MAX_REVOKE_TIMEOUT_MS),
    );
    const retryDelays = this.options.revokeRetryDelaysMs ?? REVOKE_RETRY_DELAYS_MS;
    let attempts = 0;
    for (const retryDelay of [...retryDelays, undefined]) {
      attempts++;
      try {
        await requestTokenRevocation(octokit, signal);
        return;
      } catch (error) {
        const status = revocationHttpStatus(error);
        // An expired or previously revoked token no longer grants access.
        if (status === 401 || status === 404) return;
        if (
          retryDelay !== undefined &&
          isRetryableRevocation(status) &&
          (await waitForRevocationRetry(retryDelay, signal))
        )
          continue;
        logger.warn(
          { attempts, status },
          "installation token revocation failed; token stays valid until it expires",
        );
        throw error;
      }
    }
  }

  getAppBotIdentity(appSlug: string, installationToken: string): Promise<GitHubAppBotIdentity> {
    const cached = this.appBotIdentityCache.get(appSlug);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.fetchAppBotIdentity(appSlug, installationToken);
    this.appBotIdentityCache.set(appSlug, pending);
    return pending.catch((error: unknown) => {
      if (this.appBotIdentityCache.get(appSlug) === pending)
        this.appBotIdentityCache.delete(appSlug);
      throw error;
    });
  }

  async createInstallationOctokit(
    installationId: number,
    progress?: ProgressOctokitOptions,
  ): Promise<Octokit> {
    const token = await this.getInstallationToken(installationId, progress);
    progress?.signal?.throwIfAborted();
    return this.authenticatedOctokit(token, progress);
  }

  private async fetchAppBotIdentity(
    appSlug: string,
    installationToken: string,
  ): Promise<GitHubAppBotIdentity> {
    const octokit = this.plainOctokit(installationToken);
    const response = await octokit.request("GET /users/{username}", {
      username: `${appSlug}[bot]`,
    });
    return GitHubAppBotIdentitySchema.parse(response.data);
  }

  private async requestInstallationToken(
    installationId: number,
    restrictions?: TokenRestrictions,
    progress?: ProgressOctokitOptions,
  ) {
    progress?.signal?.throwIfAborted();
    const octokit = await this.getAppOctokit(progress);
    progress?.signal?.throwIfAborted();
    await progress?.beforeTokenRequest?.();
    progress?.signal?.throwIfAborted();
    const response = await octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        headers: githubApiVersionHeader(),
        ...tokenRequestScope(restrictions, progress),
      },
    );
    return InstallationTokenResponseSchema.parse(response.data);
  }

  private async getAppOctokit(progress?: ProgressOctokitOptions): Promise<Octokit> {
    return this.authenticatedOctokit(await this.createAppJwt(), progress);
  }

  private plainOctokit(auth: string): Octokit {
    const octokit = new Octokit({
      auth,
      request: { fetch: githubTimeoutFetch(this.options.fetch ?? fetch, this.requestTimeoutMs) },
      ...pluginOverrides(this.options),
    });
    octokit.hook.before("request", refuseRetryOfCreateComment(octokit));
    return octokit;
  }

  private authenticatedOctokit(auth: string, progress?: ProgressOctokitOptions): Octokit {
    if (progress === undefined) return this.plainOctokit(auth);
    return new Octokit({
      auth,
      request: { fetch: githubProgressFetch(this.options.fetch ?? fetch) },
      retry: { enabled: false },
      throttle: { enabled: false },
    });
  }

  private async createAppJwt(): Promise<string> {
    const nowSeconds = Math.floor(this.now() / 1000);

    return jwt.sign(
      {
        iat: nowSeconds - 60,
        exp: nowSeconds + 10 * 60,
        iss: this.options.appId,
      },
      this.options.privateKey,
      {
        algorithm: "RS256",
      },
    );
  }
}

async function requestTokenRevocation(octokit: Octokit, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => aborted.reject(signal.reason));
  try {
    await Promise.race([
      octokit.request("DELETE /installation/token", {
        headers: githubApiVersionHeader(),
        request: { retries: 0, signal },
      }),
      aborted.promise,
    ]);
  } finally {
    listener[Symbol.dispose]();
  }
}

function revocationHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response: unknown = Reflect.get(error, "response");
  if (typeof response !== "object" || response === null) return undefined;
  const status: unknown = Reflect.get(response, "status");
  return typeof status === "number" ? status : undefined;
}

function isRetryableRevocation(status: number | undefined): boolean {
  return status === undefined || (status >= 500 && status < 600);
}

async function waitForRevocationRetry(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await delay(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

function tokenRequestScope(
  restrictions: TokenRestrictions | undefined,
  progress: ProgressOctokitOptions | undefined,
) {
  return {
    ...(progress?.signal === undefined ? {} : { request: { signal: progress.signal } }),
    ...(restrictions === undefined
      ? {}
      : {
          repositories: [...restrictions.repositories],
          permissions: { ...restrictions.permissions },
        }),
  };
}
// 429 is rate limiting: the throttle plugin owns it, and a blind retry would only add load.
const RETRY_POLICY = { retries: 1, doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451] };

// The Octokit default waits out the quota reset (up to an hour) inside the caller, which is far
// longer than the 30 s notification lease and GitHub's 10 s webhook window. Fail instead.
function failFastOnRateLimit(kind: "primary" | "secondary") {
  return (retryAfterSeconds: number, request: { method: string; url: string }): false => {
    logger.warn(
      { kind, retryAfterSeconds, method: request.method, route: routeShape(request.url) },
      "GitHub rate limit reached",
    );
    return false;
  };
}

// Keeps account, repository and id values out of the log for templates, resolved URLs and
// URLs behind an API base prefix.
function routeShape(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+/u, "")
    .replace(/[?#].*$/u, "")
    .replace(/\/repos\/[^/]+\/[^/]+/gu, "/repos/:owner/:repo")
    .replace(/\/(orgs|users)\/[^/]+/gu, "/$1/:name")
    .replace(/\/\d+(?=\/|$)/gu, "/:id");
}

const THROTTLE_POLICY = {
  onRateLimit: failFastOnRateLimit("primary"),
  onSecondaryRateLimit: failFastOnRateLimit("secondary"),
};

// Not anchored at the start so an API base prefix such as /api/v3 still matches.
const CREATE_COMMENT_PATH = /\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/comments$/u;

type HookedRequest = Parameters<Octokit["request"]["endpoint"]["parse"]>[0] & {
  request?: object;
};

// A retried POST after a lost response would publish the comment twice. The hook sees the
// request before Octokit expands templates and trailing slashes, so the endpoint parser
// resolves it first. The nested request object can be shared with the client defaults, so it
// is replaced, never mutated.
function refuseRetryOfCreateComment(octokit: Octokit) {
  return (options: HookedRequest) => {
    const resolved = octokit.request.endpoint.parse(options);
    if (resolved.method !== "POST") return;
    if (CREATE_COMMENT_PATH.test(new URL(resolved.url).pathname)) {
      options.request = { ...options.request, retries: 0 };
    }
  };
}

function pluginOverrides(options: CreateGitHubAuthOptions) {
  const plugins = options.octokitPlugins;
  return {
    retry: plugins?.retry === false ? { enabled: false } : RETRY_POLICY,
    throttle: plugins?.throttle === false ? { enabled: false } : THROTTLE_POLICY,
  };
}

function validateRequestTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(
      `GitHub requestTimeoutMs must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
}

function githubTimeoutFetch(request: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const caller = init?.signal;
    const signal = caller == null ? timeout : AbortSignal.any([caller, timeout]);
    const response = await request(input, { ...init, signal });
    if (!response.ok || response.body === null) return response;
    return bufferGitHubResponse(response, signal);
  };
}

async function bufferGitHubResponse(response: Response, signal: AbortSignal): Promise<Response> {
  // Octokit can swallow a body read failure and report a successful request.
  const body = await response.arrayBuffer().catch((error: unknown) => {
    signal.throwIfAborted();
    throw error;
  });
  signal.throwIfAborted();
  const buffered = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return Object.defineProperty(buffered, "url", { value: response.url });
}

function githubApiVersionHeader() {
  return { "x-github-api-version": GITHUB_APP_PERMISSION_VOCABULARY.apiVersion };
}

export function repositoryNamesForAccount(
  repositories: readonly string[],
  accountLogin: string,
): readonly string[] {
  return repositories.map((repository) => repositoryName(repository, accountLogin));
}

function repositoryName(repository: string, accountLogin: string): string {
  const parts = repository.split("/");
  const owner = parts.length === 2 ? parts[0] : undefined;
  const name = parts.length === 2 ? parts[1] : undefined;
  if (owner === undefined || owner.length === 0 || name === undefined || name.length === 0)
    throw new Error(`invalid GitHub repository: ${repository}`);
  if (owner.toLowerCase() !== accountLogin.toLowerCase()) {
    throw new Error(
      `GitHub repository owner ${owner} does not match selected installation account ${accountLogin}`,
    );
  }
  return name;
}

function hasHttpStatus(error: unknown, status: number): boolean {
  if (error === null || typeof error !== "object") return false;
  return Reflect.get(error, "status") === status;
}
