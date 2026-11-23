import { RunPayloadRetention } from "./run-payload-retention/index.js";
import {
  assertRunPayloadWindow,
  type RunPayloadRetentionSettings,
} from "./run-payload-retention/settings.js";
import { randomUUID } from "node:crypto";
import {
  createHubApplication,
  type HubApplication,
  type HubRuntime,
  type HubRuntimeOptions,
} from "./app.js";
import { logger, serializeError } from "./logger.js";
import { RunTimeline } from "./run-timeline/index.js";
import { RunTimelineReconciler } from "./run-timeline/reconcile.js";
import { RunTimelineBus } from "./run-timeline/bus.js";
import { createTimelineScrubber } from "./run-timeline/scrub.js";
import { createObservedDatabase } from "./run-timeline/observed-database.js";
import type { TimelineRunScope } from "./run-timeline/capture-types.js";
import type { GitHubNotificationsOptions } from "./triggers/github-notifications/index.js";
import type { AuthServer } from "./auth/server.js";
import type { BillingRuntime } from "./billing/index.js";
import type { ConnectionResolver } from "./config/connections.js";
import type { Database } from "./db/types.js";
import type { QueryHandle } from "./db/runtime/index.js";
import { withInteractiveSessionAccountFeature } from "./auth/organization-access.js";
import { resolveRouteTenant } from "./projects/access.js";
import { capabilitiesFor } from "./auth/organization-policy.js";
import type { DaemonDispatchLifecycleOptions } from "./daemons/lifecycle.js";
import type { EntitlementsService } from "./entitlements/service.js";
import { OperatorConsole } from "./operator/console.js";
import { UsageDashboard } from "./usage/dashboard.js";
import { OrganizationResources } from "./organizations/resources.js";
import { OutputExecutorRegistry } from "./execution-capabilities/outputs.js";
import type {
  ProviderConnectionRegistration,
  ProviderIntegrationRegistration,
  ProviderRegistration,
} from "./providers/registration.js";
import { createExecutionAuthority, type ExecutionAuthority } from "./execution-authority/index.js";
import {
  BillingForbiddenError,
  type ApplicationRuntime,
  type BillingCheckoutInput,
  type BillingOverviewView,
} from "./server/runtime.js";
import { ProjectDashboard } from "./projects/dashboard.js";
import { CompositionResources } from "./composition-resources.js";
import { TriggerDashboard } from "./triggers/dashboard.js";
import type { ProviderApplications } from "./provider-applications/index.js";
import { DaemonProviderCatalog } from "./daemons/provider-catalog.js";
import { HomeDashboard } from "./home/dashboard.js";
import type { ScriptLimits } from "./workflows/script-limits.js";
import { runShutdownStage } from "./shutdown-stage.js";
import type { TriggerSource } from "./triggers/index.js";
import type { WebhookOptions } from "./webhook-config.js";
import { GitHubProgressProvider } from "./run-progress/github.js";
import { readRunProgressSettings, type RunProgressSettings } from "./run-progress/settings.js";
import { ProgressReporter, type ProgressProvider } from "./run-progress/index.js";
import type { MessageScope } from "./run-progress/writer.js";
import { TimelineRetention } from "./run-timeline/retention.js";
import { RunStream } from "./run-stream/index.js";
import { reportFailure } from "./failures/index.js";
import { SessionEventBus } from "./interactive-sessions/bus.js";
import { InteractiveSessionCoordinator } from "./interactive-sessions/coordinator.js";
import {
  SessionMessageRetention,
  sessionMessageBodyCutoff,
} from "./interactive-sessions/retention.js";
import { InteractiveSessionService } from "./interactive-sessions/service.js";
import type { InteractiveSessionSettings } from "./interactive-sessions/settings.js";
import { InteractiveSessionStream } from "./interactive-sessions/stream.js";
import { RunReplyReporter } from "./run-replies/reporter.js";
import { readRunReplyLimit } from "./run-replies/settings.js";
import type { createLinearPilotRuntime } from "./linear-pilot/runtime.js";

export interface ApplicationCompositionOptions {
  database: Database | null;
  databaseQuery?: QueryHandle;
  auth: AuthServer | null;
  /** The composition root's single EntitlementsService; present whenever a database is. */
  entitlements: EntitlementsService | null;
  /** HOSTED only. Present when `readBillingConfig()` finds `STRIPE_SECRET_KEY`; null self-hosted. */
  billing: BillingRuntime | null;
  registrations?: readonly ProviderRegistration[];
  providerApplications?: ProviderApplications;
  publicBaseUrl?: string;
  completionTokenSecret?: string;
  testTriggerRoutes?: boolean;
  daemonConnectionForId?: DaemonDispatchLifecycleOptions["connectionForDaemon"];
  githubNotifications?: GitHubNotificationsOptions;
  scriptLimits?: ScriptLimits | undefined;
  webhookOptions?: WebhookOptions | undefined;
  runProgress?: RunProgressSettings;
  runReplyLimit?: number;
  interactiveSessions?: InteractiveSessionSettings;
  linearPilot?: ReturnType<typeof createLinearPilotRuntime>;
  runPayloadRetention?: RunPayloadRetentionSettings;
  progressProviders?: readonly ProgressProvider[];
  timelineScrubValues?: readonly string[];
  close(): Promise<void>;
}

export async function createApplicationRuntime(
  options: ApplicationCompositionOptions,
): Promise<ApplicationRuntime> {
  const resources = new CompositionResources();
  resources.own(() => options.close(), "composition.resources");
  try {
    return await createOwnedApplicationRuntime(options, resources);
  } catch (error) {
    await resources.close();
    throw error;
  }
}

async function createOwnedApplicationRuntime(
  options: ApplicationCompositionOptions,
  ownership: CompositionResources,
): Promise<ApplicationRuntime> {
  validateRunPayloadRetention(options);
  const timelineRuntime = createRunTimelineRuntime(options, ownership);
  const { runStream, hubOptions: streamOptions } = createRunStreamRuntime(
    options,
    timelineRuntime,
    ownership,
  );
  const registrations = options.registrations ?? [];
  const { connections, integrations } = collectProviderConnections(registrations);
  const connectionsForProject = createConnectionsForProject(options.database, integrations);
  const executionAuthority = createRuntimeExecutionAuthority(
    options.database,
    connectionsForProject,
    integrations,
  );
  const outputRegistry = createOutputRegistry(registrations);

  const progress = createProgressReporter(options, timelineRuntime.timelineBus, ownership);
  const replyOptions = createRunReplyReporter(options, ownership);
  const interactiveSessions = createInteractiveSessionsRuntime(options, (daemonId) =>
    application.hub.connectionForDaemon(daemonId),
  );
  const application: HubApplication = createHubApplication({
    ...progress.hubOptions,
    ...replyOptions,
    ...timelineRuntime,
    ...streamOptions,
    ...interactiveSessions?.hubOptions,
    entitlements: options.entitlements,
    ...hubProviderOptions(registrations, executionAuthority),
    connectionsForProject,
    ...hubApplicationSettings(options, outputRegistry),
  });
  ownership.own(() => application.hub.stop(), "composition.hub");
  interactiveSessions?.ownStream(ownership);
  progress.start();
  await application.hub.start(registrations.flatMap(triggerSourcesFor));

  startRunPayloadRetention(options, ownership);
  interactiveSessions?.startRetention(ownership);

  return createApplicationSurface({
    options,
    ownership,
    application,
    timelineRuntime,
    runStream,
    interactiveSessions,
    registrations,
    connections,
  });
}

function createOutputRegistry(
  registrations: readonly ProviderRegistration[],
): OutputExecutorRegistry {
  const outputRegistry = new OutputExecutorRegistry();
  for (const output of registrations.flatMap((registration) => registration.outputs)) {
    outputRegistry.register(output);
  }
  return outputRegistry;
}

function hubProviderOptions(
  registrations: readonly ProviderRegistration[],
  executionAuthority: ExecutionAuthority | undefined,
): Pick<HubRuntimeOptions, "providerFactories" | "executionAuthority" | "attachmentResolvers"> {
  return {
    providerFactories: registrations.flatMap((registration) => registration.triggerProviders),
    ...(executionAuthority === undefined ? {} : { executionAuthority }),
    attachmentResolvers: Object.fromEntries(
      registrations.flatMap((registration) =>
        registration.attachment === undefined
          ? []
          : [[registration.attachment.provider, registration.attachment.resolve] as const],
      ),
    ),
  };
}

function hubApplicationSettings(
  options: ApplicationCompositionOptions,
  outputRegistry: OutputExecutorRegistry,
) {
  return {
    ...(options.auth === null ? {} : { browserOrganizationAccess: options.auth }),
    publicApi:
      options.auth?.publicCredentials === undefined
        ? { status: "unavailable" as const }
        : {
            status: "enabled" as const,
            authenticator: options.auth.publicCredentials,
            webhookKeys: options.auth.apiKeys,
          },
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    ...(options.completionTokenSecret === undefined
      ? {}
      : { completionTokenSecret: options.completionTokenSecret }),
    outputRegistry,
    ...(options.daemonConnectionForId === undefined
      ? {}
      : { daemonConnectionForId: options.daemonConnectionForId }),
    ...(options.githubNotifications === undefined
      ? {}
      : { githubNotifications: options.githubNotifications }),
    scriptLimits: options.scriptLimits,
    webhookOptions: options.webhookOptions,
  };
}

function triggerSourcesFor(registration: ProviderRegistration): TriggerSource[] {
  return registration.sources.map((source, index) => ({
    start: (handler) => source.start(handler),
    stop: () =>
      runShutdownStage(`trigger.provider.${registration.connection.name}.${index}`, () =>
        source.stop(),
      ),
  }));
}

interface ApplicationSurfaceOptions {
  options: ApplicationCompositionOptions;
  ownership: CompositionResources;
  application: HubApplication;
  timelineRuntime: ReturnType<typeof createRunTimelineRuntime>;
  runStream: RunStream;
  interactiveSessions: ReturnType<typeof createInteractiveSessionsRuntime>;
  registrations: readonly ProviderRegistration[];
  connections: ReadonlyMap<string, ProviderConnectionRegistration>;
}

function createApplicationSurface(input: ApplicationSurfaceOptions): ApplicationRuntime {
  const { options, ownership, application, timelineRuntime } = input;
  const { runStream, interactiveSessions, registrations, connections } = input;
  const resources = options.database === null ? null : new OrganizationResources(options.database);
  const requests = collectProviderRequests(registrations);
  return {
    hub: application.hub,
    operations: application.operations,
    publicApi: application.publicApi,
    runStream,
    interactiveSessions: interactiveSessions?.browser ?? null,
    publicBaseUrl: options.publicBaseUrl,
    resources,
    billing: options.billing,
    providerApplications: providerApplicationsFor(options),
    projectDashboard:
      options.database === null || options.auth === null
        ? null
        : new ProjectDashboard(options.database, options.auth),
    triggerDashboard: triggerDashboardFor(
      options,
      application.hub,
      timelineRuntime.runTimelineReconciler,
    ),
    daemonProviderCatalog: daemonProviderCatalogFor(options, application.hub),
    homeDashboard: homeDashboardFor(options, connections),
    ...entitlementSurfaces(options),
    testTriggerRoutes: options.testTriggerRoutes ?? false,
    auth: (request) => {
      if (options.database === null) {
        return Promise.resolve(Response.json({ error: "database_unavailable" }, { status: 503 }));
      }
      return options.auth === null
        ? Promise.resolve(Response.json({ error: "auth_unavailable" }, { status: 503 }))
        : options.auth.handle(request);
    },
    browserAccount: (request) => browserAccount(options, request, interactiveSessions !== null),
    ...emailAuthHandlers(options),
    ...accountAuthHandlers(options, resources),
    ...connectionHandlers(options, connections),
    webhook: (request) =>
      requests.get("webhook")?.(request) ??
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ...billingReadHandlers(options),
    ...billingManagementHandlers(options),
    providerRequest: (name, request) =>
      requests.get(name)?.(request) ?? Promise.resolve(new Response("Not Found", { status: 404 })),
    stop: () => ownership.close(),
  };
}

function emailAuthHandlers(
  options: ApplicationCompositionOptions,
): Pick<
  ApplicationRuntime,
  "signInEmail" | "signUpEmail" | "sendVerificationEmail" | "requestPasswordReset" | "resetPassword"
> {
  return {
    signInEmail(data, headers) {
      if (options.database === null || options.auth?.signInEmail === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.signInEmail(data, headers);
    },
    signUpEmail(data, headers, invitationId) {
      if (options.database === null || options.auth?.signUpEmail === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.signUpEmail(data, headers, invitationId);
    },
    sendVerificationEmail(email, headers, invitationId) {
      if (options.database === null || options.auth?.sendVerificationEmail === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.sendVerificationEmail(email, headers, invitationId);
    },
    requestPasswordReset(email, headers) {
      if (options.database === null || options.auth?.requestPasswordReset === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.requestPasswordReset(email, headers);
    },
    resetPassword(data, headers) {
      if (options.database === null || options.auth?.resetPassword === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.resetPassword(data, headers);
    },
  };
}

function accountAuthHandlers(
  options: ApplicationCompositionOptions,
  resources: OrganizationResources | null,
): Pick<
  ApplicationRuntime,
  "claimInstance" | "completeAppOnboarding" | "signOut" | "changePassword" | "organizationResources"
> {
  return {
    claimInstance(operator, headers) {
      if (options.database === null || options.auth?.claimInstance === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.claimInstance(operator, headers);
    },
    completeAppOnboarding(request) {
      if (options.database === null || options.auth?.completeAppOnboarding === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.completeAppOnboarding(request);
    },
    signOut(headers) {
      if (options.database === null || options.auth?.signOut === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.signOut(headers);
    },
    changePassword(data, headers) {
      if (options.database === null || options.auth?.changePassword === undefined) {
        return Promise.reject(new Error("auth unavailable"));
      }
      return options.auth.changePassword(data, headers);
    },
    organizationResources(request) {
      if (resources === null || options.auth === null) {
        return Promise.reject(new Error("organization resources are unavailable"));
      }
      return options.auth.resources(request, resources);
    },
  };
}

function connectionHandlers(
  options: ApplicationCompositionOptions,
  connections: ReadonlyMap<string, ProviderConnectionRegistration>,
): Pick<ApplicationRuntime, "connectionStatus" | "connectionAction"> {
  return {
    connectionStatus: async (request) => {
      if (options.database === null || options.auth === null) {
        return Response.json({ error: "database_unavailable" }, { status: 503 });
      }
      const url = new URL(request.url);
      const organizationSlug = url.searchParams.get("organizationSlug");
      if (organizationSlug === null) {
        return Response.json({ error: "organization_required" }, { status: 400 });
      }
      const { tenant } = await resolveRouteTenant(options.auth, options.database, request, {
        organizationSlug,
      });
      const bindings = await options.database.organizationConnectionUsage(tenant.organization.id);
      const statuses = Object.fromEntries(
        [...connections.values()].map((connection) => [
          connection.name,
          connection.status(bindings),
        ]),
      );
      return Response.json({
        canManage: tenant.membership.role !== "member",
        ...statuses,
      });
    },
    connectionAction: (request, provider, action) => {
      if (options.database === null || options.auth === null) {
        return Promise.resolve(Response.json({ error: "database_unavailable" }, { status: 503 }));
      }
      return (
        connections.get(provider)?.actions[action]?.(request) ??
        Promise.resolve(Response.json({ error: "provider_not_configured" }, { status: 409 }))
      );
    },
  };
}

function billingReadHandlers(
  options: ApplicationCompositionOptions,
): Pick<
  ApplicationRuntime,
  "billingWebhook" | "billingPlans" | "billingConfigured" | "billingOverview"
> {
  return {
    billingWebhook: (request) =>
      options.billing === null
        ? Promise.resolve(new Response("Not Found", { status: 404 }))
        : options.billing.handleWebhook(request),
    billingPlans: async () => {
      // Unconfigured means self-hosted: the billing routes are not registered, so the public
      // catalog endpoint does not exist rather than serving an empty list. Null tells the route
      // to answer 404 — see the plan's "no config means billing routes are never registered".
      if (options.billing === null || options.database === null) return null;
      return options.billing.publicCatalog();
    },
    billingConfigured: () => options.billing !== null,
    billingOverview: async (request, organizationSlug): Promise<BillingOverviewView> => {
      const { billing, database } = requireBilling(options);
      const { tenant } = await resolveRouteTenant(requireAuth(options), database, request, {
        organizationSlug,
      });
      const [subscription, plans] = await Promise.all([
        billing.subscriptionSnapshot(tenant.organization.id),
        billing.publicCatalog(),
      ]);
      return {
        organization: {
          name: tenant.organization.name,
          slug: tenant.organization.slug ?? organizationSlug,
        },
        canManage: capabilitiesFor(tenant.membership.role).manageResources,
        subscription,
        plans,
      };
    },
  };
}

function billingManagementHandlers(
  options: ApplicationCompositionOptions,
): Pick<ApplicationRuntime, "billingCheckout" | "billingPortal"> {
  return {
    billingCheckout: async (request, input: BillingCheckoutInput) => {
      const { billing, database } = requireBilling(options);
      const { account, tenant } = await resolveRouteTenant(
        requireAuth(options),
        database,
        request,
        {
          organizationSlug: input.organizationSlug,
        },
      );
      if (!capabilitiesFor(tenant.membership.role).manageResources) {
        throw new BillingForbiddenError();
      }
      const billingUrl = billingReturnUrl(
        options,
        request,
        tenant.organization.slug,
        input.organizationSlug,
      );
      return billing.createCheckout({
        organizationId: tenant.organization.id,
        planSlug: input.planSlug,
        interval: input.interval,
        successUrl: billingUrl,
        cancelUrl: billingUrl,
        accountEmail: account.account.email,
        accountName: account.account.name,
      });
    },
    billingPortal: async (request, organizationSlug) => {
      const { billing, database } = requireBilling(options);
      const { tenant } = await resolveRouteTenant(requireAuth(options), database, request, {
        organizationSlug,
      });
      if (!capabilitiesFor(tenant.membership.role).manageResources) {
        throw new BillingForbiddenError();
      }
      const returnUrl = billingReturnUrl(
        options,
        request,
        tenant.organization.slug,
        organizationSlug,
      );
      const portal = await billing.createPortal({
        organizationId: tenant.organization.id,
        returnUrl,
      });
      return { url: portal?.url ?? null };
    },
  };
}

function createRunReplyReporter(
  options: ApplicationCompositionOptions,
  ownership: CompositionResources,
): Pick<HubRuntimeOptions, "onRunReplyAnswer"> {
  const { database } = options;
  if (database === null) return {};
  const linear = options.registrations?.find(
    (registration) => registration.connection.name === "linear",
  );
  const reporter = new RunReplyReporter({
    database,
    writer: () => linear?.linearRunReplyWriter,
    perHour: options.runReplyLimit ?? readRunReplyLimit({}),
    onFailure: () => logger.warn("run reply delivery cycle failed"),
  });
  ownership.own(() => reporter.stop(), "composition.run_replies");
  reporter.start();
  return { onRunReplyAnswer: reporter.capture };
}

function createProgressReporter(
  options: ApplicationCompositionOptions,
  bus: RunTimelineBus | undefined,
  ownership: CompositionResources,
): { hubOptions: Pick<HubRuntimeOptions, "onProgressRequested">; start: () => void } {
  const { database, runProgress, progressProviders, publicBaseUrl } = options;
  if (database === null || bus === undefined || runProgress?.progressMessagesEnabled !== true)
    return { hubOptions: {}, start: () => undefined };
  const providers = activeProgressProviders(options, database, runProgress, progressProviders);
  if (providers === undefined) return { hubOptions: {}, start: () => undefined };

  const reporter = new ProgressReporter({
    database,
    bus,
    settings: {
      minEditSeconds: runProgress.minEditSeconds,
      maxEdits: runProgress.maxEdits,
      retentionDays: runProgress.retentionDays,
    },
    providers,
    publicBaseUrl,
    reportFailure: reportProgressFailure,
  });
  return {
    hubOptions: { onProgressRequested: (run) => reporter.request(run) },
    start: () => {
      ownership.own(async () => reporter.stop(), "composition.progress_reporter");
      reporter.start();
    },
  };
}

function activeProgressProviders(
  options: ApplicationCompositionOptions,
  database: Database,
  runProgress: RunProgressSettings,
  progressProviders: ApplicationCompositionOptions["progressProviders"],
): (() => ProgressProvider[]) | undefined {
  const registered = (options.registrations ?? []).filter(
    (registration) => "progressProvider" in registration,
  );
  const providers = progressProviders ?? [];
  const githubFallback =
    runProgress.githubToken !== undefined || options.githubNotifications !== undefined
      ? new GitHubProgressProvider({ database, settings: runProgress })
      : undefined;
  if (registered.length === 0 && providers.length === 0 && githubFallback === undefined)
    return undefined;

  // Provider applications can activate or be replaced after Hub starts.
  return () => {
    const active = [
      ...providers,
      ...registered.flatMap(({ progressProvider }) =>
        progressProvider === undefined ? [] : [progressProvider],
      ),
    ];
    if (githubFallback !== undefined && !active.some(({ name }) => name === "github"))
      active.push(githubFallback);
    return active;
  };
}

function reportProgressFailure(code: string, scope?: MessageScope): void {
  reportFailure(
    new Error(code),
    {
      operation: "run.progress.reporter",
      component: "run-progress",
      ...(scope === undefined ? {} : { organizationId: scope.organizationId }),
    },
    {
      ...(code === "scope_missing" ? { kind: "permissionMissing" } : {}),
      ...(scope === undefined
        ? {}
        : {
            diagnostic: {
              triggerRunId: scope.triggerRunId,
              ...(code === "scope_missing" ? { reason: code } : {}),
            },
          }),
    },
  );
}

function timelineScrubValues(options: ApplicationCompositionOptions): string[] {
  return [
    ...(options.timelineScrubValues ?? []),
    options.completionTokenSecret,
    options.runProgress?.githubToken,
  ].filter((value): value is string => value !== undefined);
}

function createRunStreamRuntime(
  options: ApplicationCompositionOptions,
  timeline: { timelineBus?: RunTimelineBus; runTimelineReconciler?: RunTimelineReconciler },
  ownership: CompositionResources,
) {
  const settings = options.runProgress ?? readRunProgressSettings({});
  const scrubValues = timelineScrubValues(options);
  const runStream = new RunStream({
    database: options.database,
    auth: options.auth,
    credentials: options.auth?.publicCredentials,
    bus: timeline.timelineBus,
    reconciler: timeline.runTimelineReconciler,
    settings,
    reportFailure: (error, requestId) => {
      reportFailure(
        error,
        { operation: "run.stream.handle", component: "run-progress", requestId },
        { scrubValues },
      );
    },
  });
  if (settings.runStreamEnabled) {
    ownership.own(() => runStream.beginShutdown(), "composition.run_stream");
  }
  const hubOptions: Pick<HubRuntimeOptions, "runStream"> = settings.runStreamEnabled
    ? { runStream }
    : {};
  return { runStream, hubOptions };
}

function validateRunPayloadRetention(options: ApplicationCompositionOptions) {
  if (options.runPayloadRetention !== undefined) {
    assertRunPayloadWindow(
      options.runPayloadRetention,
      options.runProgress?.retentionDays ?? readRunProgressSettings({}).retentionDays,
    );
  }
}

function createInteractiveSessionsRuntime(
  options: ApplicationCompositionOptions,
  connectionForDaemon: HubRuntime["connectionForDaemon"],
) {
  const { database, databaseQuery, auth, entitlements, runPayloadRetention, linearPilot } = options;
  const settings = options.interactiveSessions;
  if (settings?.enabled !== true || database === null || auth === null) {
    if (linearPilot) throw new Error("The Linear pilot requires interactive sessions.");
    return null;
  }
  if (databaseQuery === undefined || entitlements === null) {
    throw new Error("Interactive sessions require a database query handle and entitlements.");
  }
  const { coordinator, service, stream } = createInteractiveSessionServices({
    options,
    connectionForDaemon,
    settings,
    database,
    databaseQuery,
    auth,
    entitlements,
    runPayloadRetention,
    linearPilot,
  });
  return {
    hubOptions: { interactiveSessions: coordinator },
    browser: { service, stream },
    ownStream(ownership: CompositionResources) {
      if (linearPilot) ownership.own(() => linearPilot.stop(), "composition.linear_pilot");
      ownership.own(() => stream.beginShutdown(), "composition.interactive_sessions.stream");
    },
    startRetention(ownership: CompositionResources) {
      if (runPayloadRetention === undefined || runPayloadRetention.mode === "off") return;
      const retention = new SessionMessageRetention(database, databaseQuery, runPayloadRetention);
      ownership.own(() => retention.stop(), "composition.interactive_sessions.retention");
      retention.start();
    },
  };
}

interface InteractiveSessionServiceOptions {
  options: ApplicationCompositionOptions;
  connectionForDaemon: HubRuntime["connectionForDaemon"];
  settings: InteractiveSessionSettings;
  database: Database;
  databaseQuery: QueryHandle;
  auth: AuthServer;
  entitlements: EntitlementsService;
  runPayloadRetention: ApplicationCompositionOptions["runPayloadRetention"];
  linearPilot: ApplicationCompositionOptions["linearPilot"];
}

function createInteractiveSessionServices(input: InteractiveSessionServiceOptions) {
  const { options, connectionForDaemon, settings } = input;
  const { database, databaseQuery, auth, entitlements, runPayloadRetention, linearPilot } = input;
  const scrubValues = timelineScrubValues(options);
  const scrub = createTimelineScrubber({ scrubValues });
  const failureFields = (error: unknown) => {
    const { type, code } = serializeError(error, { scrubValues });
    return { errorType: type, ...(code === undefined ? {} : { errorCode: code }) };
  };
  const bodyCutoff = (now: Date) => sessionMessageBodyCutoff(runPayloadRetention, now);
  const bus = new SessionEventBus((error) =>
    logger.warn(failureFields(error), "interactive session event notification failed"),
  );
  const coordinator = new InteractiveSessionCoordinator({
    database,
    entitlements,
    connectionForDaemon,
    bus,
    settings,
    scrub,
    scrubValues,
    instanceId: randomUUID(),
    bodyCutoff,
    ...(linearPilot === undefined ? {} : { linearPilot: linearPilot.sessionHooks }),
    reportFailure: (error, operation) =>
      logger.warn(
        { operation, ...failureFields(error) },
        "interactive session coordinator operation failed",
      ),
  });
  linearPilot?.attachCoordinator(coordinator);
  const service = new InteractiveSessionService({
    database,
    pool: databaseQuery,
    auth,
    coordinator,
    bus,
    connectionForDaemon,
    scrub,
    scrubValues,
    bodyCutoff: () => bodyCutoff(new Date()),
  });
  const stream = new InteractiveSessionStream({
    service,
    bus,
    settings: options.runProgress ?? readRunProgressSettings({}),
    reportFailure: (error, requestId) =>
      logger.warn({ requestId, ...failureFields(error) }, "interactive session stream failed"),
  });
  return { coordinator, service, stream };
}

function browserAccount(
  { database, auth }: ApplicationCompositionOptions,
  request: Request,
  interactiveSessions: boolean,
): Promise<Response> {
  if (database === null || auth?.browserAccount === undefined) {
    return Promise.resolve(Response.json({ error: "auth_unavailable" }, { status: 503 }));
  }
  const response = auth.browserAccount(request);
  if (
    interactiveSessions &&
    request.method === "GET" &&
    new URL(request.url).pathname === "/api/auth/paseo/state"
  )
    return response.then(withInteractiveSessionAccountFeature);
  return response;
}

function collectProviderRequests(registrations: readonly ProviderRegistration[]) {
  const requests = new Map<string, (incoming: Request) => Promise<Response>>();
  for (const request of registrations.flatMap((registration) => registration.requests)) {
    if (requests.has(request.name)) {
      throw new Error(`provider request registrations must have unique names: ${request.name}`);
    }
    requests.set(request.name, (incoming) => request.handle(incoming));
  }
  return requests;
}

function collectProviderConnections(registrations: readonly ProviderRegistration[]) {
  const connections = new Map(
    registrations.map((registration) => [registration.connection.name, registration.connection]),
  );
  if (connections.size !== registrations.length) {
    throw new Error("provider connection registrations must have unique names");
  }
  const integrations = new Map<string, ProviderIntegrationRegistration>();
  for (const registration of registrations) {
    if (registration.integration !== undefined) {
      integrations.set(registration.connection.name, registration.integration);
    }
  }
  return { connections, integrations };
}

function startRunPayloadRetention(
  options: ApplicationCompositionOptions,
  ownership: CompositionResources,
) {
  const settings = options.runPayloadRetention;
  if (options.database === null || settings === undefined || settings.mode === "off") return;
  const retention = new RunPayloadRetention(options.database, settings);
  ownership.own(() => retention.stop(), "composition.run_payload_retention");
  retention.start();
}

function createRunTimelineRuntime(
  options: ApplicationCompositionOptions,
  ownership: CompositionResources,
): Pick<HubRuntimeOptions, "database" | "runTimeline" | "runTimelineReconciler"> & {
  timelineBus?: RunTimelineBus;
} {
  const settings = options.runProgress ?? readRunProgressSettings({});
  const database = options.database;
  if (database === null) return { database };
  startTimelineRetention(database, settings, ownership);
  if (!settings.runTimelineEnabled) return { database };
  const scrubValues = timelineScrubValues(options);
  const report = timelineFailureReporter(scrubValues);
  const bus = new RunTimelineBus({
    maxSubscriptions: Math.max(1024, settings.streamMaxTotal),
    reportFailure: (error) => report(error, "run.timeline.notify"),
  });
  const scrub = createTimelineScrubber({ scrubValues });
  const timeline = new RunTimeline(database, {
    maxEvents: settings.timelineMaxEvents,
    retentionDays: settings.retentionDays,
    scrub,
    bus,
    reportFailure: report,
  });
  const reconciler = new RunTimelineReconciler(database, {
    queue: timeline,
    maxEvents: settings.timelineMaxEvents,
    retentionDays: settings.retentionDays,
    scrub,
    bus,
    reportFailure: report,
  });
  ownership.own(async () => {
    reconciler.stopAdmission();
    await timeline.stop();
    await reconciler.stop();
  }, "composition.timeline_capture");
  reconciler.start();
  logger.info(
    {
      operation: "run.timeline.start",
      component: "run-progress",
      maxEvents: settings.timelineMaxEvents,
      retentionDays: settings.retentionDays,
      timelineEnabled: settings.runTimelineEnabled,
      streamEnabled: settings.runStreamEnabled,
      progressMessagesEnabled: settings.progressMessagesEnabled,
    },
    "run timeline capture enabled",
  );
  return {
    database: createObservedDatabase(database, { timeline, reconciler, reportFailure: report }),
    runTimeline: timeline,
    runTimelineReconciler: reconciler,
    timelineBus: bus,
  };
}

function startTimelineRetention(
  database: Database,
  settings: RunProgressSettings,
  ownership: CompositionResources,
): void {
  const retention = new TimelineRetention(database, {
    retentionDays: settings.retentionDays,
    reportFailure: (error) =>
      reportFailure(error, {
        operation: "run.timeline.retention",
        component: "run-progress",
      }),
  });
  ownership.own(() => retention.stop(), "composition.timeline_retention");
  retention.start();
}

function timelineFailureReporter(scrubValues: string[]) {
  return (error: unknown, operation: string, scope?: TimelineRunScope) => {
    reportFailure(
      error,
      {
        operation,
        component: "run-progress",
        ...(scope === undefined ? {} : { organizationId: scope.organizationId }),
      },
      {
        scrubValues,
        ...(scope === undefined ? {} : { diagnostic: { triggerRunId: scope.triggerRunId } }),
      },
    );
  };
}

function triggerDashboardFor(
  options: ApplicationCompositionOptions,
  hub: HubRuntime,
  reconciler: RunTimelineReconciler | undefined,
): TriggerDashboard | null {
  return options.database === null || options.auth === null || hub.agentValidator === null
    ? null
    : new TriggerDashboard(options.database, options.auth, hub.agentValidator, {
        stopRun: hub.stopRun,
        githubNotificationsEnabled: options.githubNotifications !== undefined,
        runProgress: options.runProgress ?? readRunProgressSettings({}),
        ...(reconciler === undefined ? {} : { reconciler }),
        ...(options.githubNotifications === undefined
          ? {}
          : { githubNotificationsPollSeconds: options.githubNotifications.pollIntervalMs / 1000 }),
      });
}

function homeDashboardFor(
  options: ApplicationCompositionOptions,
  connections: ReadonlyMap<string, ProviderConnectionRegistration>,
): HomeDashboard | null {
  if (options.database === null || options.auth === null) return null;
  // The same registrations `connectionStatus` answers from: a provider whose status is anything
  // but "not configured" has an app behind it.
  return new HomeDashboard(
    options.database,
    options.auth,
    (bindings) =>
      [...connections.values()].some((connection) => isConfigured(connection.status(bindings))),
    { interactiveSessions: options.interactiveSessions?.enabled === true },
  );
}

function isConfigured(status: unknown): boolean {
  return (
    typeof status === "object" &&
    status !== null &&
    Reflect.get(status, "status") !== "notConfigured"
  );
}

function daemonProviderCatalogFor(
  options: ApplicationCompositionOptions,
  hub: HubRuntime,
): DaemonProviderCatalog | null {
  if (options.database === null || options.auth === null) return null;
  return new DaemonProviderCatalog(options.database, options.auth, (daemonId) =>
    hub.connectionForDaemon(daemonId),
  );
}

function providerApplicationsFor(
  options: ApplicationCompositionOptions,
): ProviderApplications | null {
  return options.providerApplications ?? null;
}

function createConnectionsForProject(
  database: Database | null,
  integrations: ReadonlyMap<string, ProviderIntegrationRegistration>,
): (projectId: string) => ConnectionResolver {
  return (projectId) => async (connectionSlug, value, context) => {
    if (database === null) throw new Error("connection inventory unavailable");
    const project = await database.findProjectById(projectId);
    if (project === undefined) throw new Error("execution project unavailable");
    const usage = await database.organizationConnectionUsage(project.organizationId);
    const candidates = [
      ...usage.github.map((connection) => ({ provider: "github" as const, connection })),
      ...usage.discord.map((connection) => ({ provider: "discord" as const, connection })),
      ...usage.slack.map((connection) => ({ provider: "slack" as const, connection })),
    ].filter(
      ({ connection }) =>
        connection.organizationId === project.organizationId && connection.slug === connectionSlug,
    );
    if (candidates.length === 0) {
      throw new Error(`connection slug is unavailable: ${connectionSlug}`);
    }
    if (candidates.length !== 1) {
      throw new Error(`connection slug is ambiguous: ${connectionSlug}`);
    }
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new TypeError("Cannot read properties of undefined (reading 'provider')");
    }
    const integration = integrations.get(candidate.provider);
    if (integration === undefined) {
      throw new Error(`connection capability is unavailable: ${connectionSlug}`);
    }
    return integration.resolve(projectId, connectionSlug, value, context);
  };
}

function createRuntimeExecutionAuthority(
  database: Database | null,
  connectionsForProject: (projectId: string) => ConnectionResolver,
  integrations: ReadonlyMap<string, ProviderIntegrationRegistration>,
): ExecutionAuthority | undefined {
  if (database === null) return undefined;
  const githubAuthority = [...integrations.values()].find(
    (integration) => integration.githubAuthority !== undefined,
  )?.githubAuthority;
  return createExecutionAuthority({
    database,
    connectionsForProject,
    ...(githubAuthority === undefined ? {} : { githubAuthority }),
    isExecutionActive: async (executionId) => {
      const execution = await database.findAgentExecutionById(executionId);
      return execution?.status === "spawning" || execution?.status === "running";
    },
  });
}

/**
 * Billing operations are only reachable through the dashboard billing route, which the
 * `billingConfigured()` guard keeps off self-hosted instances. A null here is therefore a
 * routing bug, not a user-facing state — hence a thrown error rather than a returned outcome.
 */
function requireBilling(options: ApplicationCompositionOptions): {
  billing: BillingRuntime;
  database: Database;
} {
  if (options.billing === null || options.database === null) {
    throw new Error("billing is not configured");
  }
  return { billing: options.billing, database: options.database };
}

function requireAuth(options: ApplicationCompositionOptions): AuthServer {
  if (options.auth === null) throw new Error("browser auth is not configured");
  return options.auth;
}

/**
 * The two org/instance entitlement surfaces, present together whenever a database, browser auth,
 * and the core entitlements service all exist. Neither depends on billing — Usage renders on
 * self-hosted and hosted alike, and the operator console is gated by its own server-side flag,
 * not by Stripe.
 */
function entitlementSurfaces(options: ApplicationCompositionOptions): {
  usageDashboard: UsageDashboard | null;
  operatorConsole: OperatorConsole | null;
} {
  const { database, auth, entitlements } = options;
  if (database === null || auth === null || entitlements === null) {
    return { usageDashboard: null, operatorConsole: null };
  }
  return {
    usageDashboard: new UsageDashboard(database, auth, entitlements),
    operatorConsole: new OperatorConsole(database, auth, entitlements),
  };
}

/** The dashboard billing page — where Stripe returns the user after checkout or the portal. */
function billingReturnUrl(
  options: ApplicationCompositionOptions,
  request: Request,
  organizationSlug: string | undefined,
  fallbackSlug: string,
): string {
  const base = options.publicBaseUrl ?? new URL(request.url).origin;
  return new URL(`/o/${organizationSlug ?? fallbackSlug}/settings/billing`, base).toString();
}
