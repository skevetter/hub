import type { RunTimeline } from "../run-timeline/index.js";
import type { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import { continuationKey } from "../triggers/continuation.js";
import { DatabaseUnavailableError, isTransientDatabaseError } from "../db/errors.js";
import { retryDiagnostic, retryWithBackoff, type RetryRuntime } from "../db/retry.js";
import type {
  AgentExecutionRecord,
  Database,
  DurableProviderEvent,
  MeterReservation,
  MeterReservationDenied,
  AcceptedTriggerRunRecord,
  TriggerRunRecord,
  WorkflowWakeupRecord,
  WorkflowDeadlineRecovery,
} from "../db/types.js";
import type { AgentExecutionStatus } from "../db/schema.js";
import {
  isScriptStep,
  parseCompiledHubConfig,
  type CompiledAgentStep,
  type CompiledScriptStep,
  type JsonPrimitive,
  type JsonValue,
} from "../config/compiler.js";
import { triggerDocumentName, type CompiledProjectConfiguration } from "../configuration/store.js";
import { logger as defaultLogger } from "../logger.js";
import { reportFailure } from "../failures/index.js";
import { durableExecutionId } from "../daemons/lifecycle.js";
import { EntitlementDenied } from "../entitlements/catalog.js";
import { encodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import type { EntitlementsService } from "../entitlements/service.js";
import {
  buildLaunchMachineIntent,
  type LaunchMachineIntent,
} from "../dispatcher/launch-machine-intent.js";
import type {
  TriggerDispatchOutcome,
  TriggerEventName,
  TriggerHandler,
  TriggerProvider,
  TriggerProviderMatch,
  AcceptedTriggerProviderMatch,
} from "../triggers/index.js";
import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import { logProviderEventRouting } from "../triggers/audit.js";
import { asTriggerContextValue, isAcceptedTriggerProviderMatch } from "../triggers/index.js";
import {
  ExpressionEvaluationError,
  evaluateExpression,
  expressionPathsInTemplate,
  renderExecutionTemplate,
  renderExpressionTemplate,
  type Expression,
  type ExpressionContext,
} from "./expression.js";
import type { WorktreeTarget } from "../config/index.js";
import type { Logger } from "pino";
import type { ScriptStepRunner } from "../daemons/terminals/script.js";
import { ScriptStepRuntime, type ScriptStepLaunch } from "./script-step.js";
import { canStopRun, type RunStopActor, type StopRunResult } from "../triggers/run-stop.js";
import { DEFAULT_SCRIPT_LIMITS, type ScriptLimits } from "./script-limits.js";
import {
  DEFAULT_TERMINAL_NOTIFICATION_HOLD_MS,
  ABANDONED_TERMINAL_WARN_AT,
  DEFAULT_TERMINAL_NOTIFICATION_STOP_GRACE_MS,
  settlesWithin,
  TerminalNotificationLease,
} from "./terminal-lease.js";

const DEFAULT_WAKEUP_LEASE_MS = 30_000;
const DEFAULT_WORKER_INTERVAL_MS = 250;
const TRIGGER_CONTEXT_MATERIALIZER_UNAVAILABLE_REASON = "trigger_context_materializer_unavailable";
const TRIGGER_CONTEXT_UNAVAILABLE_REASON = "trigger_context_unavailable";

type AcceptedWorkflowRun = Extract<
  Awaited<ReturnType<Database["findTriggerRunById"]>>,
  { outcome: "accepted" }
>;
type WorkflowStepRun = Awaited<ReturnType<Database["listWorkflowStepRunsForTriggerRun"]>>[number];
type ClaimedTerminalNotification = AcceptedTriggerRunRecord & {
  terminalNotificationGeneration: number;
};
interface PreparedWorkflowWakeup {
  run: AcceptedWorkflowRun;
  configuration: CompiledProjectConfiguration;
  /** The trigger's name as its author wrote it, which is what the user sees for this run. */
  triggerName: string;
  trigger: CompiledProjectConfiguration["triggers"][number];
  steps: WorkflowStepRun[];
  next: WorkflowStepRun;
  step: CompiledProjectConfiguration["triggers"][number]["steps"][number];
  context: ExpressionContext;
  recoverPreHandoffDispatch: boolean;
}

type RunCancellation = NonNullable<Awaited<ReturnType<Database["cancelTriggerRun"]>>>;
type CreatedWorkflowExecution = Awaited<ReturnType<Database["createWorkflowStepExecution"]>>;
type WorkflowPreparation = Pick<
  PreparedWorkflowWakeup,
  "configuration" | "triggerName" | "trigger"
>;
type PendingWorkflowStep = Omit<
  PreparedWorkflowWakeup,
  "next" | "step" | "recoverPreHandoffDispatch"
>;
type AgentWakeup = Omit<PreparedWorkflowWakeup, "step"> & { step: CompiledAgentStep };

interface LinkWorkflowStepOptions {
  database: Database;
  triggerRunId: string;
  steps: readonly WorkflowStepRun[];
  stepRunId: string;
  executionId: string;
  intent: LaunchMachineIntent;
}

interface MaterializedStepIntentOptions {
  configuration: CompiledProjectConfiguration;
  triggerName: string;
  trigger: CompiledProjectConfiguration["triggers"][number];
  step: CompiledAgentStep;
  run: AcceptedWorkflowRun;
  context: ExpressionContext;
  stepRunId: string;
  deadlineAt: Date;
}

interface StepIntentOptions extends MaterializedStepIntentOptions {
  executionId: string;
}

export interface DurableWorkflowEngineOptions {
  database: Database | null;
  /** Required end to end so the executions meter can never be silently skipped. */
  entitlements: EntitlementsService | null;
  providers?: readonly TriggerProvider[];
  dispatchLaunchMachineIntent?: (intent: LaunchMachineIntent) => Promise<unknown>;
  canDispatchToDaemon?: (daemonId: string) => boolean;
  validateLaunchMachineIntent?: (intent: LaunchMachineIntent) => void;
  /** Runs script steps in daemon terminals. Without it a script step fails the run. */
  scriptRunner?: ScriptStepRunner;
  /** How many script steps may run at once. Defaults to 5 per daemon and 3 per trigger. */
  scriptLimits?: ScriptLimits | undefined;
  configurationRevisionId?: string;
  leaseMs?: number;
  terminalNotificationHoldMs?: number;
  /** How long stop() waits for a terminal notification in flight before abandoning it. */
  terminalNotificationStopGraceMs?: number;
  workerIntervalMs?: number;
  now?: () => Date;
  onWorkflowDeadlineExceeded?: (recovery: WorkflowDeadlineRecovery) => Promise<void>;
  onWorkflowExecutionsTerminal?: (
    executionIds: readonly string[],
    retryStop?: boolean,
  ) => Promise<void>;
  onWorkflowRunAccepted?: (run: AcceptedTriggerRunRecord) => Promise<JsonValue | null | void>;
  onProgressRequested?: (run: AcceptedTriggerRunRecord) => void | Promise<void>;
  onWorkflowRunStarted?: (run: AcceptedTriggerRunRecord) => Promise<JsonValue | null | void>;
  onWorkflowRunTerminal?: (run: TriggerRunRecord) => Promise<JsonValue | null | void>;
  timeline?: RunTimeline;
  timelineReconciler?: RunTimelineReconciler;
  logger?: Pick<Logger, "warn" | "error">;
  /** Backoff timing for transient database failures. Tests inject `sleep` and `random`. */
  retry?: RetryRuntime;
}

export class DurableWorkflowEngine {
  private readonly logger: Pick<Logger, "warn" | "error">;
  private readonly leaseMs: number;
  private readonly terminalNotificationHoldMs: number;
  private readonly terminalNotificationStopGraceMs: number;
  private readonly abandonedTerminalNotifications = new Set<Promise<void>>();
  private readonly workerIntervalMs: number;
  private readonly now: () => Date;
  private readonly scripts: ScriptStepRuntime | undefined;
  private readonly background = new Set<Promise<void>>();
  private workerTimer: NodeJS.Timeout | undefined;
  private processing: Promise<void> | undefined;
  private terminalNotificationProcessing: Promise<void> | undefined;
  private terminalNotificationLease: TerminalNotificationLease | undefined;
  private terminalNotificationRecoveryRequested = false;
  private stopped = false;

  constructor(private readonly options: DurableWorkflowEngineOptions) {
    this.logger = options.logger ?? defaultLogger;
    this.leaseMs = options.leaseMs ?? DEFAULT_WAKEUP_LEASE_MS;
    this.terminalNotificationHoldMs =
      options.terminalNotificationHoldMs ?? DEFAULT_TERMINAL_NOTIFICATION_HOLD_MS;
    this.terminalNotificationStopGraceMs =
      options.terminalNotificationStopGraceMs ?? DEFAULT_TERMINAL_NOTIFICATION_STOP_GRACE_MS;
    this.workerIntervalMs = options.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.scripts =
      options.database === null ? undefined : this.createScriptRuntime(options.database);
  }

  private requireScriptRuntime(): ScriptStepRuntime {
    const scripts = this.scripts;
    if (scripts === undefined) {
      throw new Error("workflow engine invariant: script runtime is not configured");
    }
    return scripts;
  }

  private createScriptRuntime(database: Database): ScriptStepRuntime {
    return new ScriptStepRuntime({
      database,
      runner: this.options.scriptRunner,
      providers: this.options.providers ?? [],
      limits: this.options.scriptLimits ?? DEFAULT_SCRIPT_LIMITS,
      retry: this.options.retry,
      ...(this.options.timeline === undefined ? {} : { timeline: this.options.timeline }),
      now: () => this.now(),
      canDispatchToDaemon: this.options.canDispatchToDaemon,
      report: (error, operation, diagnostic) => this.report(error, operation, diagnostic),
      failRun: async (triggerRunId, reason, stepId) => {
        const failed = await database.failWorkflowRun(triggerRunId, "failed", reason, stepId);
        if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
        await database.deleteWorkflowWakeup(triggerRunId);
      },
      notifyStarted: async (triggerRunId) => {
        const started = await database.findTriggerRunById(triggerRunId);
        if (started?.outcome === "accepted") await this.deliverWorkflowRunStarted(started);
      },
    });
  }

  start(): void {
    this.stopped = false;
    if (this.workerTimer !== undefined) return;
    this.workerTimer = setInterval(() => this.startProcessing(), this.workerIntervalMs);
    this.workerTimer.unref();
    this.startProcessing();
  }

  private startProcessing(): void {
    void this.processAvailable().catch((error: unknown) => {
      this.report(error, "workflow.worker.recover");
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.terminalNotificationLease?.stop();
    if (this.workerTimer !== undefined) clearInterval(this.workerTimer);
    this.workerTimer = undefined;
    await this.processing;
    await this.scripts?.stop();
    await Promise.all(this.background);
    await this.awaitTerminalNotificationsOnStop();
  }

  private async awaitTerminalNotificationsOnStop(): Promise<void> {
    const processing = this.terminalNotificationProcessing;
    if (processing === undefined) return;
    if (await settlesWithin(processing, this.terminalNotificationStopGraceMs)) return;
    this.report(
      new Error("Terminal notification handler still running at engine stop; abandoning it"),
      "workflow.notification.terminal.stop_grace",
      { abandonedPending: this.abandonedTerminalNotifications.size },
    );
  }

  /**
   * Stops script terminals left behind on a daemon: the ones a pending record names, and any
   * other script terminal in those directories that no running step owns. Call it when the
   * daemon connects.
   */
  sweepScriptTerminals(daemonId: string): Promise<void> {
    return this.scripts?.sweep(daemonId) ?? Promise.resolve();
  }

  private runInBackground(work: Promise<void>, operation: string): Promise<void> {
    const tracked = work
      .catch((error: unknown) => this.report(error, operation))
      .finally(() => this.background.delete(tracked));
    this.background.add(tracked);
    return tracked;
  }

  async stopRun(
    actor: RunStopActor,
    runId: string,
    confirmedPeerCount?: number,
    retryAttemptId?: string,
  ): Promise<StopRunResult> {
    const database = this.options.database;
    if (database === null) throw new DatabaseUnavailableError();
    const existing = await database.findTriggerRunForOrganization(actor.organizationId, runId);
    if (existing === undefined) return { status: "run_not_found" };
    if (!canStopRun(actor, existing)) return { status: "forbidden" };
    const cancellation = await database.cancelTriggerRun(
      actor.organizationId,
      runId,
      actor.userId,
      confirmedPeerCount,
      retryAttemptId,
    );
    if (cancellation === undefined) return { status: "run_not_found" };
    if (cancellation.conflict !== undefined)
      return { status: "conflict", otherAttachedRunCount: cancellation.conflict };
    return this.finishRunStop(database, actor, runId, cancellation);
  }

  private async finishRunStop(
    database: Database,
    actor: RunStopActor,
    runId: string,
    cancellation: RunCancellation,
  ): Promise<StopRunResult> {
    if (cancellation.transitioned) {
      await this.notifyWorkflowRunTerminal(cancellation.run);
      await this.stopCanceledExecutions(runId, cancellation);
    } else if (cancellation.executionIds.length > 0) {
      await this.runInBackground(
        this.options.onWorkflowExecutionsTerminal?.(cancellation.executionIds, true) ??
          Promise.resolve(),
        "workflow.agent.stop",
      );
    }
    return this.readStoppedRunResult(database, actor, runId, cancellation);
  }

  private async readStoppedRunResult(
    database: Database,
    actor: RunStopActor,
    runId: string,
    cancellation: RunCancellation,
  ): Promise<StopRunResult> {
    const runStatus = cancellation.run.status;
    const details =
      runStatus === "canceled"
        ? await database.readRunStopDetails(actor.organizationId, runId)
        : undefined;
    return {
      status: "stopped",
      runId,
      runStatus,
      cleanupState: details?.cleanupState ?? "not_needed",
      ...(details?.cleanupState === "confirmed" && details.coalesced
        ? { coalesced: true as const }
        : {}),
    };
  }

  private stopCanceledExecutions(runId: string, cancellation: RunCancellation) {
    return Promise.all([
      this.runInBackground(
        this.scripts?.stopRun(runId) ?? Promise.resolve(),
        "workflow.script.stop",
      ),
      this.runInBackground(
        this.options.onWorkflowExecutionsTerminal?.(cancellation.executionIds) ?? Promise.resolve(),
        "workflow.agent.stop",
      ),
    ]);
  }

  async enqueue(trigger: DurableProviderEvent): Promise<TriggerDispatchOutcome> {
    const database = this.options.database;
    if (database === null) throw new DatabaseUnavailableError();
    const receiptMarked = async () => {
      const receipt = await database.findProviderEventReplayMetadata(trigger.organizationId, {
        id: trigger.providerEventReceiptId,
      });
      return receipt?.payloadExpiryState != null;
    };
    const replay = {
      providerEventReceiptId: trigger.providerEventReceiptId,
      replayed: true,
    } as const;
    if (await receiptMarked()) return replay;
    const selection = await collectProviderMatches(
      this.options.providers ?? [],
      trigger,
      receiptMarked,
    );
    if (selection === null) return replay;
    const { matches, dropReason } = selection;
    if (matches.length === 0) return this.dropProviderEvent(database, trigger, dropReason);
    const createdAt = this.now();
    const replays = await Promise.all(
      matches.map((match) => this.createMatchedRun(database, trigger, match, createdAt)),
    );
    if (replays.some(Boolean))
      return { providerEventReceiptId: trigger.providerEventReceiptId, replayed: true };
    logProviderEventRouting({
      source: trigger.source,
      deliveryId: trigger.deliveryId,
      receiptId: trigger.providerEventReceiptId,
      projectId: trigger.projectId,
      triggerNames: matches.map((match) => match.triggerName),
      acceptedCount: matches.filter(isAcceptedTriggerProviderMatch).length,
      rejectedCount: matches.filter((match) => match.invocation.status === "rejected").length,
    });
    return { providerEventReceiptId: trigger.providerEventReceiptId };
  }

  private async dropProviderEvent(
    database: Database,
    trigger: DurableProviderEvent,
    dropReason: ProviderEventDropReasonCode,
  ): Promise<TriggerDispatchOutcome> {
    const dropped = await database.markProviderEventDropped(
      trigger.providerEventReceiptId,
      dropReason,
      trigger.organizationId,
    );
    if (!dropped) return { providerEventReceiptId: trigger.providerEventReceiptId, replayed: true };
    logProviderEventRouting({
      source: trigger.source,
      deliveryId: trigger.deliveryId,
      receiptId: trigger.providerEventReceiptId,
      projectId: trigger.projectId,
      triggerNames: [],
      acceptedCount: 0,
      rejectedCount: 0,
      dropReason,
    });
    return { providerEventReceiptId: trigger.providerEventReceiptId };
  }

  private async createMatchedRun(
    database: Database,
    trigger: DurableProviderEvent,
    match: TriggerProviderMatch,
    createdAt: Date,
  ): Promise<boolean> {
    const configurationRevisionId =
      match.configurationRevisionId ?? this.options.configurationRevisionId;
    if (configurationRevisionId === undefined)
      throw new Error("workflow_configuration_revision_required");
    if (match.invocation.status === "rejected") {
      const rejected = await database.createRejectedTriggerRun(
        {
          organizationId: trigger.organizationId,
          projectId: trigger.projectId,
          configurationRevisionId,
          providerEventReceiptId: trigger.providerEventReceiptId,
          configuredTriggerName: match.triggerName,
          prompt: match.invocation.prompt,
          inputs: match.invocation.inputs,
          triggerContext: match.triggerContext,
          outputContext: match.outputContext,
          rejection: match.invocation.rejection,
          createdAt,
        },
        "acknowledge",
      );
      return "receiptReplay" in rejected;
    }
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("accepted workflow match required");
    return this.createAcceptedMatchRun(database, trigger, match, {
      configurationRevisionId,
      createdAt,
    });
  }

  private async createAcceptedMatchRun(
    database: Database,
    trigger: DurableProviderEvent,
    acceptedMatch: AcceptedTriggerProviderMatch,
    timing: { configurationRevisionId: string; createdAt: Date },
  ): Promise<boolean> {
    const { configurationRevisionId, createdAt } = timing;
    const configuration = asProjectConfiguration(parseCompiledHubConfig(acceptedMatch.hubConfig));
    const compiledTrigger = configuration.triggers.find(
      (candidate) => candidate.name === acceptedMatch.triggerName,
    );
    if (compiledTrigger === undefined)
      throw new Error(`compiled trigger not found: ${acceptedMatch.triggerName}`);
    const runDeadline = new Date(createdAt.getTime() + compiledTrigger.maxRuntimeMs);
    // Accepting a trigger reserves nothing: a trigger can skip every step, and multi-step
    // workflows create several executions. Metering happens per execution, at creation time
    // (see processWakeup), so the meter is genuinely per-execution and atomic with the work.
    const created = await database.createAcceptedTriggerRun(
      {
        organizationId: trigger.organizationId,
        projectId: trigger.projectId,
        configurationRevisionId,
        providerEventReceiptId: trigger.providerEventReceiptId,
        configuredTriggerName: acceptedMatch.triggerName,
        prompt: acceptedMatch.invocation.prompt,
        inputs: acceptedMatch.invocation.inputs,
        triggerContext: acceptedMatch.triggerContext,
        outputContext: acceptedMatch.outputContext,
        ...(compiledTrigger.replyMessage === true ? { replyMessage: true } : {}),
        conversation: acceptedMatch.conversation,
        deadlineAt: runDeadline,
        stepIds: compiledTrigger.steps.map((step) => step.id),
        createdAt,
      },
      "acknowledge",
    );
    if (!created.created) return "receiptReplay" in created;
    if (compiledTrigger.progressMessage === true) {
      try {
        await this.options.onProgressRequested?.(created.run);
      } catch {
        this.logger.warn({ triggerRunId: created.run.id }, "could not request run progress");
      }
    }
    await this.deliverWorkflowRunAccepted(created.run);
    return false;
  }

  async processAvailable(): Promise<void> {
    if (this.options.database === null || this.stopped) return;
    if (this.processing !== undefined) return this.processing;
    this.processing = this.processAvailableImpl().finally(() => {
      this.processing = undefined;
    });
    return this.processing;
  }

  private async processAvailableImpl(): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    await this.recoverWorkflowDeadlines(this.now());
    this.kickTerminalNotificationRecovery();
    this.scripts?.sweepIfDue();
    await database.recoverWorkflowWakeups(this.now(), this.scripts?.activeRunIds());
    const visited: string[] = [];
    while (!this.stopped) {
      const wakeup = await database.claimWorkflowWakeup(this.now(), this.leaseMs, visited);
      if (wakeup === undefined) return;
      try {
        if ((await this.processWakeupWithRetry(wakeup)) === "deferred") {
          visited.push(wakeup.triggerRunId);
        }
      } catch (error) {
        this.report(error, "workflow.wakeup.process", {
          triggerRunId: wakeup.triggerRunId,
          ...retryDiagnostic(error),
        });
      }
    }
  }

  /**
   * A pool timeout, a reset connection or a deadlock says nothing about the run, so the wakeup is
   * tried again with backoff. Each attempt after the first runs as a reclaimed lease does:
   * a step whose execution was created but never handed to a daemon is dispatched again, which
   * the durable execution id makes safe. Once the attempts are used up the error goes to the
   * caller, the wakeup stays leased, and the next lease expiry picks it up.
   */
  private processWakeupWithRetry(wakeup: WorkflowWakeupRecord): Promise<"deferred" | void> {
    return retryWithBackoff(
      (attempt) =>
        this.processWakeup(attempt === 1 ? wakeup : { ...wakeup, leasedBeforeClaim: true }),
      {
        ...this.options.retry,
        isRetryable: (error) => !this.stopped && isTransientDatabaseError(error),
        onRetry: ({ attempt, delayMs }) => {
          this.logger.warn(
            { triggerRunId: wakeup.triggerRunId, attempt, delayMs: Math.round(delayMs) },
            "workflow wakeup hit a transient database error and will be retried",
          );
        },
      },
    );
  }

  private async processWakeup(wakeup: WorkflowWakeupRecord): Promise<"deferred" | void> {
    const database = this.options.database;
    if (database === null) return;
    const prepared = await this.prepareUnlessScriptActive(wakeup);
    if (prepared === undefined || prepared === "deferred") return prepared;
    const {
      run,
      configuration,
      triggerName,
      trigger,
      steps,
      next,
      step,
      context,
      recoverPreHandoffDispatch,
    } = prepared;
    let shouldRun = true;
    try {
      shouldRun =
        step.condition === undefined || truthy(evaluateExpression(step.condition, context));
    } catch (error) {
      return this.failStepCondition(database, run, step, error);
    }
    if (!(await this.recordRunValues(run, trigger.values, step.id, context))) return;
    if (!shouldRun) {
      await database.markWorkflowStepSkipped(run.id, step.id, "condition_false");
      return;
    }
    if (isScriptStep(step)) return this.startScriptStep(prepared, step, wakeup);
    return this.processAgentStep(database, wakeup, {
      run,
      configuration,
      triggerName,
      trigger,
      steps,
      next,
      step,
      context,
      recoverPreHandoffDispatch,
    });
  }

  private async failStepCondition(
    database: Database,
    run: AcceptedWorkflowRun,
    step: PreparedWorkflowWakeup["step"],
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : "workflow_condition_evaluation_failed";
    this.report(error, "workflow.condition.evaluate", { triggerRunId: run.id, stepId: step.id });
    const failed = await database.failWorkflowRun(run.id, "failed", reason, step.id);
    if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
  }

  private async processAgentStep(
    database: Database,
    wakeup: WorkflowWakeupRecord,
    prepared: AgentWakeup,
  ): Promise<"deferred" | void> {
    const { configuration, triggerName, trigger, run, step, context, next } = prepared;
    const startedAt = this.now();
    const deadlineAt = new Date(
      Math.min(run.deadlineAt.getTime(), startedAt.getTime() + step.maxRuntimeMs),
    );
    const idleDeadlineAt = new Date(
      Math.min(
        run.deadlineAt.getTime(),
        deadlineAt.getTime(),
        startedAt.getTime() + step.idleTimeoutMs,
      ),
    );
    const preparedIntent = await this.buildMaterializedStepIntentOrFail({
      configuration,
      triggerName,
      trigger,
      step,
      run,
      context,
      stepRunId: next.id,
      deadlineAt,
    });
    if (preparedIntent === undefined) return;
    const { executionId, intent } = preparedIntent;
    if (await this.deferUnavailableDispatch(intent, wakeup)) return "deferred";
    if (await this.failInvalidLaunchIntent(database, run, step, intent)) return;
    const reservation = await this.reserveExecution(run.organizationId);
    const created = await database.createWorkflowStepExecution({
      triggerRunId: run.id,
      stepId: step.id,
      ordinal: next.ordinal,
      executionId,
      execution: {
        id: executionId,
        organizationId: run.organizationId,
        projectId: run.projectId,
        machineId: null,
        daemonId: null,
        triggerContext: run.triggerContext,
        outputContext: run.outputContext,
        configurationRevisionId: run.configurationRevisionId,
        deadlineAt,
        idleDeadlineAt,
        startedAt,
        workflowStepRunId: next.id,
        launchIntent: intent,
      },
      reservation,
    });
    return this.finishAgentStepCreation(database, prepared, created, intent);
  }

  private async finishAgentStepCreation(
    database: Database,
    prepared: AgentWakeup,
    created: CreatedWorkflowExecution,
    intent: LaunchMachineIntent,
  ): Promise<void> {
    const { run, step, steps, next, recoverPreHandoffDispatch } = prepared;
    if (await this.failDeniedReservation(database, run, step, created.reservationDenied)) return;
    if (created.execution === undefined) {
      await database.deleteWorkflowWakeup(run.id);
      return;
    }
    await this.linkWorkflowStepAndNotifyStart({
      database,
      triggerRunId: run.id,
      steps,
      stepRunId: next.id,
      executionId: created.execution.id,
      intent,
    });
    if (!created.created) {
      await this.handleExistingWorkflowExecution(
        created.execution,
        next.id,
        recoverPreHandoffDispatch,
      );
      await database.deleteWorkflowWakeup(run.id);
      return;
    }
    await this.dispatchWorkflowExecution(intent, created.execution.id, next.id);
    await database.deleteWorkflowWakeup(run.id);
  }

  /** Stores the routing values composed so far. Fails the run, and says so, when they cannot be. */
  private async recordRunValues(
    run: AcceptedWorkflowRun,
    values: Readonly<Record<string, Expression>>,
    stepId: string,
    context: ExpressionContext,
  ): Promise<boolean> {
    const database = this.options.database;
    try {
      const composedValues = composeValuesIfAvailable(values, context);
      if (composedValues !== undefined) {
        await requireWorkflowDatabase(database).updateTriggerRunValues(run.id, composedValues);
      }
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "workflow_value_evaluation_failed";
      this.report(error, "workflow.values.evaluate", { triggerRunId: run.id, stepId });
      const failed = await requireWorkflowDatabase(database).failWorkflowRun(
        run.id,
        "failed",
        reason,
        stepId,
      );
      if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
      return false;
    }
  }

  private async dispatchWorkflowExecution(
    intent: LaunchMachineIntent,
    expectedExecutionId: string,
    stepRunId: string,
  ): Promise<void> {
    const result = await this.dispatch(intent);
    const execution = await this.executionFromResult(result, intent, stepRunId);
    if (execution.id !== expectedExecutionId) {
      throw new Error(`durable dispatch returned a different execution: ${execution.id}`);
    }
    await this.finishPersistedExecution(execution);
  }

  private async deferUnavailableDispatch(
    intent: LaunchMachineIntent,
    wakeup: WorkflowWakeupRecord,
  ): Promise<boolean> {
    if (this.options.canDispatchToDaemon?.(intent.environment.daemonId) !== false) return false;
    await requireWorkflowDatabase(this.options.database).releaseWorkflowWakeup(
      wakeup.triggerRunId,
      this.now(),
      requireWakeupLease(wakeup.leaseExpiresAt),
    );
    return true;
  }

  private async linkWorkflowStepAndNotifyStart(options: LinkWorkflowStepOptions): Promise<void> {
    const { database, triggerRunId, steps, stepRunId, executionId, intent } = options;
    const startedStep = await database.linkWorkflowStepRunExecution(stepRunId, executionId, intent);
    try {
      this.options.timeline?.recordStepStart(
        {
          organizationId: intent.organizationId,
          triggerRunId,
        },
        startedStep.stepId,
      );
    } catch (error) {
      this.report(error, "run.timeline.capture", { triggerRunId });
    }
    if (steps.some((candidate) => candidate.startedAt !== null)) return;
    const started = await database.findTriggerRunById(triggerRunId);
    if (started?.outcome === "accepted") await this.deliverWorkflowRunStarted(started);
  }

  /**
   * Fail the run when execution creation was denied by the meter. The denial is the same typed
   * `EntitlementDenied` every other boundary produces, so a metered failure stays distinct from
   * a crash on the run's failure reason. Returns true when it handled a denial.
   */
  private async failDeniedReservation(
    database: Database,
    run: AcceptedWorkflowRun,
    step: CompiledAgentStep,
    denied: MeterReservationDenied | undefined,
  ): Promise<boolean> {
    if (denied === undefined) return false;
    const error = new EntitlementDenied(
      "executions.monthly",
      "meter",
      denied.limit,
      denied.current,
    );
    // Store the machine-parseable denial, not the human message: the run UI decodes this back
    // into a typed payload rather than pattern-matching a sentence. See src/entitlements/denial.ts.
    const failureReason = encodeEntitlementDenialFailureReason(error.payload());
    const failed = await database.failWorkflowRun(run.id, "failed", failureReason, step.id);
    if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
    await database.deleteWorkflowWakeup(run.id);
    return true;
  }

  /**
   * The meter reservation to attach to the next execution creation. Entitlements is required
   * whenever a database is wired, so a null here is a composition bug, not a skipped meter.
   */
  private async reserveExecution(organizationId: string): Promise<MeterReservation> {
    const entitlements = this.options.entitlements;
    if (entitlements === null) {
      throw new Error("durable workflow engine requires entitlements when a database is wired");
    }
    return entitlements.meterReservation(organizationId, "executions.monthly");
  }

  private async handleExistingWorkflowExecution(
    execution: AgentExecutionRecord,
    stepRunId: string,
    recoverPreHandoffDispatch: boolean,
  ): Promise<void> {
    if (!recoverPreHandoffDispatch || !isRecoverablePreHandoffExecution(execution)) {
      await this.finishPersistedExecution(execution);
      return;
    }
    const persistedIntent = execution.launchIntent;
    if (persistedIntent === null) {
      throw new Error(`workflow execution missing persisted launch intent: ${execution.id}`);
    }
    await this.dispatchWorkflowExecution(persistedIntent, execution.id, stepRunId);
  }

  private async startScriptStep(
    prepared: PreparedWorkflowWakeup,
    step: CompiledScriptStep,
    wakeup: WorkflowWakeupRecord,
  ): Promise<"deferred" | undefined> {
    const launch = await this.scriptLaunch(prepared, step, prepared.next);
    if (launch === undefined) return undefined;
    return this.requireScriptRuntime().start(launch, wakeup);
  }

  /** The daemon and directory a script step runs in, or the run failed when they are unavailable. */
  private async scriptLaunch(
    prepared: Pick<PreparedWorkflowWakeup, "run" | "configuration" | "context" | "steps">,
    step: CompiledScriptStep,
    stepRun: WorkflowStepRun,
  ): Promise<ScriptStepLaunch | undefined> {
    const database = this.options.database;
    const { run, configuration, context, steps } = prepared;
    try {
      const environmentName = authorityString(
        renderExpressionTemplate(step.environment, context),
        "environment",
      );
      const environment = configuration.environments.find(
        (candidate) => candidate.name === environmentName,
      );
      if (
        environment === undefined ||
        environment.kind !== "daemon" ||
        environment.daemonId === undefined
      ) {
        throw new Error(`workflow environment ${environmentName} is unavailable`);
      }
      return {
        run,
        step,
        stepRun,
        daemonId: environment.daemonId,
        cwd: environment.cwd,
        runAlreadyStarted: steps.some((candidate) => candidate.startedAt !== null),
      };
    } catch (error) {
      this.report(error, "workflow.script.environment", { triggerRunId: run.id, stepId: step.id });
      const failed = await requireWorkflowDatabase(database).failWorkflowRun(
        run.id,
        "failed",
        error instanceof Error ? error.message : "workflow_environment_unavailable",
        step.id,
      );
      if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
      return undefined;
    }
  }

  /** A script step still marked running that this process is not watching was left by a dead Hub. */
  private async recoverRunningScripts(
    prepared: Pick<PreparedWorkflowWakeup, "run" | "configuration" | "context" | "steps">,
    trigger: CompiledProjectConfiguration["triggers"][number],
    wakeup: WorkflowWakeupRecord,
  ): Promise<"deferred" | "handled" | undefined> {
    for (const stepRun of prepared.steps) {
      const step = trigger.steps[stepRun.ordinal];
      if (stepRun.status !== "running" || step === undefined || !isScriptStep(step)) continue;
      const launch = await this.scriptLaunch(prepared, step, stepRun);
      if (launch === undefined) return "handled";
      return (await this.requireScriptRuntime().recoverOrphan(launch, wakeup)) ?? "handled";
    }
    return undefined;
  }

  /** A running script is watched by this process; the wakeup the clock keeps adding is noise. */
  private async prepareUnlessScriptActive(
    wakeup: WorkflowWakeupRecord,
  ): Promise<PreparedWorkflowWakeup | "deferred" | undefined> {
    if (this.scripts?.isActive(wakeup.triggerRunId) === true) {
      await requireWorkflowDatabase(this.options.database).deleteWorkflowWakeup(
        wakeup.triggerRunId,
      );
      return undefined;
    }
    return this.prepareWorkflowWakeup(wakeup);
  }

  private async prepareWorkflowWakeup(
    wakeup: WorkflowWakeupRecord,
  ): Promise<PreparedWorkflowWakeup | "deferred" | undefined> {
    const database = this.options.database;
    if (database === null) return undefined;
    const triggerRunId = wakeup.triggerRunId;
    const run = await database.findTriggerRunById(triggerRunId);
    if (run === undefined || run.status !== "running" || run.outcome !== "accepted") {
      await database.deleteWorkflowWakeup(triggerRunId);
      return undefined;
    }
    if (run.deadlineAt <= this.now()) {
      await this.recoverWorkflowDeadlines(this.now());
      await database.deleteWorkflowWakeup(triggerRunId);
      return undefined;
    }
    const { configuration, triggerName } = await this.configurationForRun(run);
    const trigger = configuration.triggers.find(
      (candidate) => candidate.name === run.configuredTriggerName,
    );
    if (trigger === undefined)
      throw new Error(`workflow trigger not found: ${run.configuredTriggerName}`);
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    if (steps.length !== trigger.steps.length)
      throw new Error(`workflow steps missing for ${run.id}`);

    const recoveredTerminalRun = await this.reconcileTerminalStepExecutions(steps);
    if (recoveredTerminalRun !== undefined) {
      await this.notifyWorkflowRunTerminal(recoveredTerminalRun);
    }
    return this.prepareReconciledWakeup(database, wakeup, run, {
      configuration,
      triggerName,
      trigger,
    });
  }

  private async prepareReconciledWakeup(
    database: Database,
    wakeup: WorkflowWakeupRecord,
    run: AcceptedWorkflowRun,
    preparation: WorkflowPreparation,
  ): Promise<PreparedWorkflowWakeup | "deferred" | undefined> {
    const { configuration, triggerName, trigger } = preparation;
    const reconciledRun = await database.findTriggerRunById(run.id);
    if (reconciledRun === undefined || reconciledRun.status !== "running") {
      await database.deleteWorkflowWakeup(run.id);
      return undefined;
    }
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    if (await this.failTerminalWorkflowStep(run.id, steps)) return undefined;
    const liveExecution = await this.findLiveExecution(steps);
    if (liveExecution !== undefined) {
      await database.deleteWorkflowWakeup(run.id);
      return undefined;
    }
    const context = workflowContext(reconciledRun, steps, trigger.values);
    const recovered = await this.recoverRunningScripts(
      { run: reconciledRun, configuration, context, steps },
      trigger,
      wakeup,
    );
    if (recovered !== undefined) return recovered === "deferred" ? "deferred" : undefined;
    return this.selectPendingWorkflowStep(wakeup, {
      run: reconciledRun,
      configuration,
      triggerName,
      trigger,
      steps,
      context,
    });
  }

  private async selectPendingWorkflowStep(
    wakeup: WorkflowWakeupRecord,
    pending: PendingWorkflowStep,
  ): Promise<PreparedWorkflowWakeup | undefined> {
    const { run: reconciledRun, trigger, steps } = pending;
    const recoverPreHandoffDispatch = wakeup.leasedBeforeClaim;
    const next =
      (recoverPreHandoffDispatch ? await this.findRecoverablePreHandoffStep(steps) : undefined) ??
      steps.find((candidate) => candidate.status === "pending");
    if (next === undefined) {
      await this.finishWorkflowRunIfComplete(reconciledRun, steps, trigger);
      return undefined;
    }
    const step = trigger.steps[next.ordinal];
    if (step === undefined) throw new Error(`compiled step missing for ${next.stepId}`);
    return {
      ...pending,
      next,
      step,
      recoverPreHandoffDispatch,
    };
  }

  private async buildStepIntentOrFail(
    options: StepIntentOptions,
  ): Promise<LaunchMachineIntent | undefined> {
    const { run, step } = options;
    const database = this.options.database;
    if (database === null) return undefined;
    try {
      return buildStepIntent(options);
    } catch (error) {
      if (!(error instanceof ExpressionEvaluationError)) throw error;
      this.report(error, "workflow.launch-expression.evaluate", {
        triggerRunId: run.id,
        stepId: step.id,
      });
      const failed = await database.failWorkflowRun(run.id, "failed", error.message, step.id);
      if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
      return undefined;
    }
  }

  private async materializeStepContextOrFail(
    run: AcceptedWorkflowRun,
    step: CompiledAgentStep,
    executionId: string,
  ): Promise<JsonValue | undefined> {
    if (!stepUsesTriggerContext(step)) return null;
    const provider = providerForTriggerContext(this.options.providers ?? [], run.triggerContext);
    if (provider?.materializeContext === undefined) {
      return this.failStepContext(run, step, TRIGGER_CONTEXT_MATERIALIZER_UNAVAILABLE_REASON);
    }
    try {
      return asTriggerContextValue(
        await provider.materializeContext({
          executionId,
          organizationId: run.organizationId,
          projectId: run.projectId,
          providerEventReceiptId: run.providerEventReceiptId,
          triggerContext: run.triggerContext,
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : TRIGGER_CONTEXT_UNAVAILABLE_REASON;
      this.report(error, "workflow.context.materialize", {
        triggerRunId: run.id,
        stepId: step.id,
        executionId,
      });
      return this.failStepContext(run, step, reason);
    }
  }

  private async failStepContext(
    run: AcceptedWorkflowRun,
    step: CompiledAgentStep,
    reason: string,
  ): Promise<undefined> {
    const failed = await requireWorkflowDatabase(this.options.database).failWorkflowRun(
      run.id,
      "failed",
      reason,
      step.id,
    );
    if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
    return undefined;
  }

  private async buildMaterializedStepIntentOrFail(
    options: MaterializedStepIntentOptions,
  ): Promise<{ executionId: string; intent: LaunchMachineIntent } | undefined> {
    const { configuration, triggerName, trigger, step, run, context, stepRunId, deadlineAt } =
      options;
    const existing = await this.options.database?.findAgentExecutionByWorkflowStepRunId(stepRunId);
    if (existing?.launchIntent !== null && existing?.launchIntent !== undefined) {
      return { executionId: existing.id, intent: existing.launchIntent };
    }
    const executionId = durableExecutionId({
      triggerRunId: run.id,
      configurationRevisionId: run.configurationRevisionId,
      triggerName,
      workflowStepRunId: stepRunId,
    });
    const materializedContext = await this.materializeStepContextOrFail(run, step, executionId);
    if (materializedContext === undefined) return undefined;
    const intent = await this.buildStepIntentOrFail({
      configuration,
      triggerName,
      trigger,
      step,
      run,
      context: { ...context, context: materializedContext },
      stepRunId,
      deadlineAt,
      executionId,
    });
    if (intent === undefined) return undefined;
    if (durableExecutionId(intent) !== executionId) {
      throw new Error("workflow execution identity changed during context materialization");
    }
    return { executionId, intent };
  }

  private async failInvalidLaunchIntent(
    database: Database,
    run: AcceptedWorkflowRun,
    step: CompiledAgentStep,
    intent: LaunchMachineIntent,
  ): Promise<boolean> {
    try {
      this.options.validateLaunchMachineIntent?.(intent);
      return false;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "required output capability unavailable";
      this.report(error, "workflow.launch-intent.validate", {
        triggerRunId: run.id,
        stepId: step.id,
      });
      const failed = await database.failWorkflowRun(run.id, "failed", reason, step.id);
      if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
      return true;
    }
  }

  private async finishWorkflowRunIfComplete(
    run: AcceptedWorkflowRun,
    steps: readonly WorkflowStepRun[],
    trigger: CompiledProjectConfiguration["triggers"][number],
  ): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    try {
      await database.updateTriggerRunValues(
        run.id,
        composeValues(trigger.values, workflowContext(run, steps, trigger.values)),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "workflow_value_evaluation_failed";
      this.report(error, "workflow.final-values.evaluate", { triggerRunId: run.id });
      const failed = await database.failWorkflowRun(run.id, "failed", reason);
      if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
      return;
    }
    const succeeded = await database.succeedTriggerRun(run.id);
    if (succeeded?.transitioned === true) await this.notifyWorkflowRunTerminal(succeeded.run);
  }

  private async recoverWorkflowDeadlines(now: Date): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    for (const recovery of await database.recoverWorkflowDeadlines(now)) {
      if (this.options.onWorkflowDeadlineExceeded !== undefined) {
        await this.options.onWorkflowDeadlineExceeded(recovery);
      }
      // The database ended the run's steps; a script's terminal on the host is still running.
      if (this.scripts !== undefined) {
        void this.runInBackground(
          this.scripts.cleanupEndedRun(recovery.triggerRunId),
          "workflow.script.deadline-cleanup",
        );
      }
      const run = await database.findTriggerRunById(recovery.triggerRunId);
      if (run?.outcome === "accepted" && run.status !== "running") {
        await this.notifyWorkflowRunTerminal(run);
      }
    }
  }

  private notifyWorkflowRunTerminal(run: TriggerRunRecord): Promise<void> {
    if (run.outcome !== "accepted" || run.status === "running") return Promise.resolve();
    this.kickTerminalNotificationRecovery();
    return Promise.resolve();
  }

  private async deliverWorkflowRunAccepted(run: AcceptedTriggerRunRecord): Promise<void> {
    const callback = this.options.onWorkflowRunAccepted;
    if (callback === undefined || this.options.database === null) return;
    try {
      const result = await callback(run);
      await this.options.database.setWorkflowRunReactionState(
        run.id,
        result === undefined ? run.reactionState : result,
      );
    } catch (error: unknown) {
      this.report(error, "workflow.reaction.accepted", { triggerRunId: run.id });
    }
  }

  private async deliverWorkflowRunStarted(run: AcceptedTriggerRunRecord): Promise<void> {
    try {
      this.options.timeline?.recordRunStart({
        organizationId: run.organizationId,
        triggerRunId: run.id,
      });
    } catch (error) {
      this.report(error, "run.timeline.capture", { triggerRunId: run.id });
    }
    const callback = this.options.onWorkflowRunStarted;
    if (callback === undefined || this.options.database === null) return;
    try {
      const result = await callback(run);
      await this.options.database.setWorkflowRunReactionState(
        run.id,
        result === undefined ? run.reactionState : result,
      );
    } catch (error: unknown) {
      this.report(error, "workflow.reaction.started", { triggerRunId: run.id });
    }
  }

  private kickTerminalNotificationRecovery(): void {
    if (this.options.database === null || this.stopped) return;
    this.terminalNotificationRecoveryRequested = true;
    if (this.terminalNotificationProcessing !== undefined) return;
    this.terminalNotificationProcessing = this.recoverRequestedWorkflowRunTerminalNotifications()
      .catch((error: unknown) => {
        this.report(error, "workflow.notification.terminal.recover");
      })
      .finally(() => {
        this.terminalNotificationProcessing = undefined;
        if (this.terminalNotificationRecoveryRequested) {
          this.kickTerminalNotificationRecovery();
        }
      });
  }

  private async recoverRequestedWorkflowRunTerminalNotifications(): Promise<void> {
    do {
      this.terminalNotificationRecoveryRequested = false;
      await this.recoverPendingWorkflowRunTerminalNotifications();
    } while (this.terminalNotificationRecoveryRequested && !this.stopped);
  }

  private async recoverPendingWorkflowRunTerminalNotifications(): Promise<void> {
    const database = this.options.database;
    if (database === null) return;
    const abandonedRunIds: string[] = [];
    while (!this.stopped) {
      const claimedAt = this.now();
      const run = await database.claimPendingWorkflowRunTerminalNotification(
        claimedAt,
        Math.min(this.leaseMs, this.terminalNotificationHoldMs),
        abandonedRunIds,
      );
      if (run === undefined) return;
      if (!(await this.processClaimedTerminalNotification(database, run, claimedAt))) {
        abandonedRunIds.push(run.id);
      }
    }
  }

  private async processClaimedTerminalNotification(
    database: Database,
    run: ClaimedTerminalNotification,
    claimedAt: Date,
  ): Promise<boolean> {
    const lease = new TerminalNotificationLease({
      now: this.now,
      leaseMs: this.leaseMs,
      deadline: claimedAt.getTime() + this.terminalNotificationHoldMs,
      renew: (now, leaseMs) =>
        database.renewWorkflowRunTerminalNotification(
          run.id,
          run.terminalNotificationGeneration,
          now,
          leaseMs,
        ),
      report: (error, operation) => this.report(error, operation, { triggerRunId: run.id }),
    });
    this.terminalNotificationLease = lease;
    if (!this.stopped) lease.start();
    const work = this.reconcileAndDeliver(database, run, lease);
    try {
      const settled = await settlesWithin(work, this.terminalNotificationHoldMs);
      if (!settled) this.abandonTerminalNotification(run, claimedAt, work);
      return settled;
    } finally {
      lease.stop();
      this.terminalNotificationLease = undefined;
    }
  }

  private async reconcileAndDeliver(
    database: Database,
    run: ClaimedTerminalNotification,
    lease: TerminalNotificationLease,
  ): Promise<void> {
    await this.options.timelineReconciler?.reconcileBeforeTerminal(run.organizationId, run.id);
    await this.deliverClaimedTerminalNotification(database, run, lease);
  }

  // Provider hooks take no abort signal, so a hung one is left running. A late result is still
  // written under the claim's generation, which a re-claim has already moved on.
  private abandonTerminalNotification(
    run: ClaimedTerminalNotification,
    claimedAt: Date,
    work: Promise<void>,
  ): void {
    const tracked = work
      .catch((error: unknown) =>
        this.report(error, "workflow.notification.terminal.abandoned", { triggerRunId: run.id }),
      )
      .finally(() => this.abandonedTerminalNotifications.delete(tracked));
    this.abandonedTerminalNotifications.add(tracked);
    const abandonedPending = this.abandonedTerminalNotifications.size;
    this.report(
      new Error("Terminal notification handler exceeded its time bound and was abandoned"),
      "workflow.notification.terminal.timeout",
      {
        triggerRunId: run.id,
        provider: providerNameOf(run.triggerContext),
        elapsedMs: this.now().getTime() - claimedAt.getTime(),
        abandonedPending,
      },
    );
    if (abandonedPending >= ABANDONED_TERMINAL_WARN_AT) {
      this.logger.warn(
        { operation: "workflow.notification.terminal.abandoned_backlog", abandonedPending },
        "Abandoned terminal notification handlers are still running",
      );
    }
  }

  private async deliverClaimedTerminalNotification(
    database: Database,
    run: ClaimedTerminalNotification,
    lease: TerminalNotificationLease,
  ): Promise<void> {
    const generation = run.terminalNotificationGeneration;
    try {
      let reactionState: JsonValue | void;
      try {
        const owns = await database.ownsWorkflowRunTerminalNotification(run.id, generation);
        if (!owns || lease.lost) return;
        reactionState = await this.options.onWorkflowRunTerminal?.(run);
      } finally {
        lease.stop();
      }
      const pendingRenewal = lease.pendingRenewal;
      if (pendingRenewal !== undefined) await pendingRenewal;
      if (lease.lost) return;
      await database.markWorkflowRunTerminalNotificationDelivered(
        run.id,
        generation,
        this.now(),
        reactionState === undefined ? terminalReactionState(run) : reactionState,
      );
    } catch (error) {
      this.report(error, "workflow.notification.terminal.deliver", { triggerRunId: run.id });
    }
  }

  private async finishPersistedExecution(
    execution: Pick<AgentExecutionRecord, "id" | "status" | "result">,
  ): Promise<void> {
    if (execution.status !== "succeeded" && execution.status !== "failed") return;
    const database = this.options.database;
    if (database === null) return;
    await database.completeWorkflowStep(
      execution.id,
      execution.status,
      execution.result,
      execution.status === "failed" ? readFailureReason(execution.result) : undefined,
    );
  }

  private report(error: unknown, operation: string, diagnostic?: Record<string, unknown>): void {
    reportFailure(
      error,
      { operation, component: "workflows" },
      { logger: this.logger, ...(diagnostic === undefined ? {} : { diagnostic }) },
    );
  }

  private async findLiveExecution(
    steps: readonly { status: string; agentExecutionId: string | null }[],
  ): Promise<AgentExecutionRecord | undefined> {
    const database = this.options.database;
    if (database === null) return undefined;
    for (const step of steps) {
      if (step.status !== "running" || step.agentExecutionId === null) continue;
      const execution = await database.findAgentExecutionById(step.agentExecutionId);
      if (
        execution !== undefined &&
        (execution.status === "spawning" || execution.status === "running")
      ) {
        if (isRecoverablePreHandoffExecution(execution)) continue;
        return execution;
      }
    }
    return undefined;
  }

  private async findRecoverablePreHandoffStep(
    steps: readonly WorkflowStepRun[],
  ): Promise<WorkflowStepRun | undefined> {
    const database = this.options.database;
    if (database === null) return undefined;
    for (const step of steps) {
      if (step.status !== "running" || step.agentExecutionId === null) continue;
      const execution = await database.findAgentExecutionById(step.agentExecutionId);
      if (execution !== undefined && isRecoverablePreHandoffExecution(execution)) return step;
    }
    return undefined;
  }

  private async reconcileTerminalStepExecutions(
    steps: readonly { status: string; agentExecutionId: string | null }[],
  ): Promise<TriggerRunRecord | undefined> {
    const database = this.options.database;
    if (database === null) return undefined;
    for (const step of steps) {
      if (step.status !== "running" || step.agentExecutionId === null) continue;
      const execution = await database.findAgentExecutionById(step.agentExecutionId);
      if (!isCompletedExecution(execution)) continue;
      const completed = await database.completeWorkflowStep(
        execution.id,
        execution.status === "succeeded" ? "succeeded" : "failed",
        execution.result,
        readFailureReason(execution.result),
      );
      if (completed !== undefined && completed.run.status !== "running") return completed.run;
    }
    return undefined;
  }

  private async failTerminalWorkflowStep(
    triggerRunId: string,
    steps: readonly WorkflowStepRun[],
  ): Promise<boolean> {
    const database = this.options.database;
    if (database === null) return false;
    const terminalFailure = steps.find(
      (candidate) => candidate.status === "failed" || candidate.status === "timed_out",
    );
    if (terminalFailure === undefined) return false;
    const status = terminalFailure.status === "timed_out" ? "timed_out" : "failed";
    const failed = await database.failWorkflowRun(
      triggerRunId,
      status,
      terminalFailure.failureReason ?? `workflow_step_${status}`,
      terminalFailure.stepId,
    );
    if (failed?.transitioned === true) await this.notifyWorkflowRunTerminal(failed.run);
    return true;
  }

  private async configurationForRun(
    run: AcceptedWorkflowRun,
  ): Promise<{ configuration: CompiledProjectConfiguration; triggerName: string }> {
    const database = this.options.database;
    if (database === null) throw new DatabaseUnavailableError();
    const revision = await database.findProjectConfigurationRevision(
      run.projectId,
      run.configurationRevisionId,
    );
    if (revision === undefined)
      throw new Error(`workflow configuration revision not found: ${run.configurationRevisionId}`);
    return {
      configuration: asProjectConfiguration(
        parseCompiledHubConfig(revision.normalizedConfiguration),
      ),
      triggerName: triggerDocumentName(revision) ?? run.configuredTriggerName,
    };
  }

  private async dispatch(intent: LaunchMachineIntent): Promise<unknown> {
    if (this.options.dispatchLaunchMachineIntent !== undefined)
      return this.options.dispatchLaunchMachineIntent(intent);
    throw new Error("no durable workflow dispatch handler registered");
  }

  private async executionFromResult(
    result: unknown,
    intent: LaunchMachineIntent,
    stepRunId: string,
  ): Promise<Pick<AgentExecutionRecord, "id" | "status" | "result">> {
    const candidate = readDispatchExecution(result);
    if (candidate !== undefined) return candidate;
    const database = this.options.database;
    const existing =
      database === null
        ? undefined
        : await database.findAgentExecutionByWorkflowStepRunId(stepRunId);
    if (existing !== undefined) return existing;
    throw new Error(`durable dispatch returned no execution: ${durableExecutionId(intent)}`);
  }
}

function isCompletedExecution(
  execution: AgentExecutionRecord | undefined,
): execution is AgentExecutionRecord & { status: "succeeded" | "failed" } {
  if (execution === undefined) return false;
  return execution.status === "succeeded" || execution.status === "failed";
}

function requireWorkflowDatabase(database: Database | null): Database {
  if (database === null) {
    throw new Error("workflow engine invariant: database is not configured");
  }
  return database;
}

function requireWakeupLease(lease: Date | null): Date {
  if (lease === null) {
    throw new Error("workflow engine invariant: claimed wakeup has no lease");
  }
  return lease;
}

function buildStepIntent(options: StepIntentOptions): LaunchMachineIntent {
  const { configuration, step, context, stepRunId, deadlineAt } = options;
  const { environmentName, environment } = resolveStepEnvironment(configuration, step, context);
  const agent = materializeAgent(step.agent, context);
  return {
    ...buildAgentLaunchIntent(options, environmentName, environment, agent),
    ...buildStepContinuation(options, environment, agent),
    workflowStepRunId: stepRunId,
    ...(step.output === undefined ? {} : { outputSchema: step.output.schema }),
    deadlineAt,
  };
}

function resolveStepEnvironment(
  configuration: CompiledProjectConfiguration,
  step: CompiledAgentStep,
  context: ExpressionContext,
) {
  const environmentName = authorityString(
    renderExpressionTemplate(step.environment, context),
    "environment",
  );
  const environment = configuration.environments.find(
    (candidate) => candidate.name === environmentName,
  );
  if (
    environment === undefined ||
    environment.kind !== "daemon" ||
    environment.daemonId === undefined
  ) {
    throw new Error(`workflow environment ${environmentName} is unavailable`);
  }
  return { environmentName, environment };
}

type StepEnvironment = ReturnType<typeof resolveStepEnvironment>["environment"];
type StepAgent = ReturnType<typeof materializeAgent>;

function buildAgentLaunchIntent(
  options: StepIntentOptions,
  environmentName: string,
  environment: StepEnvironment,
  agent: StepAgent,
) {
  const { run, triggerName, step, executionId, context, trigger, configuration } = options;
  return buildLaunchMachineIntent({
    organizationId: run.organizationId,
    projectId: run.projectId,
    triggerRunId: run.id,
    triggerName,
    environmentName,
    environment: {
      kind: "daemon",
      daemonId: environment.daemonId,
      authoredSlug: environment.daemon,
      cwd: environment.cwd,
      ...(environment.worktree === undefined
        ? {}
        : { worktree: materializeExecutionWorktree(environment.worktree, executionId) }),
    },
    ...(step.env === undefined ? {} : { env: step.env }),
    ...(step.github === undefined ? {} : { github: step.github }),
    ...(step.title === undefined
      ? {}
      : { title: renderExecutionTemplate(step.title, executionId) }),
    prompt: step.prompt
      .map((block) =>
        renderExpressionTemplate(block.kind === "text" ? block.value : block.content, context),
      )
      .join("\n"),
    agent,
    allowOutputs: step.allowOutputs,
    timeoutMs: step.maxRuntimeMs,
    idleTimeoutMs: step.idleTimeoutMs,
    ...(step.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: step.startupTimeoutMs }),
    autoArchive: step.autoArchive,
    background: step.background,
    ...(step.completeOnTurnEnd === true ? { completeOnTurnEnd: true } : {}),
    ...(trigger.replyMessage === true ? { replyMessage: true } : {}),
    triggerContext: run.triggerContext,
    outputContext: run.outputContext,
    configurationRevisionId: run.configurationRevisionId,
    hubConfig: configuration,
  });
}

function buildStepContinuation(
  options: StepIntentOptions,
  environment: StepEnvironment,
  agent: StepAgent,
) {
  const { step, run, context } = options;
  return step.continuation === undefined
    ? {}
    : {
        continuation: {
          key: continuationKey(step.continuation, run.conversation, (value) =>
            renderExpressionTemplate(value, context),
          ),
          compatibility: {
            agent,
            target: environment,
            // Preserve existing visible-session fingerprints when using the default.
            ...(step.background ? { background: true } : {}),
            env: step.env ?? {},
            github: step.github ?? null,
          },
        },
      };
}

function materializeAgent(selection: CompiledAgentStep["agent"], context: ExpressionContext) {
  const agent =
    "selector" in selection
      ? selection.choices[
          authorityString(renderExpressionTemplate(selection.selector, context), "agent")
        ]
      : selection;
  if (agent === undefined) throw new Error("workflow named agent is unavailable");
  return {
    ...agent,
    ...(agent.options === undefined ? {} : { options: structuredClone(agent.options) }),
  };
}

function workflowContext(
  run: Extract<Awaited<ReturnType<Database["findTriggerRunById"]>>, { outcome: "accepted" }>,
  steps: readonly { stepId: string; status: string; output: unknown }[],
  values: Readonly<Record<string, Expression>>,
): ExpressionContext {
  return {
    prompt: run.prompt,
    context: null,
    inputs: inputContext(run.inputs),
    steps: Object.fromEntries(
      steps.map((step) => [step.stepId, { status: step.status, output: step.output }]),
    ),
    values,
  };
}

function stepUsesTriggerContext(step: CompiledAgentStep): boolean {
  return step.prompt.some((block) =>
    expressionPathsInTemplate(block.kind === "text" ? block.value : block.content).some(
      (path) => path.namespace === "paseo" && path.path === "context",
    ),
  );
}

function providerNameOf(triggerContext: unknown): string | undefined {
  if (typeof triggerContext !== "object" || triggerContext === null) return undefined;
  if (!("provider" in triggerContext) || typeof triggerContext.provider !== "string") {
    return undefined;
  }
  return triggerContext.provider;
}

function providerForTriggerContext(
  providers: readonly TriggerProvider[],
  triggerContext: unknown,
): TriggerProvider | undefined {
  const name = providerNameOf(triggerContext);
  return name === undefined ? undefined : providers.find((provider) => provider.name === name);
}

function composeValues(
  values: Readonly<Record<string, Expression>>,
  context: ExpressionContext,
): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(values).map(([name, expression]) => [
      name,
      evaluateExpression(expression, context),
    ]),
  );
}

function composeValuesIfAvailable(
  values: Readonly<Record<string, Expression>>,
  context: ExpressionContext,
): Readonly<Record<string, JsonValue>> | undefined {
  try {
    return composeValues(values, context);
  } catch (error) {
    if (error instanceof ExpressionEvaluationError) return undefined;
    throw error;
  }
}

function isRecoverablePreHandoffExecution(execution: AgentExecutionRecord): boolean {
  return (
    execution.status === "spawning" &&
    execution.launchIntent !== null &&
    execution.machineId === null &&
    execution.daemonId === null &&
    execution.daemonAgentId === null
  );
}

function authorityString(value: string, field: string): string {
  if (value.length === 0) throw new Error(`${field} resolved to an empty authority`);
  return value;
}

function materializeExecutionWorktree(worktree: WorktreeTarget, executionId: string) {
  if (worktree.mode !== "branch-off") return worktree;
  return { ...worktree, newBranch: renderExecutionTemplate(worktree.newBranch, executionId) };
}

function inputContext(value: unknown): Readonly<Record<string, JsonPrimitive>> {
  if (!isRecord(value)) return {};
  const inputs: Record<string, JsonPrimitive> = {};
  for (const [name, input] of Object.entries(value)) {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))
    ) {
      inputs[name] = input;
    }
  }
  return inputs;
}

function asProjectConfiguration(
  configuration: Awaited<ReturnType<typeof parseCompiledHubConfig>>,
): CompiledProjectConfiguration {
  const environments: CompiledProjectConfiguration["environments"] = configuration.environments.map(
    (environment) => {
      if (environment.kind !== "daemon") return environment;
      if (environment.daemonId === undefined)
        throw new Error(`daemon environment ${environment.name} is not activated`);
      return {
        name: environment.name,
        kind: "daemon",
        daemon: environment.daemon,
        daemonId: environment.daemonId,
        cwd: environment.cwd,
        ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
      };
    },
  );
  return { environments, triggers: configuration.triggers };
}

function truthy(value: unknown): boolean {
  return value !== false && value !== null && value !== undefined && value !== 0 && value !== "";
}

function terminalReactionState(run: TriggerRunRecord): JsonValue | null {
  if (run.outcome === "accepted") return run.reactionState;
  return null;
}

async function collectProviderMatches(
  providers: readonly TriggerProvider[],
  trigger: DurableProviderEvent,
  receiptMarked: () => Promise<boolean>,
): Promise<{
  matches: readonly TriggerProviderMatch[];
  dropReason: ProviderEventDropReasonCode;
} | null> {
  if (!isTriggerEventName(trigger.source))
    return { matches: [], dropReason: "no_trigger_for_source" };
  const matchingProviders = providers.filter((provider) =>
    provider.eventNames.some((name) => name === trigger.source),
  );
  if (matchingProviders.length > 0 && (await receiptMarked())) return null;
  const results = await Promise.all(matchingProviders.map((provider) => provider.match(trigger)));
  const matches = results.flatMap((result) => (typeof result === "string" ? [] : result));
  const reasons = results.filter(
    (result): result is ProviderEventDropReasonCode => typeof result === "string",
  );
  return {
    matches,
    dropReason:
      reasons.find((reason) => reason === "configuration_unavailable") ??
      reasons.find((reason) => reason === "trigger_filters_rejected") ??
      "no_trigger_for_source",
  };
}

function readDispatchExecution(
  result: unknown,
): Pick<AgentExecutionRecord, "id" | "status" | "result"> | undefined {
  if (!isRecord(result)) return undefined;
  const direct = readExecutionCandidate(result["execution"]);
  if (direct !== undefined) return direct;
  const executions = result["executions"];
  if (!Array.isArray(executions)) return undefined;
  return readExecutionCandidate(executions[0]);
}

function readExecutionCandidate(
  value: unknown,
): Pick<AgentExecutionRecord, "id" | "status" | "result"> | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") return undefined;
  return { id: value["id"], status: readExecutionStatus(value["status"]), result: value["result"] };
}

function readExecutionStatus(value: unknown): AgentExecutionStatus {
  return value === "running" || value === "succeeded" || value === "failed" ? value : "spawning";
}

function readFailureReason(result: unknown): string | undefined {
  return isRecord(result) && typeof result["reason"] === "string" ? result["reason"] : undefined;
}

function isTriggerEventName(value: string): value is TriggerEventName {
  return /^[^.]+\.[^.]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createDurableWorkflowHandler(options: DurableWorkflowEngineOptions): {
  handler: TriggerHandler;
  engine: DurableWorkflowEngine;
} {
  const engine = new DurableWorkflowEngine(options);
  return { handler: (trigger) => engine.enqueue(trigger), engine };
}
