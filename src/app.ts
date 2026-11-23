import { logger } from "./logger.js";
import type { RunTimeline } from "./run-timeline/index.js";
import type { RunTimelineReconciler } from "./run-timeline/reconcile.js";
import type { RunStream } from "./run-stream/index.js";
import { createScheduleSource, createScheduleProvider } from "./triggers/schedule/index.js";
import {
  createGitHubNotificationProvider,
  createGitHubNotificationsSource,
  type GitHubNotificationsOptions,
} from "./triggers/github-notifications/index.js";
import { createExecutionCapabilityServer } from "./execution-capabilities/server.js";
import { OutputExecutorRegistry } from "./execution-capabilities/outputs.js";
import {
  createAttachmentCapabilityRegistry,
  type AttachmentCapabilityRegistry,
  type AttachmentProvider,
  type AttachmentResolver,
} from "./attachments/capabilities.js";
import {
  ProjectConfigurationStore,
  type DaemonAgentConfigurationValidator,
  validateHubBundleForOrganization,
} from "./configuration/store.js";
import type {
  AcceptedTriggerRunRecord,
  Database,
  TriggerRunRecord,
  WorkflowDeadlineRecovery,
} from "./db/types.js";
import { DatabaseUnavailableError } from "./db/errors.js";
import {
  ActiveDaemonRegistry,
  createDaemonUpgradeHandler,
  createDaemonModule,
  enrollDaemon,
  revokeDaemon,
  updateDaemonPermissions,
  type DaemonClock,
  type DaemonConnection,
  type DaemonModule,
} from "./daemons/index.js";
import { createDispatcherWithEngine, type LaunchMachineIntent } from "./dispatcher/index.js";
import type { DurableWorkflowEngine, DurableWorkflowEngineOptions } from "./workflows/engine.js";
import type {
  DaemonDispatchLifecycleOptions,
  ExecutionDeadlineClock,
} from "./daemons/lifecycle.js";
import type { TriggerProviderFactory, TriggerProviderResources } from "./providers/registration.js";
import type { TriggerHandler, TriggerProvider, TriggerSource } from "./triggers/index.js";
import type { StopRun } from "./triggers/run-stop.js";
import {
  createManualTriggerSource,
  dispatchManualTrigger,
  handleManualTriggerRequest,
} from "./triggers/manual/source.js";
import { createManualRunProvider } from "./triggers/manual/provider.js";
import { OrganizationTriggerStore } from "./triggers/store.js";
import { DaemonRegistration } from "./daemons/registration.js";
import { createScriptStepRunner } from "./daemons/terminals/script.js";
import type { ScriptLimits } from "./workflows/script-limits.js";
import { runShutdownStage } from "./shutdown-stage.js";
import { CliAuthorizations } from "./cli-authorizations/index.js";
import type { BrowserOrganizationAccess } from "./auth/browser-organization-access.js";
import { createPublicApi, type PublicApi, type PublicApiComposition } from "./public-api/index.js";
import {
  createPublicOperations,
  type PublicOperationCapabilities,
} from "./public-operations/index.js";
import type { DispatchResolvedManualRun } from "./public-operations/manual-dispatch.js";
import { createDatabasePublicOperationRepository } from "./public-operations/database-adapter.js";
import type { EntitlementsService } from "./entitlements/service.js";
import type { ExecutionAuthority } from "./execution-authority/index.js";
import type { WebhookOptions } from "./webhook-config.js";
import type { InteractiveSessionCoordinator } from "./interactive-sessions/coordinator.js";

export interface HubRuntimeOptions {
  database: Database | null;
  /** Required end to end so the executions meter can never be silently skipped. */
  entitlements: EntitlementsService | null;
  providers?: readonly TriggerProvider[];
  providerFactories?: readonly TriggerProviderFactory[];
  executionAuthority?: ExecutionAuthority;
  attachmentResolvers?: Partial<Record<AttachmentProvider, AttachmentResolver>>;
  connectionsForProject?: TriggerProviderResources["connectionsForProject"];
  configurationRevisionId?: string;
  outputRegistry?: OutputExecutorRegistry;
  publicApi: PublicApiComposition;
  completionTokenSecret?: string;
  publicBaseUrl?: string;
  daemonClock?: DaemonClock;
  executionDeadlineClock?: ExecutionDeadlineClock;
  dispatchTimeoutMs?: number;
  browserOrganizationAccess?: BrowserOrganizationAccess;
  daemonConnectionForId?: DaemonDispatchLifecycleOptions["connectionForDaemon"];
  /** Polls GitHub notifications with a Hub-level token. Omitted: the source is off. */
  githubNotifications?: GitHubNotificationsOptions;
  /** How many script steps may run at once. */
  scriptLimits?: ScriptLimits | undefined;
  webhookOptions?: WebhookOptions | undefined;
  onProgressRequested?: DurableWorkflowEngineOptions["onProgressRequested"];
  onRunReplyAnswer?: NonNullable<DaemonDispatchLifecycleOptions["onRunReplyAnswer"]>;
  runTimeline?: RunTimeline;
  runTimelineReconciler?: RunTimelineReconciler;
  runStream?: RunStream;
  interactiveSessions?: InteractiveSessionCoordinator;
}

export interface HubRuntime {
  stopRun: StopRun;
  dispatchManualRun: DispatchResolvedManualRun;
  daemonModule: DaemonModule | null;
  interactiveSessions: InteractiveSessionCoordinator | null;
  connectionForDaemon(daemonId: string): DaemonConnection | undefined;
  /** The daemons' own answer about an agent configuration; null without a database. */
  agentValidator: DaemonAgentConfigurationValidator | null;
  resourceCounts(): {
    executionSubscriptions: number;
    timelineQueueDepth?: number;
    timelineQueueEntries?: number;
    timelineAccountingEntries?: number;
    timelineAccountingGiveUps?: number;
    timelineAccountingDropsAbandoned?: number;
    runStreams?: number;
    streamNotifiers?: number;
  };
  processWorkflowOutbox(): Promise<void>;
  handleUpgrade: ReturnType<typeof createDaemonUpgradeHandler> | null;
  start(sources?: readonly TriggerSource[]): Promise<void>;
  stop(): Promise<void>;
}

export interface HubOperations {
  handleDaemonEnrollment(request: Request): Promise<Response>;
  handleDaemonRevocation(request: Request, daemonId: string): Promise<Response>;
  handleDaemonPermissionUpdate(request: Request, daemonId: string): Promise<Response>;
  handleCliAuthorizationStart(request: Request): Promise<Response>;
  handleCliAuthorizationPoll(request: Request): Promise<Response>;
  handleCliAuthorizationInspect(request: Request): Promise<Response>;
  handleCliAuthorizationDecision(request: Request): Promise<Response>;
  handleOrganizationDaemons(request: Request): Promise<Response>;
  handleOrganizationDaemonRename(request: Request, daemonId: string): Promise<Response>;
  handleOrganizationDaemonRevocation(request: Request, daemonId: string): Promise<Response>;
  handleSessionCapabilities(request: Request, sessionId: string): Promise<Response>;
  handleExecutionCapabilities(request: Request, executionId: string): Promise<Response>;
  handleAttachmentDownload(
    request: Request,
    executionId: string,
    attachmentId: string,
  ): Promise<Response>;
  handleManualTrigger(request: Request, entrypoint: "trigger" | "smoke"): Promise<Response>;
}

export interface HubApplication {
  hub: HubRuntime;
  operations: HubOperations;
  publicApi: PublicApi;
  configurationForProject(projectId: string): ProjectConfigurationStore;
}

export function createHubRuntime(options: HubRuntimeOptions): HubRuntime {
  return createHubApplication(options).hub;
}

export function createHubApplication(options: HubRuntimeOptions): HubApplication {
  const { daemons, connectionForDaemon, agentValidator } = createDaemonAccess(options);
  const storeForProject = (projectId: string) => {
    if (options.database === null) throw new DatabaseUnavailableError();
    return new ProjectConfigurationStore(options.database, projectId, daemons ?? undefined);
  };
  const manualProvider =
    options.database === null ? undefined : createManualRunProvider(storeForProject);
  const attachments = createAttachmentRegistry(options);
  const providers = createAppProviders(options, storeForProject, manualProvider, attachments);
  const outputRegistry = options.outputRegistry ?? new OutputExecutorRegistry();
  const daemonModule = createAppDaemonModule(options, daemons, providers, outputRegistry);
  const capabilityServer = createAppExecutionCapabilityServer(
    options,
    daemonModule,
    outputRegistry,
  );
  const registration = createAppDaemonRegistration(options, daemons);
  const cliAuthorizations = createAppCliAuthorizations(options);
  const triggerSources = createAppTriggerSources(options);
  const { manualSource } = triggerSources;
  const { handler: workflowDispatcher, engine: workflowEngine } = createAppDispatcher(
    options,
    daemonModule,
    providers,
    connectionForDaemon,
  );
  const interactiveSessions = connectDaemonLifecycle(
    daemons,
    daemonModule,
    workflowEngine,
    options.interactiveSessions,
  );
  const { publicApi, runOperations } = createAppPublicApi(options, {
    manualSource,
    configurationForProject: storeForProject,
    daemonAgentValidator: agentValidator,
    stopRun: workflowEngine.stopRun.bind(workflowEngine),
  });
  const hub = createAppRuntime(options, {
    daemons,
    daemonModule,
    interactiveSessions,
    connectionForDaemon,
    agentValidator,
    workflowEngine,
    workflowDispatcher,
    triggerSources,
    ...runOperations,
  });
  const operations = createAppOperations(options, {
    daemons,
    cliAuthorizations,
    registration,
    capabilityServer,
    attachments,
    manualSource,
  });
  return { hub, operations, publicApi, configurationForProject: storeForProject };
}

function createDaemonAccess(options: HubRuntimeOptions) {
  const daemons =
    options.database === null
      ? null
      : new ActiveDaemonRegistry(options.database, options.daemonClock);
  const connectionForDaemon = (daemonId: string) =>
    options.daemonConnectionForId?.(daemonId) ?? daemons?.connection(daemonId);
  const agentValidator = createAgentValidator(daemons, connectionForDaemon);
  return { daemons, connectionForDaemon, agentValidator };
}

function createAppProviders(
  options: HubRuntimeOptions,
  storeForProject: HubApplication["configurationForProject"],
  manualProvider: TriggerProvider | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): TriggerProvider[] {
  const configuredProviders =
    options.database === null
      ? []
      : (options.providerFactories ?? []).map((factory) =>
          factory({
            configurationStoreForProject: storeForProject,
            connectionsForProject:
              options.connectionsForProject ??
              (() => () => {
                throw new Error("no connection resolver registered");
              }),
            ...(attachments === undefined ? {} : { attachments }),
          }),
        );
  return [
    createScheduleProvider(),
    createGitHubNotificationProvider(),
    manualProvider,
    ...configuredProviders,
    ...(options.providers ?? []),
  ].filter((provider): provider is TriggerProvider => provider !== undefined);
}

function createAppDaemonRegistration(
  options: HubRuntimeOptions,
  daemons: ActiveDaemonRegistry | null,
): DaemonRegistration | null {
  return options.database === null || daemons === null
    ? null
    : new DaemonRegistration({
        database: options.database,
        activeDaemons: daemons,
        ...(options.browserOrganizationAccess === undefined
          ? {}
          : { access: options.browserOrganizationAccess }),
      });
}

function createAppCliAuthorizations(options: HubRuntimeOptions): CliAuthorizations | null {
  return options.database === null
    ? null
    : new CliAuthorizations(
        options.database,
        options.browserOrganizationAccess,
        options.publicBaseUrl,
      );
}

type ManualSource = ReturnType<typeof createManualTriggerSource> | undefined;

function createAppTriggerSources(options: HubRuntimeOptions) {
  const scheduleSource = appScheduleSource(options.database);
  const notificationSource = appNotificationSource(options);
  const manualSource =
    options.database === null ? undefined : createManualTriggerSource(options.database);
  return { scheduleSource, notificationSource, manualSource };
}

function createAppDispatcher(
  options: HubRuntimeOptions,
  daemonModule: DaemonModule | null,
  providers: readonly TriggerProvider[],
  connectionForDaemon: HubRuntime["connectionForDaemon"],
) {
  const durableDispatchHandler =
    options.database === null || daemonModule === null
      ? undefined
      : (intent: LaunchMachineIntent) => daemonModule.lifecycle.handoffLaunchMachineIntent(intent);
  const clock = options.executionDeadlineClock;
  const registry = options.outputRegistry;
  return createDispatcherWithEngine({
    scriptRunner: createScriptStepRunner(connectionForDaemon),
    scriptLimits: options.scriptLimits,
    canDispatchToDaemon: (daemonId) => connectionForDaemon(daemonId) !== undefined,
    database: options.database,
    onProgressRequested: options.onProgressRequested,
    timeline: options.runTimeline,
    timelineReconciler: options.runTimelineReconciler,
    entitlements: options.entitlements,
    providers,
    ...(options.configurationRevisionId === undefined
      ? {}
      : { configurationRevisionId: options.configurationRevisionId }),
    ...(clock === undefined ? {} : { now: () => new Date(clock.now()) }),
    ...(registry === undefined
      ? {}
      : {
          validateLaunchMachineIntent: (intent) =>
            registry.validateRequiredOutputs(intent.allowOutputs, intent.outputContext),
        }),
    ...(daemonModule === null
      ? {}
      : {
          onWorkflowDeadlineExceeded: async (recovery: WorkflowDeadlineRecovery) => {
            await daemonModule.lifecycle.recoverWorkflowDeadlineExecutions(recovery.executionIds);
          },
          onWorkflowExecutionsTerminal: (executionIds: readonly string[], retryStop?: boolean) =>
            daemonModule.lifecycle.recoverWorkflowTerminalExecutions(executionIds, retryStop),
          onWorkflowRunAccepted: (run: AcceptedTriggerRunRecord) =>
            daemonModule.lifecycle.notifyWorkflowRunAccepted(run),
          onWorkflowRunStarted: (run: AcceptedTriggerRunRecord) =>
            daemonModule.lifecycle.notifyWorkflowRunStarted(run),
          onWorkflowRunTerminal: (run: TriggerRunRecord) =>
            daemonModule.lifecycle.notifyWorkflowRunTerminal(run),
        }),
    ...(durableDispatchHandler === undefined
      ? {}
      : { dispatchLaunchMachineIntent: durableDispatchHandler }),
  });
}

interface RuntimeLifecycleDependencies {
  daemons: ActiveDaemonRegistry | null;
  daemonModule: DaemonModule | null;
  interactiveSessions: InteractiveSessionCoordinator | null;
  workflowEngine: DurableWorkflowEngine;
  workflowDispatcher: TriggerHandler;
  triggerSources: ReturnType<typeof createAppTriggerSources>;
}

function createAppRuntime(
  options: HubRuntimeOptions,
  dependencies: RuntimeLifecycleDependencies &
    Pick<HubRuntime, "connectionForDaemon" | "agentValidator" | "stopRun" | "dispatchManualRun">,
): HubRuntime {
  const {
    daemonModule,
    interactiveSessions,
    connectionForDaemon,
    agentValidator,
    workflowEngine,
    daemons,
    stopRun,
    dispatchManualRun,
  } = dependencies;
  return {
    daemonModule,
    interactiveSessions,
    connectionForDaemon,
    agentValidator,
    stopRun,
    dispatchManualRun,
    resourceCounts: () => appResourceCounts(options, daemonModule),
    processWorkflowOutbox: () => workflowEngine.processAvailable(),
    handleUpgrade:
      options.database === null || daemons === null
        ? null
        : createDaemonUpgradeHandler(options.database, daemons),
    ...createRuntimeLifecycle(options, dependencies),
  };
}

function appResourceCounts(
  options: HubRuntimeOptions,
  daemonModule: DaemonModule | null,
): ReturnType<HubRuntime["resourceCounts"]> {
  const executionSubscriptions = daemonModule?.lifecycle.activeExecutionObservationCount() ?? 0;
  if (options.runTimeline === undefined) return { executionSubscriptions };
  const accounting = options.runTimeline.accountingStats();
  return {
    executionSubscriptions,
    ...(options.runStream === undefined
      ? {}
      : {
          runStreams: options.runStream.activeStreamCount(),
          streamNotifiers: options.runStream.notifierCount(),
        }),
    timelineQueueDepth: options.runTimeline.depth(),
    timelineQueueEntries: accounting.queueEntries,
    timelineAccountingEntries: accounting.retainedEntries,
    timelineAccountingGiveUps: accounting.giveUps,
    timelineAccountingDropsAbandoned: accounting.abandonedDrops,
  };
}

function createRuntimeLifecycle(
  options: HubRuntimeOptions,
  dependencies: RuntimeLifecycleDependencies,
): Pick<HubRuntime, "start" | "stop"> {
  const {
    daemons,
    daemonModule,
    interactiveSessions,
    workflowEngine,
    workflowDispatcher,
    triggerSources,
  } = dependencies;
  const { manualSource, scheduleSource, notificationSource } = triggerSources;
  let activeSources: readonly TriggerSource[] = [];
  return {
    async start(sources = []) {
      await options.executionAuthority?.recover();
      await Promise.all([
        daemonModule?.lifecycle.recoverAgentExecutionDeadlines(),
        daemonModule?.lifecycle.recoverPendingHubActions(),
      ]);
      daemonModule?.lifecycle.startStopInterruptRecovery();
      if (interactiveSessions !== null) await interactiveSessions.begin();
      workflowEngine.start();
      activeSources = [
        ...(manualSource === undefined ? [] : [manualSource]),
        ...(scheduleSource === undefined ? [] : [scheduleSource]),
        ...(notificationSource === undefined ? [] : [notificationSource]),
        ...sources,
      ];
      await Promise.all(activeSources.map(async (source) => source.start(workflowDispatcher)));
    },
    async stop() {
      if (options.runStream !== undefined) await options.runStream.beginShutdown();
      try {
        await Promise.all(
          activeSources.map((source, index) => stopTriggerSource(source, index, triggerSources)),
        );
        activeSources = [];
        await Promise.all([
          runShutdownStage("workflow.drain", () => workflowEngine.stop()),
          daemonModule === null
            ? undefined
            : runShutdownStage("lifecycle.drain", () => daemonModule.lifecycle.stop()),
          daemons === null ? undefined : runShutdownStage("registry.drain", () => daemons.stop()),
          interactiveSessions === null
            ? undefined
            : runShutdownStage("interactive-sessions.drain", () =>
                interactiveSessions.stopAccepting(),
              ),
        ]);
      } finally {
        const executionAuthority = options.executionAuthority;
        if (executionAuthority !== undefined) {
          await runShutdownStage("execution-authority.stop", () => executionAuthority.stop());
        }
      }
    },
  };
}

function stopTriggerSource(
  source: TriggerSource,
  index: number,
  { manualSource, scheduleSource, notificationSource }: ReturnType<typeof createAppTriggerSources>,
) {
  let stage = `trigger.source.${index}`;
  if (source === manualSource) stage = "trigger.manual";
  else if (source === scheduleSource) stage = "trigger.schedule";
  else if (source === notificationSource) stage = "trigger.github-notifications";
  return runShutdownStage(stage, () => source.stop());
}

interface AppOperationDependencies {
  daemons: ActiveDaemonRegistry | null;
  cliAuthorizations: CliAuthorizations | null;
  registration: DaemonRegistration | null;
  capabilityServer: ReturnType<typeof createAppExecutionCapabilityServer>;
  attachments: AttachmentCapabilityRegistry | undefined;
  manualSource: ManualSource;
}

function createAppOperations(
  options: HubRuntimeOptions,
  {
    daemons,
    cliAuthorizations,
    registration,
    capabilityServer,
    attachments,
    manualSource,
  }: AppOperationDependencies,
): HubOperations {
  return {
    handleDaemonEnrollment: (request) =>
      options.database === null
        ? databaseUnavailable()
        : enrollDaemon(request, options.database, options.publicBaseUrl, options.daemonClock),
    handleDaemonRevocation: (request, daemonId) =>
      options.database === null || daemons === null
        ? databaseUnavailable()
        : revokeDaemon(request, daemonId, options.database, daemons),
    handleDaemonPermissionUpdate: (request, daemonId) =>
      options.database === null || daemons === null
        ? databaseUnavailable()
        : updateDaemonPermissions(request, daemonId, options.database, daemons),
    handleCliAuthorizationStart: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.start(request),
    handleCliAuthorizationPoll: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.poll(request),
    handleCliAuthorizationInspect: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.inspect(request),
    handleCliAuthorizationDecision: (request) =>
      cliAuthorizations === null ? databaseUnavailable() : cliAuthorizations.decide(request),
    handleOrganizationDaemons: (request) =>
      registration === null ? databaseUnavailable() : registration.list(request),
    handleOrganizationDaemonRename: (request, daemonId) =>
      registration === null ? databaseUnavailable() : registration.rename(request, daemonId),
    handleOrganizationDaemonRevocation: (request, daemonId) =>
      registration === null ? databaseUnavailable() : registration.revoke(request, daemonId),
    handleSessionCapabilities: (request, sessionId) =>
      capabilityServer === null
        ? databaseUnavailable()
        : capabilityServer.handleSession(request, sessionId),
    handleExecutionCapabilities: (request, executionId) =>
      capabilityServer === null
        ? databaseUnavailable()
        : capabilityServer.handle(request, executionId),
    handleAttachmentDownload: (request, executionId, attachmentId) =>
      attachments === undefined
        ? databaseUnavailable()
        : attachments.handle(request, executionId, attachmentId),
    handleManualTrigger: (request, entrypoint) =>
      manualSource === undefined
        ? databaseUnavailable()
        : handleManualTriggerRequest(request, manualSource, entrypoint),
  };
}

/**
 * Every question Hub asks a daemon goes through its connection, so a test that stands in a
 * connection stands in for agent validation too.
 */
function createAgentValidator(
  daemons: ActiveDaemonRegistry | null,
  connectionForDaemon: (daemonId: string) => DaemonConnection | undefined,
): DaemonAgentConfigurationValidator | null {
  if (daemons === null) return null;
  return {
    validateAgentConfiguration: (daemonId, agent) =>
      connectionForDaemon(daemonId)?.validateAgentConfiguration(agent) ??
      Promise.reject(new Error("daemon_not_connected")),
  };
}

interface AppPublicOperationDependencies {
  manualSource: ManualSource;
  configurationForProject: HubApplication["configurationForProject"];
  daemonAgentValidator: DaemonAgentConfigurationValidator | null;
  stopRun: HubRuntime["stopRun"];
}

function createAppPublicApi(
  options: HubRuntimeOptions,
  dependencies: AppPublicOperationDependencies,
): { publicApi: PublicApi; runOperations: Pick<HubRuntime, "stopRun" | "dispatchManualRun"> } {
  const publicOperations = createAppPublicOperations(options, dependencies);
  return {
    publicApi: createPublicApi(options.publicApi, publicOperations, {
      webhookOptions: options.webhookOptions,
    }),
    runOperations: {
      stopRun: dependencies.stopRun,
      dispatchManualRun: async (request) =>
        publicOperations?.dispatchResolvedManualRun(request) ?? {
          status: "infrastructure_unavailable",
        },
    },
  };
}

function createAppPublicOperations(
  options: HubRuntimeOptions,
  {
    manualSource,
    configurationForProject,
    daemonAgentValidator,
    stopRun,
  }: AppPublicOperationDependencies,
) {
  if (options.database === null || manualSource === undefined || daemonAgentValidator === null) {
    return null;
  }
  const database = options.database;
  return createPublicOperations(
    createDatabasePublicOperationRepository(database),
    {
      stopRun,
      triggerForOrganization: (organizationId) =>
        createOrganizationTriggerOperations(
          new OrganizationTriggerStore(database, organizationId, daemonAgentValidator),
        ),
      configurationForProject,
      validateBundleForOrganization: (organizationId, files) =>
        validateHubBundleForOrganization(database, organizationId, files, daemonAgentValidator),
      dispatchManualEvent: (input) => dispatchManualTrigger(manualSource, input),
    },
    options.daemonClock,
    options.webhookOptions,
  );
}

function createOrganizationTriggerOperations(
  store: OrganizationTriggerStore,
): ReturnType<NonNullable<PublicOperationCapabilities["triggerForOrganization"]>> {
  return {
    async list() {
      return Promise.all(
        (await store.list()).map(async (trigger) => ({
          id: trigger.id,
          name: trigger.name,
          enabled: trigger.enabled,
          format: trigger.format,
          yaml: (await store.activeRevision(trigger)).yaml,
        })),
      );
    },
    async validate(yaml) {
      const prepared = await store.validate(yaml);
      return { name: prepared.compiled.authored.name };
    },
    async install(input) {
      const prepared = await store.validate(input.yaml);
      const existing = (await store.list()).find(
        ({ name }) => name === prepared.compiled.authored.name,
      );
      const trigger = await store.save({
        ...(existing === undefined ? {} : { triggerId: existing.id }),
        yaml: input.yaml,
        userId: null,
        sourceEvidence: {
          kind: input.credentialKind === "apiKey" ? "api-key" : "cli-credential",
          credentialId: input.credentialId,
          authoredFormat: "self_contained_trigger_v1",
        },
      });
      const revision = await store.activeRevision(trigger);
      return {
        triggerId: trigger.id,
        name: trigger.name,
        revisionId: revision.id,
        version: revision.version,
      };
    },
  };
}

function createAppExecutionCapabilityServer(
  options: HubRuntimeOptions,
  daemonModule: DaemonModule | null,
  outputRegistry: OutputExecutorRegistry,
) {
  if (options.database === null || daemonModule === null) {
    return null;
  }
  return createExecutionCapabilityServer({
    ...(options.completionTokenSecret === undefined
      ? {}
      : { completionTokenSecret: options.completionTokenSecret }),
    database: options.database,
    outputs: outputRegistry,
    finishCalls: daemonModule.lifecycle.finishCalls,
    completeExecution: (input) =>
      daemonModule.lifecycle.completeAgentExecutionFromCallback(input, { deferHubAction: true }),
  });
}

function createAttachmentRegistry(
  options: HubRuntimeOptions,
): AttachmentCapabilityRegistry | undefined {
  if (
    options.database === null ||
    options.publicBaseUrl === undefined ||
    options.completionTokenSecret === undefined
  ) {
    return undefined;
  }
  return createAttachmentCapabilityRegistry({
    database: options.database,
    publicBaseUrl: options.publicBaseUrl,
    authoritySecret: options.completionTokenSecret,
    resolvers: options.attachmentResolvers ?? {},
  });
}

function databaseUnavailable(): Promise<Response> {
  return Promise.resolve(Response.json({ error: "database_unavailable" }, { status: 503 }));
}

function connectDaemonLifecycle(
  daemons: ActiveDaemonRegistry | null,
  daemonModule: DaemonModule | null,
  workflowEngine: DurableWorkflowEngine,
  interactiveSessions: InteractiveSessionCoordinator | undefined,
): InteractiveSessionCoordinator | null {
  daemons?.onConnected((daemon) => daemonModule?.lifecycle.recoverDaemon(daemon));
  // A daemon that reconnects may hold terminals a Hub could not stop before it dropped.
  daemons?.onConnected((daemon) => workflowEngine.sweepScriptTerminals(daemon.id));
  daemons?.onRevoked((daemon) =>
    daemonModule?.lifecycle.failPendingExecutionsForDisconnectedMachine(
      daemon.machineId,
      "daemon_revoked",
    ),
  );
  if (daemons === null || interactiveSessions === undefined) return null;
  daemons.onConnected((daemon) => interactiveSessions.recoverDaemon(daemon));
  daemons.onDisconnected((daemon) => interactiveSessions.daemonDisconnected(daemon));
  daemons.onRevoked((daemon) => interactiveSessions.daemonRevoked(daemon));
  return interactiveSessions;
}

function createAppDaemonModule(
  options: HubRuntimeOptions,
  daemons: ActiveDaemonRegistry | null,
  providers: readonly TriggerProvider[],
  outputRegistry: OutputExecutorRegistry,
): DaemonModule | null {
  if (options.database === null) {
    return null;
  }

  const usesTestTiming =
    options.executionDeadlineClock !== undefined || options.dispatchTimeoutMs !== undefined;
  return createDaemonModule({
    database: options.database,
    connectionForDaemon: options.daemonConnectionForId ?? ((id) => daemons?.connection(id)),
    executionCapabilities: outputRegistry,
    ...(options.runTimeline === undefined ? {} : { timeline: options.runTimeline }),
    ...(options.onRunReplyAnswer === undefined
      ? {}
      : { onRunReplyAnswer: options.onRunReplyAnswer }),
    ...(options.completionTokenSecret === undefined
      ? {}
      : { completionTokenSecret: options.completionTokenSecret }),
    providers,
    ...(options.executionAuthority === undefined
      ? {}
      : { executionAuthority: options.executionAuthority }),
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    ...(usesTestTiming ? { test: createDaemonTestTiming(options) } : {}),
  });
}

function createDaemonTestTiming(options: HubRuntimeOptions) {
  return {
    ...(options.executionDeadlineClock === undefined
      ? {}
      : { deadlineClock: options.executionDeadlineClock }),
    ...(options.dispatchTimeoutMs === undefined
      ? {}
      : { dispatchTimeoutMs: options.dispatchTimeoutMs }),
  };
}

function appNotificationSource(options: HubRuntimeOptions): TriggerSource | undefined {
  const { database, githubNotifications, onProgressRequested } = options;
  if (database === null || githubNotifications === undefined) return undefined;
  return createGitHubNotificationsSource(database.githubNotifications, {
    ...githubNotifications,
    ...(onProgressRequested === undefined
      ? {}
      : {
          async onProgressRequested({ organizationId, triggerRunId }) {
            try {
              const run = await database.findTriggerRunForOrganization(
                organizationId,
                triggerRunId,
              );
              if (run?.outcome === "accepted") await onProgressRequested(run);
            } catch {
              logger.warn({ triggerRunId }, "could not request run progress");
            }
          },
        }),
  });
}

function appScheduleSource(database: Database | null): TriggerSource | undefined {
  return database === null ? undefined : createScheduleSource(database.schedules);
}
