import { createGitHubLifecycle } from "./lifecycle.js";
import { createHash } from "node:crypto";
import { GitHubProgressProvider } from "../../run-progress/github.js";
import type { RunProgressSettings } from "../../run-progress/settings.js";
import type { AuthServer } from "../../auth/server.js";
import { createGitHubAuth, repositoryNamesForAccount, type GitHubAuth } from "../../auth/github.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import type { Database, GitHubConnectionRecord, GitHubRepositorySnapshot } from "../../db/types.js";
import { logger } from "../../logger.js";
import type {
  GitHubAuthorityRegistration,
  ProviderConnectionRegistration,
  ProviderIntegrationRegistration,
  ProviderRegistration,
  TriggerProviderFactory,
} from "../registration.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  CONNECTIONS_RETURN_ROUTE,
  callbackConnectionAccess,
  cancelledConnectionResult,
  connectionAccess,
  connectionActionFailure,
  connectionCallbackFailure,
  connectionResult,
  manageConnectionAccess,
  newConnectionState,
  positiveInteger,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import {
  createGitHubReactionClient,
  createGitHubTriggerProvider,
  type GitHubReactionClient,
} from "../../triggers/github/provider.js";
import { organizationBillingUrl } from "../../triggers/failure-notice.js";
import { createWebhookSource } from "../../triggers/github/webhook.js";
import {
  createGitHubConnectionClient,
  type GitHubConnectionClient,
  type GitHubInstallationIdentity,
} from "./client.js";
import { PushPayloadSchema } from "../../auth/github-events.js";
import { synchronizeGitHubDefaultBranch } from "../../configuration/github-sync.js";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";
import { createGitHubConfigurationProvider } from "./configuration.js";
import type { ConnectionResolutionContext } from "../../config/connections.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import {
  createGitHubReplyExecutor,
  githubReplyAvailable,
  issueCommentPath,
  type GitHubCommentClient,
} from "../../triggers/github/reply.js";

export interface GitHubRegistrationConfiguration {
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  /** Absent when event triggers are not set up. Deliveries are then refused, not accepted blind. */
  webhookSecret?: string;
}

export interface CreateGitHubRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  configuration?: GitHubRegistrationConfiguration | null;
  appAuth?: GitHubAuth;
  connectionClient?: GitHubConnectionClient;
  reactionClient?: GitHubReactionClient;
  fetch?: typeof fetch;
  configurationProvider?: GitHubConfigurationProvider;
  configurationVersion?: number;
  runProgress?: RunProgressSettings;
}

interface GitHubConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  callbackOrigin: string;
  configurationVersion: number;
  configuration: GitHubRegistrationConfiguration;
}

interface ConfiguredGitHubRegistration {
  options: CreateGitHubRegistrationOptions;
  configuration: GitHubRegistrationConfiguration;
  publicBaseUrl: string;
  database: Database;
}

export function createGitHubRegistration(
  options: CreateGitHubRegistrationOptions,
): ProviderRegistration {
  const configuration = options.configuration ?? null;
  const publicBaseUrl = options.publicBaseUrl;
  if (configuration === null || publicBaseUrl === undefined) {
    return emptyGitHubRegistration(options);
  }
  if (options.database === null) {
    return databaseUnavailableGitHubRegistration(configuration);
  }
  const database = options.database;
  const registration = { options, configuration, publicBaseUrl, database };
  let configurationForProject: ((projectId: string) => ProjectConfigurationStore) | undefined;

  const { appAuth, client, githubConfiguration } = createGitHubClients(
    options,
    configuration,
    publicBaseUrl,
  );
  const lifecycle = createGitHubLifecycle(database, client, githubConfiguration, {
    providerApplicationId: configuration.appId,
    configurationVersion: options.configurationVersion ?? 0,
  });
  const connection = createConfiguredGitHubConnection(registration, {
    client,
    repositories: githubConfiguration,
  });
  const webhook = createGitHubWebhook(
    { database, options, configuration, githubConfiguration },
    (delivery) => lifecycle.accept(delivery),
    (projectId) => {
      if (configurationForProject === undefined) {
        throw new Error("GitHub configuration store is not initialized");
      }
      return configurationForProject(projectId);
    },
  );
  const reactions = options.reactionClient ?? createGitHubReactionClient(appAuth);
  const comments = createGitHubCommentClient(appAuth, configuration.appSlug);
  logger.info("using webhook event source");
  return assembleGitHubRegistration(registration, {
    appAuth,
    connection,
    webhook,
    lifecycle,
    comments,
    triggerProvider: ({ configurationStoreForProject }) => {
      configurationForProject = configurationStoreForProject;
      return createGitHubTriggerProvider({
        configurationStoreForProject,
        reactions,
        comments,
        billingUrlForOrganization: (organizationId) =>
          organizationBillingUrl(database, publicBaseUrl, organizationId),
      });
    },
  });
}

function assembleGitHubRegistration(
  registration: ConfiguredGitHubRegistration,
  services: {
    appAuth: GitHubAuth;
    connection: ProviderConnectionRegistration;
    webhook: ReturnType<typeof createWebhookSource>;
    lifecycle: ReturnType<typeof createGitHubLifecycle>;
    comments: GitHubCommentClient;
    triggerProvider: TriggerProviderFactory;
  },
): ProviderRegistration {
  const { options, configuration, publicBaseUrl, database } = registration;
  const { appAuth, connection, webhook, lifecycle, comments, triggerProvider } = services;
  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: publicBaseUrl,
    },
    connection,
    ...(options.runProgress?.progressMessagesEnabled !== true
      ? {}
      : {
          progressProvider: createGitHubProgress(
            { database, settings: options.runProgress, fetch: options.fetch },
            configuration,
            appAuth,
          ),
        }),
    integration: createGitHubIntegration(database, appAuth, configuration),
    triggerProviders: [triggerProvider],
    sources: [
      {
        async start(handler) {
          await webhook.start(handler);
          lifecycle.start();
        },
        async stop() {
          await webhook.stop();
          await lifecycle.stop();
        },
      },
    ],
    outputs: [
      {
        type: "github.reply",
        tool: replyOutputTool,
        available: githubReplyAvailable,
        execute: createGitHubReplyExecutor({ client: comments }),
      },
    ],
    requests: [{ name: "webhook", handle: (request) => webhook.handle(request) }],
  };
}

function createGitHubClients(
  options: CreateGitHubRegistrationOptions,
  configuration: GitHubRegistrationConfiguration,
  publicBaseUrl: string,
) {
  const appAuth =
    options.appAuth ??
    createGitHubAuth({
      appId: configuration.appId,
      privateKey: configuration.privateKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const client =
    options.connectionClient ??
    createGitHubConnectionClient({
      publicBaseUrl,
      appSlug: configuration.appSlug,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      appAuth,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const githubConfiguration =
    options.configurationProvider ?? createGitHubConfigurationProvider(appAuth);
  return { appAuth, client, githubConfiguration };
}

function createConfiguredGitHubConnection(
  input: ConfiguredGitHubRegistration,
  services: GitHubConnectionServices,
): ProviderConnectionRegistration {
  const { database, options, configuration, publicBaseUrl } = input;
  return options.auth === null
    ? githubConnectionStatus(true)
    : createGitHubConnection(
        {
          database,
          auth: options.auth,
          applicationBaseUrl: options.applicationBaseUrl,
          callbackOrigin: publicBaseUrl,
          configurationVersion: options.configurationVersion ?? 0,
          configuration,
        },
        services,
      );
}

function createGitHubWebhook(
  registration: {
    database: Database;
    options: CreateGitHubRegistrationOptions;
    configuration: GitHubRegistrationConfiguration;
    githubConfiguration: GitHubConfigurationProvider;
  },
  acceptLifecycle: Parameters<typeof createWebhookSource>[1]["applyLifecycle"],
  configurationForProject: (projectId: string) => ProjectConfigurationStore,
) {
  const { database, options, configuration, githubConfiguration } = registration;
  return createWebhookSource(configuration.webhookSecret, {
    accept: (input) =>
      database.acceptGitHubEvent({
        ...input,
        providerApplicationId: configuration.appId,
        providerConfigurationVersion: options.configurationVersion ?? 0,
      }),
    applyLifecycle: acceptLifecycle,
    async synchronizePush(input) {
      const payload = PushPayloadSchema.safeParse(input.payload);
      if (!payload.success) return;
      const incomingConnection = await database.findGitHubConnection(input.installationId);
      if (incomingConnection === undefined) return;
      const targets = await database.listGitHubConfigurationTargets(
        incomingConnection.organizationId,
        incomingConnection.id,
        input.repositoryId,
      );
      await Promise.all(
        targets
          .filter((target) => payload.data.ref === `refs/heads/${target.defaultBranch}`)
          .map((target) =>
            synchronizeGitHubDefaultBranch({
              database,
              client: githubConfiguration,
              projectId: target.projectId,
              repositoryId: input.repositoryId,
              expectedCommitSha: payload.data.after,
              webhookDeliveryId: input.deliveryId,
              configurationForProject,
            }),
          ),
      );
    },
  });
}

const MARKER_SCAN_PAGE_SIZE = 100;
const MARKER_SCAN_MAX_PAGES = 3;

// Pages are requested by number through the same client, never by following a Link header.
async function scanForNoticeMarker(
  appAuth: GitHubAuth,
  appSlug: string,
  input: Parameters<GitHubCommentClient["findIssueCommentByMarker"]>[0],
): Promise<number | undefined> {
  const { installationId, owner, repo, issueNumber, marker, since } = input;
  const octokit = await appAuth.createInstallationOctokit(installationId);
  let botId: number | undefined;
  for (let page = 1; page <= MARKER_SCAN_MAX_PAGES; page += 1) {
    const { data: comments } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: issueNumber,
        ...(since === undefined ? {} : { since }),
        per_page: MARKER_SCAN_PAGE_SIZE,
        page,
        request: { retries: 0 },
      },
    );
    botId ??= await appBotId(appAuth, appSlug, installationId);
    const found = comments.find(
      (comment) =>
        comment.user?.id === botId &&
        comment.body?.split(/\r\n?|\n/u).some((line) => line.trim() === marker),
    );
    if (found !== undefined) return found.id;
    if (comments.length < MARKER_SCAN_PAGE_SIZE) return undefined;
  }
  return undefined;
}

async function appBotId(
  appAuth: GitHubAuth,
  appSlug: string,
  installationId: number,
): Promise<number> {
  const token = await appAuth.getInstallationToken(installationId);
  return (await appAuth.getAppBotIdentity(appSlug, token)).id;
}

function createGitHubCommentClient(appAuth: GitHubAuth, appSlug: string): GitHubCommentClient {
  return {
    findIssueCommentByMarker: (input) => scanForNoticeMarker(appAuth, appSlug, input),
    async createIssueComment({ installationId, owner, repo, issueNumber, body }) {
      const octokit = await appAuth.createInstallationOctokit(installationId);
      const response = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo, issue_number: issueNumber, body },
      );
      return { id: response.data.id };
    },
    async updateIssueComment({ installationId, owner, repo, commentId, body }) {
      const octokit = await appAuth.createInstallationOctokit(installationId);
      await octokit.request(`PATCH ${issueCommentPath(owner, repo, commentId)}`, { body });
    },
  };
}

function createGitHubProgress(
  input: { database: Database; settings: RunProgressSettings; fetch: typeof fetch | undefined },
  configuration: GitHubRegistrationConfiguration,
  appAuth: GitHubAuth,
): GitHubProgressProvider {
  return new GitHubProgressProvider({
    database: input.database,
    settings: input.settings,
    app: {
      id: configuration.appId,
      slug: configuration.appSlug,
      privateKey: configuration.privateKey,
      auth: appAuth,
    },
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
}

function createGitHubIntegration(
  database: Database,
  appAuth: GitHubAuth,
  configuration: GitHubRegistrationConfiguration,
): ProviderIntegrationRegistration {
  return {
    async resolve(projectId, connectionSlug, value, context?: ConnectionResolutionContext) {
      if (value !== "token") {
        throw new Error(`unsupported github integration value: ${value}`);
      }
      const project = await database.findProjectById(projectId);
      const selectedConnection =
        project === undefined
          ? undefined
          : (await database.organizationConnectionUsage(project.organizationId)).github.find(
              (candidate) =>
                candidate.organizationId === project.organizationId &&
                candidate.slug === connectionSlug,
            );
      if (selectedConnection === undefined || selectedConnection.status !== "active") {
        throw new Error(`github connection is unavailable: ${connectionSlug}`);
      }
      const token = await appAuth.mintInstallationToken(selectedConnection.installationId);
      await context?.registerToken?.({
        provider: "github",
        token: token.token,
        expiresAt: token.expiresAt,
      });
      return token.token;
    },
    githubAuthority: createGitHubAuthority(database, appAuth, configuration),
  };
}

function createGitHubAuthority(
  database: Database,
  appAuth: GitHubAuth,
  configuration: GitHubRegistrationConfiguration,
): GitHubAuthorityRegistration {
  return {
    async mint(input) {
      const project = await database.findProjectById(input.projectId);
      const selectedConnection =
        project === undefined
          ? undefined
          : (await database.organizationConnectionUsage(project.organizationId)).github.find(
              (candidate) =>
                candidate.organizationId === project.organizationId &&
                candidate.slug === input.connectionSlug,
            );
      if (selectedConnection === undefined || selectedConnection.status !== "active") {
        throw new Error(`github connection is unavailable: ${input.connectionSlug}`);
      }
      repositoryNamesForAccount(input.repositories, selectedConnection.accountLogin);
      const token = await appAuth.mintInstallationAccessToken({
        installationId: selectedConnection.installationId,
        accountLogin: selectedConnection.accountLogin,
        repositories: input.repositories,
        permissions: input.permissions,
      });
      try {
        const bot = await appAuth.getAppBotIdentity(configuration.appSlug, token.token);
        return {
          token: token.token,
          expiresAt: token.expiresAt,
          botUserId: bot.id,
          botLogin: bot.login,
        };
      } catch (error) {
        try {
          await appAuth.revokeInstallationToken(token.token);
        } catch {
          // Revocation logs its own failure. Keep the identity error for the caller.
        }
        throw error;
      }
    },
    revoke: (token) => appAuth.revokeInstallationToken(token),
  };
}

function emptyGitHubRegistration(
  options: Pick<CreateGitHubRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const { database, auth } = options;
  const connection =
    database === null || auth === null
      ? githubConnectionStatus(false)
      : createGitHubConnection(
          {
            database,
            auth,
            applicationBaseUrl: options.applicationBaseUrl,
            callbackOrigin: options.applicationBaseUrl,
            configurationVersion: 0,
            configuration: {
              appId: "unconfigured",
              appSlug: "unconfigured",
              clientId: "unconfigured",
              clientSecret: "unconfigured",
              privateKey: "unconfigured",
            },
          },
          undefined,
        );
  return {
    connection,
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function databaseUnavailableGitHubRegistration(
  configuration: GitHubRegistrationConfiguration,
): ProviderRegistration {
  const unavailable = () => Promise.reject(new DatabaseUnavailableError());
  const webhook = createWebhookSource(configuration.webhookSecret, {
    accept: unavailable,
    applyLifecycle: unavailable,
  });
  return {
    connection: githubConnectionStatus(true),
    triggerProviders: [],
    sources: [webhook],
    outputs: [],
    requests: [{ name: "webhook", handle: (request) => webhook.handle(request) }],
  };
}

function githubConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "github",
    status: (connections) => githubStatus(configured, connections.github),
    actions: {},
  };
}

interface GitHubConnectionServices {
  client: GitHubConnectionClient;
  repositories: Pick<GitHubConfigurationProvider, "listInstallationRepositories">;
}

function createGitHubConnection(
  options: GitHubConnectionOptions,
  services: GitHubConnectionServices | undefined,
): ProviderConnectionRegistration {
  const client = services?.client;
  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      if (client === undefined) {
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      }
      const state = newConnectionState();
      await options.database.startConnectionAttempt({
        provider: "github",
        stateVerifier: stateHash(state),
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
        callbackOrigin: options.callbackOrigin,
        configurationVersion: options.configurationVersion,
        providerApplicationId: options.configuration.appId,
        configurationSnapshot: { provider: "github", ...options.configuration },
        expectedConfigurationVersion: null,
        activateConfiguration: false,
      });
      return Response.json({ url: client.setupUrl(state) });
    } catch (error) {
      return connectionActionFailure(error, "github", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      await options.database.disconnectConnection(
        "github",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "github", "disconnect");
    }
  };

  return {
    name: "github",
    status: (connections) => githubStatus(client !== undefined, connections.github),
    actions: {
      start,
      disconnect,
      setup: (request) => completeSetup(options, client, request),
      callback: (request) => completeAuthorization(options, services, request),
    },
  };
}

async function completeSetup(
  options: GitHubConnectionOptions,
  client: GitHubConnectionClient | undefined,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const installationId = positiveInteger(url.searchParams.get("installation_id"));
  const action = url.searchParams.get("setup_action");
  let returnRoute: string = CONNECTIONS_RETURN_ROUTE;
  let callbackOrigin = options.applicationBaseUrl;
  const fail = (error: unknown) =>
    connectionCallbackFailure({
      request,
      error,
      provider: "github",
      phase: "setup",
      applicationBaseUrl: callbackOrigin,
      returnRoute,
    });
  if (state === null || client === undefined)
    return fail(new GitHubCallbackError("invalid setup callback"));
  try {
    const access = await callbackConnectionAccess(options.auth, request);
    const attempt = await options.database.readConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "github_setup",
      access,
    });
    returnRoute = attempt.returnRoute;
    callbackOrigin = attempt.callbackOrigin;
    if (action === "request") {
      await options.database.consumeConnectionAttempt({
        stateVerifier: stateHash(state),
        phase: "github_setup",
        access,
      });
      return connectionResult(
        callbackOrigin,
        attempt.returnRoute,
        "github_approval_required",
        "github",
      );
    }
    if ((action !== "install" && action !== "update") || installationId === undefined) {
      return fail(new GitHubCallbackError("invalid setup result"));
    }
    return await advanceGitHubSetup(options.database, client, { state, access, installationId });
  } catch (error) {
    return fail(error);
  }
}

async function advanceGitHubSetup(
  database: Database,
  client: GitHubConnectionClient,
  input: {
    state: string;
    access: Awaited<ReturnType<typeof callbackConnectionAccess>>;
    installationId: number;
  },
): Promise<Response> {
  const { state, access, installationId } = input;
  const nextState = newConnectionState();
  const verifier = newConnectionState();
  await database.advanceGitHubConnectionAttempt({
    stateVerifier: stateHash(state),
    phase: "github_setup",
    access,
    nextStateVerifier: stateHash(nextState),
    installationId,
    pkceVerifier: verifier,
  });
  return Response.redirect(
    client.authorizationUrl({
      state: nextState,
      challenge: pkceChallenge(verifier),
    }),
    303,
  );
}

async function completeAuthorization(
  options: GitHubConnectionOptions,
  services: GitHubConnectionServices | undefined,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state !== null && code === null && url.searchParams.get("error") === "access_denied") {
    return cancelledConnectionResult({
      auth: options.auth,
      database: options.database,
      request,
      provider: "github",
      phase: "github_user_authorization",
      state,
      applicationBaseUrl: options.applicationBaseUrl,
    });
  }
  let returnRoute: string = CONNECTIONS_RETURN_ROUTE;
  let callbackOrigin = options.applicationBaseUrl;
  const fail = (error: unknown) =>
    connectionCallbackFailure({
      request,
      error,
      provider: "github",
      phase: "authorization",
      applicationBaseUrl: callbackOrigin,
      returnRoute,
    });
  if (state === null || code === null || services === undefined) {
    return fail(new GitHubCallbackError("invalid authorization callback"));
  }
  try {
    const access = await callbackConnectionAccess(options.auth, request);
    const attempt = await options.database.readConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "github_user_authorization",
      access,
    });
    returnRoute = attempt.returnRoute;
    callbackOrigin = attempt.callbackOrigin;
    const installationId = positiveInteger(attempt.candidateExternalId);
    if (installationId === undefined || attempt.pkceVerifier === null)
      throw new Error("invalid attempt");
    const verifier = attempt.pkceVerifier;
    await verifyAndBindGitHubInstallation(options, services, {
      code,
      verifier,
      installationId,
      state,
      access,
    });
    return connectionResult(callbackOrigin, attempt.returnRoute, "github_connected", "github");
  } catch (error) {
    return fail(error);
  }
}

function verifyAndBindGitHubInstallation(
  options: GitHubConnectionOptions,
  services: GitHubConnectionServices,
  input: {
    code: string;
    verifier: string;
    installationId: number;
    state: string;
    access: Awaited<ReturnType<typeof callbackConnectionAccess>>;
  },
): Promise<void> {
  const { code, verifier, installationId, state, access } = input;
  return options.database.synchronizeGitHubInstallation(installationId, async () => {
    const identity = await services.client.verifyUserInstallation({
      code,
      verifier,
      installationId,
    });
    if (identity === undefined) {
      await options.database.consumeConnectionAttempt({
        stateVerifier: stateHash(state),
        phase: "github_user_authorization",
        access,
      });
      throw new GitHubCallbackError("installation verification rejected");
    }
    const repositories =
      identity.status === "suspended"
        ? []
        : await services.repositories.listInstallationRepositories({ installationId });
    await bindGitHub({
      database: options.database,
      state,
      access,
      identity,
      providerApplicationId: options.configuration.appId,
      repositories,
    });
  });
}

class GitHubCallbackError extends Error {
  readonly code = "invalidInput";
}

async function bindGitHub(input: {
  database: Database;
  state: string;
  access: Awaited<ReturnType<typeof callbackConnectionAccess>>;
  identity: GitHubInstallationIdentity;
  providerApplicationId: string;
  repositories: GitHubRepositorySnapshot;
}): Promise<void> {
  const { database, state, access, identity, providerApplicationId, repositories } = input;
  await database.bindGitHubConnection({
    providerApplicationId,
    repositories,
    stateVerifier: stateHash(state),
    phase: "github_user_authorization",
    access,
    ...identity,
  });
}

function githubStatus(configured: boolean, bindings: readonly GitHubConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  if (bindings.length === 0) return { status: "disconnected" as const };
  return bindings.every((binding) => binding.status === "suspended")
    ? { status: "suspended" as const }
    : { status: "connected" as const };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
