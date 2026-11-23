import { readUnsupportedLinearReceiptRate } from "./db/unsupported-linear.js";
import { readRunPayloadRetentionSettings } from "./run-payload-retention/settings.js";
import { randomBytes } from "node:crypto";
import { validateHeaderName, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import type { RuntimeConfig } from "./config/index.js";
import { createDatabase } from "./db/pg.js";
import { ReceiptRetention } from "./receipt-retention/index.js";
import type { Database } from "./db/types.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  readDatabasePoolOptions,
  type DatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "./db/runtime/index.js";
import type { Locks } from "./db/runtime/locks/index.js";
import { logger } from "./logger.js";
import { reportFailure } from "./failures/index.js";
import { installProcessFailureHandlers } from "./failures/process.js";
import { createFetchServer } from "./http/node-server.js";
import { loadBuiltStartServer } from "./server/build.js";
import { createAuthServer } from "./auth/server.js";
import {
  getApplication,
  hasApplication,
  startApplication,
  stopApplication,
  type ApplicationRuntime,
} from "./server/runtime.js";
import { createApplicationRuntime } from "./application-runtime.js";
import { readScriptLimits } from "./workflows/script-limits.js";
import {
  composeBilling,
  createStripeBillingClient,
  createStripeCatalogSource,
  readBillingConfig,
  type BillingRuntime,
} from "./billing/index.js";
import { composeEntitlements } from "./auth/entitlements.js";
import { readInstanceAuthPolicy } from "./auth/instance-policy.js";
import { createRuntimeConfiguration } from "./runtime-configuration/index.js";
import { CompositionResources } from "./composition-resources.js";
import {
  DynamicProviderRuntime,
  activateProviderApplicationsAtStartup,
  createProviderApplicationInventory,
  createProviderApplicationStore,
  createProviderApplications,
  createProviderApplicationVerifier,
  readProviderApplicationEnvironment,
  resolveCallbackOrigin,
} from "./provider-applications/index.js";
import { createSlackSocketInstallationVerifier } from "./providers/slack/installation.js";
import { resolveHubDataDirectory } from "./data-directory.js";
import { createInvitationMailer } from "./invitations/index.js";
import { composeEmailDelivery } from "./email/index.js";
import { createAccountMailer } from "./auth/account-emails.js";
import { migrateLegacyProjectTriggers } from "./triggers/migration.js";
import { readGitHubNotificationsOptions } from "./triggers/github-notifications/index.js";
import {
  readWebhookSigningSettings,
  type WebhookSigningSettings,
} from "./auth/webhook-signatures.js";
import { readWebhookOptions } from "./webhook-config.js";
import { readRunProgressSettings } from "./run-progress/settings.js";
import { readRunReplyLimit } from "./run-replies/settings.js";
import { readInteractiveSessionSettings } from "./interactive-sessions/settings.js";
import { linearPilotConfigFromEnv } from "./linear-pilot/config.js";
import { createLinearPilotRuntime } from "./linear-pilot/runtime.js";
import { readTimelineScrubValues } from "./run-timeline/secrets.js";
import {
  createServerShutdown,
  installShutdownSignals,
  readShutdownBudgets,
} from "./server-shutdown.js";

export function startProductionRuntime(): Promise<ApplicationRuntime> {
  return startApplication(createProductionRuntime);
}

export async function stopProductionRuntime(): Promise<void> {
  await stopApplication();
}

export async function beginProductionShutdown(): Promise<void> {
  if (!hasApplication()) return;
  const { runStream, interactiveSessions } = await getApplication();
  if (!interactiveSessions) return runStream.beginShutdown();
  await Promise.all([runStream.beginShutdown(), interactiveSessions.stream.beginShutdown()]);
}

export async function handleDaemonUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const runtime = await startProductionRuntime();
  if (runtime.hub.handleUpgrade === null) {
    socket.destroy();
    return;
  }
  await runtime.hub.handleUpgrade(request, socket, head);
}

async function createProductionRuntime(): Promise<ApplicationRuntime> {
  const resources = new CompositionResources();
  try {
    const { config, webhookSigning, pilotConfig, applicationSettings } = readProductionSettings();
    const databaseHandle = await createDatabaseHandle();
    const { database, runtime, locks } = databaseHandle;
    resources.own(() => database.close(), "composition.database");
    logTriggerMigration(await migrateLegacyProjectTriggers(database));
    const identity = await resolveHubIdentity(runtime, readPort());
    const access = composeProductionAccess(databaseHandle, resources);
    await syncStartupBillingCatalog(access.billing);
    const auth = createProductionAuthServer({
      ...access,
      database: runtime,
      locks,
      config,
      identity,
      webhookSigning,
    });
    resources.own(() => auth.close(), "composition.auth");
    await auth.initialize?.();
    const environment = await readProviderApplicationEnvironment(process.env);
    const providers = composeProductionProviders({
      databaseHandle,
      auth,
      identity,
      environment,
      pilotConfig,
      runProgress: applicationSettings.runProgress,
    });
    const scriptLimits = readScriptLimits(process.env);
    const githubNotifications = readStartupGitHubNotifications();
    const application = await createApplicationRuntime({
      database,
      databaseQuery: runtime,
      auth,
      entitlements: access.entitlements.service,
      billing: access.billing,
      registrations: providers.activation.runtime.registrations(),
      providerApplications: providers.applications,
      publicBaseUrl: identity.appUrl,
      completionTokenSecret: identity.authSecret,
      scriptLimits,
      ...applicationSettings,
      timelineScrubValues: providers.timelineScrubValues,
      ...(providers.linearPilot === undefined ? {} : { linearPilot: providers.linearPilot }),
      ...(githubNotifications === undefined ? {} : { githubNotifications }),
      close: () => resources.close(),
    });
    reportProviderActivationFailures(
      await activateProviderApplicationsAtStartup(providers.activation),
    );
    startReceiptRetention(runtime, resources);
    return application;
  } catch (error) {
    await resources.close();
    throw error;
  }
}

function readProductionSettings() {
  const config = loadRuntimeConfig();
  const webhookOptions = readWebhookOptions(process.env);
  const webhookSigning = readWebhookSigningSettings(process.env);
  const runProgress = readRunProgressSettings(process.env);
  const runReplyLimit = readRunReplyLimit(process.env);
  const interactiveSessions = readInteractiveSessionSettings(process.env);
  const pilotConfig = linearPilotConfigFromEnv(process.env);
  if (pilotConfig.status === "invalid")
    throw new Error(`PASEO_HUB_LINEAR_PILOT is invalid: ${pilotConfig.reason}`);
  if (pilotConfig.status === "enabled" && !interactiveSessions.enabled)
    throw new Error("PASEO_HUB_LINEAR_PILOT requires PASEO_HUB_INTERACTIVE_SESSIONS=true");
  const runPayloadRetention = readRunPayloadRetentionSettings(
    process.env,
    runProgress.retentionDays,
  );
  return {
    config,
    webhookSigning,
    pilotConfig,
    applicationSettings: {
      webhookOptions,
      runProgress,
      runReplyLimit,
      interactiveSessions,
      runPayloadRetention,
    },
  };
}

type ProductionDatabase = DatabaseRuntimeBundle & { database: Database };

function logTriggerMigration(
  migration: Awaited<ReturnType<typeof migrateLegacyProjectTriggers>>,
): void {
  if (migration.projects > 0) {
    logger.info(migration, "migrated project configurations to organization triggers");
  }
}

function composeProductionAccess(
  { database, runtime }: ProductionDatabase,
  resources: CompositionResources,
) {
  const entitlements = composeEntitlements(database, runtime);
  resources.own(() => entitlements.close(), "composition.entitlements");
  const billingConfig = readBillingConfig();
  const emailDelivery = composeEmailDelivery();
  const invitationMailer =
    emailDelivery === undefined ? undefined : createInvitationMailer(emailDelivery);
  const accountMailer =
    emailDelivery === undefined ? undefined : createAccountMailer(emailDelivery);
  const billing =
    billingConfig === undefined
      ? null
      : composeBilling({
          config: billingConfig,
          database,
          catalogSource: createStripeCatalogSource(billingConfig.stripeSecretKey),
          billingClient: createStripeBillingClient(billingConfig.stripeSecretKey),
          seatUsage: entitlements.seatUsage,
        });
  return { entitlements, billing, invitationMailer, accountMailer };
}

function syncStartupBillingCatalog(billing: BillingRuntime | null) {
  // A Stripe outage can leave the catalog stale but must not block startup.
  return billing?.syncCatalog().catch((error: unknown) => {
    reportFailure(error, {
      operation: "billing.catalog.sync.startup",
      component: "billing",
      provider: "stripe",
    });
  });
}

function createProductionAuthServer(
  options: ReturnType<typeof composeProductionAccess> & {
    database: DatabaseRuntime;
    locks: Locks;
    config: RuntimeConfig;
    identity: HubIdentity;
    webhookSigning: WebhookSigningSettings;
  },
) {
  const {
    entitlements,
    database,
    locks,
    config,
    identity,
    billing,
    invitationMailer,
    accountMailer,
    webhookSigning,
  } = options;
  const { authPolicy, trustedClientIpHeader } = config;
  return createAuthServer({
    database,
    webhookSigning,
    locks,
    entitlements: entitlements.service,
    secret: identity.authSecret,
    baseURL: identity.appUrl,
    policy: authPolicy,
    ...(trustedClientIpHeader === undefined ? {} : { trustedClientIpHeader }),
    ...(invitationMailer === undefined ? {} : { invitationMailer }),
    ...(accountMailer === undefined ? {} : { accountMailer }),
    // Hosted: new organizations are stamped with the Free plan and stay on it until someone buys
    // a plan. Self-hosted keeps the unlimited default and never touches Stripe.
    ...(billing === null
      ? {}
      : {
          provisioningEntitlements: () => billing.provisioningEntitlement(),
          onMembershipChanged: (organizationId: string) => billing.reportSeatUsage(organizationId),
        }),
  });
}

type LinearPilotStatus = ReturnType<typeof readProductionSettings>["pilotConfig"];

interface ProductionProviderOptions {
  databaseHandle: ProductionDatabase;
  auth: ReturnType<typeof createProductionAuthServer>;
  identity: HubIdentity;
  environment: Awaited<ReturnType<typeof readProviderApplicationEnvironment>>;
  pilotConfig: LinearPilotStatus;
  runProgress: ReturnType<typeof readRunProgressSettings>;
}

function composeProductionProviders(options: ProductionProviderOptions) {
  const { auth, identity, environment, pilotConfig, runProgress } = options;
  const { database, runtime, locks } = options.databaseHandle;
  const timelineScrubValues = readTimelineScrubValues(process.env, Object.values(environment));
  const linearPilot = composeProductionLinearPilot(
    pilotConfig,
    options.databaseHandle,
    timelineScrubValues,
  );
  const store = createProviderApplicationStore(runtime, locks, database);
  const verifier = createProviderApplicationVerifier();
  const inventory = createProviderApplicationInventory(runtime);
  const providerRuntime = new DynamicProviderRuntime({
    database,
    auth,
    applicationBaseUrl: identity.appUrl,
    runProgress,
    ...(linearPilot === undefined ? {} : { linearPilot: linearPilot.registration }),
  });
  const applications = createProviderApplications({
    auth,
    store,
    environment,
    runtime: providerRuntime,
    verifier,
    slackSocketVerifier: createSlackSocketInstallationVerifier(),
    slackDelivery: {
      status: () => providerRuntime.slackDelivery()?.status() ?? { state: "stopped" },
      retry: () => providerRuntime.slackDelivery()?.retry() ?? Promise.resolve(),
    },
    inventory,
    callbackOrigin: (request) => resolveCallbackOrigin(request, identity.explicitAppUrl),
    beginCandidateConnection: async (request, organizationId, returnRoute, begin) => {
      const organizationSlug = await inventory.organizationSlug(organizationId);
      if (organizationSlug === undefined) throw new Error("organization unavailable");
      const url = new URL(request.url);
      url.searchParams.set("organizationSlug", organizationSlug);
      url.searchParams.set("returnRoute", returnRoute);
      return begin(new Request(url, { method: "POST", headers: request.headers }));
    },
  });
  return {
    applications,
    linearPilot,
    timelineScrubValues,
    activation: {
      store,
      environment,
      runtime: providerRuntime,
      verifier,
      inventory,
      callbackOrigin: identity.appUrl,
    },
  };
}

function composeProductionLinearPilot(
  pilotConfig: LinearPilotStatus,
  { database, runtime, locks }: ProductionDatabase,
  scrubValues: ReturnType<typeof readTimelineScrubValues>,
) {
  if (pilotConfig.status !== "enabled") return undefined;
  return createLinearPilotRuntime({
    config: pilotConfig.config,
    database,
    runtime,
    locks,
    scrubValues,
    reportFailure: (failure) => logger.warn(failure, "Linear pilot delivery failed"),
  });
}

function readStartupGitHubNotifications() {
  const githubNotifications = readGitHubNotificationsOptions(process.env);
  if (githubNotifications !== undefined) {
    logger.info(
      { pollIntervalSeconds: githubNotifications.pollIntervalMs / 1000 },
      "github notifications polling enabled",
    );
  }
  return githubNotifications;
}

function reportProviderActivationFailures(
  failures: Awaited<ReturnType<typeof activateProviderApplicationsAtStartup>>,
): void {
  for (const { provider, error } of failures) {
    reportFailure(error, {
      operation: "provider_application.activate_at_startup",
      component: "provider_applications",
      provider,
    });
  }
}

function startReceiptRetention(runtime: DatabaseRuntime, resources: CompositionResources): void {
  const receiptRetention = new ReceiptRetention(runtime);
  resources.own(() => receiptRetention.stop(), "composition.receipt_retention");
  receiptRetention.start();
}

async function createDatabaseHandle(): Promise<ProductionDatabase> {
  // Read before connecting so a bad value stops startup with its own message.
  const poolOptions = readDatabasePoolOptions(process.env);
  const unsupportedLinearReceiptsPerHour = readUnsupportedLinearReceiptRate(process.env);
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    return initializeDatabaseRuntime(
      () => postgresDatabaseRuntime(databaseUrl, poolOptions),
      "database runtime ready: postgres",
      unsupportedLinearReceiptsPerHour,
    );
  }

  const dataDirectory = resolveHubDataDirectory();
  return initializeDatabaseRuntime(
    () => embeddedDatabaseRuntime(dataDirectory),
    `database runtime ready: embedded (${dataDirectory})`,
    unsupportedLinearReceiptsPerHour,
  );
}

async function initializeDatabaseRuntime(
  createRuntime: () => Promise<DatabaseRuntimeBundle>,
  readyMessage: string,
  unsupportedLinearReceiptsPerHour: number,
): Promise<ProductionDatabase> {
  let bundle: DatabaseRuntimeBundle | undefined;
  try {
    bundle = await createRuntime();
    await bundle.runtime.migrate();
    logger.info(readyMessage);
    return {
      ...bundle,
      database: createDatabase(bundle.runtime, bundle.locks, unsupportedLinearReceiptsPerHour),
    };
  } catch (error) {
    if (bundle !== undefined) {
      try {
        await bundle.runtime.close();
      } catch (closeError) {
        reportFailure(closeError, {
          operation: "database.startup.cleanup",
          component: "database",
        });
      }
    }
    reportFailure(error, { operation: "database.startup", component: "database" });
    throw error;
  }
}

function loadRuntimeConfig(): RuntimeConfig {
  const trustedClientIpHeader = process.env["PASEO_HUB_TRUSTED_CLIENT_IP_HEADER"];
  if (trustedClientIpHeader !== undefined) validateHeaderName(trustedClientIpHeader);
  return {
    bind: process.env["PASEO_HUB_BIND"] ?? "0.0.0.0",
    ...(trustedClientIpHeader === undefined ? {} : { trustedClientIpHeader }),
    authPolicy: readInstanceAuthPolicy(process.env),
  };
}

interface HubIdentity {
  appUrl: string;
  authSecret: string;
  explicitAppUrl?: string;
}

async function resolveHubIdentity(
  database: DatabaseRuntime,
  effectivePort: number,
): Promise<HubIdentity> {
  const configuredAppUrl = nonEmptyEnvironment(process.env["PASEO_HUB_APP_URL"]);
  const configuredAuthSecret = process.env["PASEO_HUB_AUTH_SECRET"];
  const configuration = createRuntimeConfiguration({
    database,
    environment: {
      ...(configuredAppUrl === undefined ? {} : { appUrl: configuredAppUrl }),
      ...(configuredAuthSecret === undefined ? {} : { authSecret: configuredAuthSecret }),
    },
    effectivePort,
    randomBytes,
  });
  return {
    appUrl: await configuration.publicUrl(),
    authSecret: await configuration.authSecret(),
    ...(configuredAppUrl === undefined ? {} : { explicitAppUrl: configuredAppUrl }),
  };
}

function nonEmptyEnvironment(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

async function main(): Promise<void> {
  const shutdownBudgets = readShutdownBudgets(process.env);
  const removeProcessFailureHandlers = installProcessFailureHandlers();
  const build = await loadBuiltStartServer();
  await build.startProductionRuntime();
  const config = loadRuntimeConfig();
  const port = readPort();
  const canonicalRequestOrigin = nonEmptyEnvironment(process.env["PASEO_HUB_APP_URL"]);
  const server = createFetchServer((request) => build.default.fetch(request), {
    ...(config.trustedClientIpHeader === undefined
      ? {}
      : { trustedClientIpHeader: config.trustedClientIpHeader }),
    ...(canonicalRequestOrigin === undefined ? {} : { canonicalRequestOrigin }),
    handleUpgrade: (request, socket, head) => {
      void handleDaemonUpgradeRequest({
        request,
        socket,
        handle: () => build.handleDaemonUpgrade(request, socket, head),
      });
    },
  });
  const appUrl =
    nonEmptyEnvironment(process.env["PASEO_HUB_APP_URL"]) ?? `http://localhost:${port}`;
  server.listen(port, config.bind, () => {
    logger.info(`server started, available at: ${appUrl}`);
  });

  const stop = createServerShutdown(server, () => build.stopProductionRuntime(), {
    ...shutdownBudgets,
    beginShutdown: () => build.beginShutdown(),
    exit: (code) => process.exit(code),
  });
  installShutdownSignals(process, stop, removeProcessFailureHandlers);
}

export async function handleDaemonUpgradeRequest(options: {
  request: Pick<IncomingMessage, "method" | "url">;
  socket: Pick<Duplex, "destroy">;
  handle(): Promise<void>;
  logger?: Pick<Logger, "warn" | "error">;
}): Promise<void> {
  try {
    await options.handle();
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "daemon.upgrade",
        component: "daemons",
        ...(options.request.method === undefined ? {} : { method: options.request.method }),
        path: requestPath(options.request.url),
      },
      options.logger === undefined ? {} : { logger: options.logger },
    );
    options.socket.destroy();
  }
}

function requestPath(value: string | undefined): string {
  if (value === undefined) return "/";
  try {
    return new URL(value, "http://hub.invalid").pathname;
  } catch {
    return "/";
  }
}

function readPort(): number {
  const value = process.env["PORT"] ?? "3000";
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT value: ${value}`);
  return port;
}

export function runHubCommandLine(): void {
  main().catch((error: unknown) => {
    reportFailure(error, { operation: "server.startup.fatal", component: "server" });
    process.exit(1);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runHubCommandLine();
