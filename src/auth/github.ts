import jwt from "jsonwebtoken";
import { Octokit } from "octokit";
import { z } from "zod";
import { logger } from "../logger.js";
import { githubProgressFetch } from "./github-progress-fetch.js";
import { GITHUB_APP_PERMISSION_VOCABULARY } from "../config/github-authority.js";
import { GitHubInstallationSchema } from "./github-events.js";
import type { GitHubInstallation } from "./github-events.js";

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

  constructor(private readonly options: CreateGitHubAuthOptions) {
    this.now = options.now ?? Date.now;
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
    await octokit.request("DELETE /installation/token", {
      headers: githubApiVersionHeader(),
    });
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
      request: githubRequestOptions(this.options.fetch),
      ...pluginOverrides(this.options),
    });
    octokit.hook.before("request", refuseRetryOfCreateComment);
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
      { kind, retryAfterSeconds, method: request.method, url: request.url },
      "GitHub rate limit reached",
    );
    return false;
  };
}

const THROTTLE_POLICY = {
  onRateLimit: failFastOnRateLimit("primary"),
  onSecondaryRateLimit: failFastOnRateLimit("secondary"),
};

// A retried POST after a lost response would publish the comment twice.
function refuseRetryOfCreateComment(options: { method: string; url: string; request: object }) {
  if (`${options.method} ${options.url}` === CREATE_COMMENT_ROUTE) {
    Object.assign(options.request, { retries: 0 });
  }
}

const CREATE_COMMENT_ROUTE = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";

function pluginOverrides(options: CreateGitHubAuthOptions) {
  const plugins = options.octokitPlugins;
  return {
    retry: plugins?.retry === false ? { enabled: false } : RETRY_POLICY,
    throttle: plugins?.throttle === false ? { enabled: false } : THROTTLE_POLICY,
  };
}

function githubRequestOptions(fetchOverride: typeof fetch | undefined) {
  return fetchOverride === undefined ? {} : { fetch: fetchOverride };
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
