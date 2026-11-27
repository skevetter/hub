import {
  STOP_RECOVERY_BATCH_SIZE,
  stopInterruptMayHaveSent,
  type StopInterruptState,
} from "../db/stop-interrupt.js";
import type { RunTimeline } from "../run-timeline/index.js";
import { DaemonAgentError } from "./agents/index.js";
import { AgentSessions, AgentSessionError } from "../agent-sessions/index.js";
import type { AgentEvent } from "./agents/index.js";
import {
  buildExecutionCapabilityMcpServer,
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
  verifyAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentExecutionRecord,
  AgentExecutionHubFinishExecutionStatus,
  Database,
  DaemonRecord,
  HubAction,
  TransitionAgentExecutionFields,
  TransitionAgentExecutionResult,
  AcceptedTriggerRunRecord,
  TriggerRunRecord,
  WorkflowDeadlineKind,
  WorkflowAgentCompletionInput,
} from "../db/types.js";
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  type LaunchMachineIntent,
} from "../dispatcher/launch-machine-intent.js";
import { logger as defaultLogger } from "../logger.js";
import { isTransientDatabaseError } from "../db/errors.js";
import { retryDiagnostic, retryWithBackoff, type RetryRuntime } from "../db/retry.js";
import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@getpaseo/protocol/agent-title-limits";
import { reportFailure } from "../failures/index.js";
import type { TriggerProvider, TriggerProviderReactionState } from "../triggers/index.js";
import { isCanceledExecution } from "../triggers/run-stop.js";
import type { ExecutionAuthority } from "../execution-authority/index.js";
import { OutputExecutorRegistry } from "../execution-capabilities/outputs.js";
import { FinishCallRegistry } from "../execution-capabilities/finish-calls.js";
import { executionToolPolicy } from "../execution-capabilities/tool-policy.js";
import { sendsToolPolicy } from "../triggers/configuration/unattended.js";
import {
  notifyAgentExecutionCompleted,
  notifyAgentExecutionFailed,
  notifyAgentExecutionStarted,
  notifyAgentExecutionTerminal,
  notifyDispatchAccepted,
  notifyMachineTerminated,
} from "../triggers/lifecycle.js";
import {
  DaemonResponseLostError,
  type DaemonAgentStreamEvent,
  type DaemonConnection,
  type DaemonCreateAgentOptions,
  type DaemonEvent,
} from "./protocol.js";
import type { JsonValue } from "../config/compiler.js";
import { compileJsonSchema, formatJsonSchemaErrors } from "../workflows/json-schema.js";
import type { Logger } from "pino";
import { isHubFinishExecutionToolName } from "../hub/protocol.js";
import { inferredTurnEndResult, TURN_END_SETTLE_MS, TurnEndTracker } from "./turn-end.js";
import { RunReplyCapture, type OnRunReplyAnswer } from "./reply-capture.js";

export interface DaemonDispatchResult {
  execution: AgentExecutionRecord;
  agentId: string;
}

interface PreparedDaemonDispatch {
  intent: LaunchMachineIntent;
  daemon: DaemonRecord;
  execution: AgentExecutionRecord;
  completionToken: string;
  deadlineAt: Date;
  publicBaseUrl: string;
}

interface CompletionCallbackInput {
  executionId: string;
  token: string;
  output?: unknown;
}

interface CompletionCallbackOptions {
  deferHubAction?: boolean;
}

interface CompleteAgentExecutionOptions extends CompletionCallbackOptions {
  completedByAgent?: boolean;
  output?: unknown;
  /** Set when the agent's turn ended without finish_execution; null when it said nothing. */
  turnEnd?: { text: string; truncated: boolean } | null;
}

interface FailAgentExecutionDetails {
  alreadyInterrupted?: boolean;
  lastInvalidOutput?: unknown;
  notifyProvider?: boolean;
  deadlineCondition?: {
    kind: "hard" | "idle";
    deadlineAt: Date;
    observedAt: Date;
  };
  deadlineKind?: WorkflowDeadlineKind;
}

interface HubExecutionEnv {
  executionId: string;
  completionToken: string;
  publicBaseUrl: string;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
const DEFAULT_AGENT_EXECUTION_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 5 * 60_000;

type AgentStatus = Extract<DaemonEvent, { type: "agent_update" }>["agent"]["status"];
interface ExecutionDeadline {
  kind: "hard" | "idle";
  at: Date;
}

export interface ExecutionDeadlineClock {
  now(): number;
  schedule(callback: () => Promise<void>, delayMs: number): () => void;
}

const STOP_RECOVERY_INTERVAL_MS = 60_000;

const systemExecutionDeadlineClock: ExecutionDeadlineClock = {
  now: Date.now,
  schedule(callback, delayMs) {
    const timer = setTimeout(() => {
      void callback();
    }, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface DaemonDispatchLifecycleOptions {
  database: Database;
  connectionForDaemon(daemonId: string): DaemonConnection | undefined;
  executionCapabilities?: OutputExecutorRegistry;
  providers?: readonly TriggerProvider[];
  executionAuthority?: ExecutionAuthority;
  timeline?: RunTimeline;
  onRunReplyAnswer?: OnRunReplyAnswer;
  /** Shared with the MCP handler, which records each finish_execution call by its execution. */
  finishCalls?: FinishCallRegistry;
  publicBaseUrl?: string;
  completionTokenSecret?: string;
  test?: {
    logger?: Logger;
    dispatchTimeoutMs?: number;
    deadlineClock?: ExecutionDeadlineClock;
    retry?: RetryRuntime;
  };
}

export class DaemonDispatchFailure extends Error {
  readonly code: string;

  constructor(
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`daemon dispatch failed: ${reason}`);
    this.name = "DaemonDispatchFailure";
    this.code = reason;
    this.cause = options?.cause;
  }
}

export class DaemonSpawnAckTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super("timed out waiting for daemon spawn ack");
    this.name = "DaemonSpawnAckTimeoutError";
  }
}

export class AgentExecutionCompletionFailure extends Error {
  constructor(readonly reason: "not_found" | "unauthorized" | "expired") {
    super(`agent execution completion failed: ${reason}`);
    this.name = "AgentExecutionCompletionFailure";
  }
}

export class AgentExecutionOutputValidationFailure extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`invalid structured output: ${errors.join("; ")}`);
    this.name = "AgentExecutionOutputValidationFailure";
  }
}

export class DaemonDispatchLifecycle {
  private readonly providersByName: Map<string, TriggerProvider>;
  private readonly executionCapabilities: OutputExecutorRegistry;
  private readonly startedExecutions = new Set<string>();
  private readonly pendingStreamHandlersByExecution = new Map<string, Promise<void>>();
  private readonly deadlineTimersByExecution = new Map<string, () => void>();
  private readonly activeExecutionDispatches = new Map<string, Promise<unknown>>();
  private readonly reconcilingHubActions = new Map<string, Promise<void>>();
  private readonly daemonRecoveries = new Set<Promise<void>>();
  private readonly executionSubscriptions = new Map<string, () => void>();
  private readonly turnEnds = new Map<string, TurnEndTracker>();
  private readonly turnEndTimers = new Map<string, () => void>();
  private readonly turnEndRuns = new Set<Promise<void>>();
  private readonly replyCapture: RunReplyCapture | undefined;
  private stopping = false;
  private stopRecoveryTimer: (() => void) | undefined;
  private stopRecoveryRun: Promise<void> | undefined;
  readonly finishCalls: FinishCallRegistry;

  constructor(private readonly options: DaemonDispatchLifecycleOptions) {
    this.finishCalls = options.finishCalls ?? new FinishCallRegistry();
    this.executionCapabilities = options.executionCapabilities ?? new OutputExecutorRegistry();
    this.providersByName = new Map(
      (options.providers ?? []).map((provider) => [provider.name, provider]),
    );
    if (options.onRunReplyAnswer !== undefined) {
      this.replyCapture = new RunReplyCapture(
        options.onRunReplyAnswer,
        (executionId) => this.unsubscribeExecution(executionId),
        (callback, delay) => this.scheduleDeadline(callback, delay),
      );
    }
  }

  activeExecutionObservationCount(): number {
    return this.executionSubscriptions.size;
  }

  startStopInterruptRecovery(): void {
    if (this.stopping || this.stopRecoveryTimer !== undefined || this.stopRecoveryRun !== undefined)
      return;
    this.stopRecoveryTimer = this.scheduleDeadline(async () => {
      this.stopRecoveryTimer = undefined;
      this.stopRecoveryRun = this.recoverStopInterrupts().catch((error: unknown) =>
        this.report(error, "daemon.execution.stop-recovery", {}),
      );
      try {
        await this.stopRecoveryRun;
      } finally {
        this.stopRecoveryRun = undefined;
        this.startStopInterruptRecovery();
      }
    }, STOP_RECOVERY_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopRecoveryTimer?.();
    this.stopRecoveryTimer = undefined;
    for (const unsubscribe of this.executionSubscriptions.values()) unsubscribe();
    this.executionSubscriptions.clear();
    for (const clear of this.deadlineTimersByExecution.values()) clear();
    this.deadlineTimersByExecution.clear();
    for (const clear of this.turnEndTimers.values()) clear();
    this.turnEndTimers.clear();
    this.turnEnds.clear();
    this.replyCapture?.stop();
    this.startedExecutions.clear();
    await Promise.allSettled([
      this.stopRecoveryRun,
      ...this.daemonRecoveries,
      ...this.reconcilingHubActions.values(),
      ...this.pendingStreamHandlersByExecution.values(),
      ...this.activeExecutionDispatches.values(),
      ...this.turnEndRuns,
    ]);
  }

  async dispatchLaunchMachineIntent(intent: LaunchMachineIntent): Promise<DaemonDispatchResult> {
    const prepared = await this.prepareDispatch(intent);
    if (prepared === undefined) throw new Error("synchronous dispatch was not prepared");
    return this.spawnPreparedDispatch(prepared);
  }

  async handoffLaunchMachineIntent(
    intent: LaunchMachineIntent,
  ): Promise<{ execution: AgentExecutionRecord }> {
    const executionId = durableExecutionId(intent);
    let prepared: PreparedDaemonDispatch | undefined;
    try {
      prepared = await this.prepareDispatch(intent, executionId);
    } catch (error) {
      if (!isDurablePrelaunchFailure(error)) throw error;
      const failure = await this.claimFailedDurableDispatch(intent, executionId, error.reason);
      this.notifyPrelaunchFailure(failure, this.notifyDispatchAccepted(intent));
      return { execution: failure.execution };
    }
    if (prepared === undefined) {
      const execution = await this.options.database.findAgentExecutionById(executionId);
      if (execution === undefined) {
        throw new Error(`claimed durable execution not found: ${executionId}`);
      }
      const resumable = await this.prepareClaimedDurableDispatch(execution);
      if (resumable !== undefined) {
        this.startDurableDispatch(resumable, this.notifyDispatchAccepted(intent, true));
      }
      return { execution };
    }
    this.startDurableDispatch(prepared, this.notifyDispatchAccepted(intent, true));
    return { execution: prepared.execution };
  }

  async notifyWorkflowRunAccepted(
    run: AcceptedTriggerRunRecord,
  ): Promise<TriggerProviderReactionState> {
    const provider = this.findProviderForTriggerContext(run.triggerContext);
    if (provider === undefined) return run.reactionState;
    return notifyDispatchAccepted({
      provider,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      reactionState: run.reactionState,
    });
  }

  async notifyWorkflowRunStarted(
    run: AcceptedTriggerRunRecord,
  ): Promise<TriggerProviderReactionState> {
    const provider = this.findProviderForTriggerContext(run.triggerContext);
    if (provider === undefined) return run.reactionState;
    return notifyAgentExecutionStarted({
      provider,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      reactionState: run.reactionState,
    });
  }

  async notifyWorkflowRunTerminal(run: TriggerRunRecord): Promise<TriggerProviderReactionState> {
    if (run.outcome !== "accepted" || run.status === "running") return null;
    const provider = this.findProviderForTriggerContext(run.triggerContext);
    if (provider === undefined) return run.reactionState;
    if (run.status === "canceled") {
      if (provider.onWorkflowRunCanceled === undefined) return run.reactionState;
      return provider.onWorkflowRunCanceled(run.triggerContext, run.reactionState);
    }
    if (run.status === "succeeded") {
      return notifyAgentExecutionCompleted({
        provider,
        triggerContext: run.triggerContext,
        outputContext: run.outputContext,
        result: { status: "succeeded" },
        reactionState: run.reactionState,
      });
    }
    return notifyAgentExecutionFailed({
      provider,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      reason:
        run.failureReason ??
        (run.status === "timed_out" ? "workflow_timed_out" : "workflow_failed"),
      reactionState: run.reactionState,
    });
  }

  private async claimFailedDurableDispatch(
    intent: LaunchMachineIntent,
    executionId: string,
    reason: string,
  ): Promise<TransitionAgentExecutionResult> {
    const inserted = await this.options.database.insertAgentExecutionIfAbsent({
      id: executionId,
      organizationId: intent.organizationId,
      projectId: intent.projectId,
      machineId: null,
      daemonId: null,
      triggerContext: intent.triggerContext,
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: intent,
      workflowStepRunId: intent.workflowStepRunId ?? null,
    });
    if (inserted !== undefined) {
      return this.options.database.completeWorkflowAgentExecution({
        executionId,
        executionStatus: "failed",
        stepStatus: "failed",
        result: { status: "failed", reason },
        stepOutput: { status: "failed", reason },
        failureReason: reason,
        observedAt: new Date(this.now()),
        hubAction: null,
      });
    }

    const existing = await this.options.database.findAgentExecutionById(executionId);
    if (existing === undefined) {
      throw new Error(`claimed durable execution not found: ${executionId}`);
    }
    if (existing.status === "spawning") {
      if (existing.workflowStepRunId !== null) {
        return this.options.database.completeWorkflowAgentExecution({
          executionId,
          executionStatus: "failed",
          stepStatus: "failed",
          result: { status: "failed", reason },
          stepOutput: { status: "failed", reason },
          failureReason: reason,
          observedAt: new Date(this.now()),
          hubAction: null,
        });
      }
      return this.options.database.transitionAgentExecution(executionId, "failed", {
        result: { reason },
        hubAction: null,
      });
    }
    return { execution: existing, transitioned: false };
  }

  private notifyPrelaunchFailure(
    failure: TransitionAgentExecutionResult,
    after: Promise<void>,
  ): void {
    const { execution } = failure;
    if (this.activeExecutionDispatches.has(execution.id)) return;
    const tracked = after
      .then(async () => {
        await this.notifyExecutionLifecycle(execution, executionFailureReason(execution));
        return undefined;
      })
      .catch((error: unknown) => {
        this.report(error, "daemon.prelaunch.notification", { executionId: execution.id });
      })
      .finally(() => {
        if (this.activeExecutionDispatches.get(execution.id) === tracked) {
          this.activeExecutionDispatches.delete(execution.id);
        }
      });
    this.activeExecutionDispatches.set(execution.id, tracked);
  }

  private async prepareDispatch(
    intent: LaunchMachineIntent,
    durableId?: string,
  ): Promise<PreparedDaemonDispatch | undefined> {
    if (!this.options.completionTokenSecret) {
      throw new DaemonDispatchFailure("completion_auth_not_configured");
    }
    if (this.options.publicBaseUrl === undefined) {
      throw new DaemonDispatchFailure("completion_url_not_configured");
    }

    const daemon = await this.options.database.findDaemonForOrganization(
      intent.organizationId,
      intent.environment.daemonId,
    );

    if (daemon === undefined) {
      throw new DaemonDispatchFailure("daemon_not_registered", {
        cause: new Error(`Daemon not registered: ${intent.environment.authoredSlug}`),
      });
    }

    const [run, config, daemonMachine] = await Promise.all([
      this.options.database.findTriggerRunById(intent.triggerRunId),
      this.options.database.findProjectConfigurationRevision(
        intent.projectId,
        intent.configurationRevisionId,
      ),
      this.options.database.findMachineForOrganization(intent.organizationId, daemon.machineId),
    ]);
    assertDispatchAuthority(intent, run, config, daemonMachine);

    const executionId = durableId ?? randomUUID();
    const completionToken = this.completionToken(executionId);
    const deadlineAt =
      intent.deadlineAt ??
      new Date(this.now() + (intent.timeoutMs ?? DEFAULT_AGENT_EXECUTION_TIMEOUT_MS));
    const executionInput = dispatchExecutionInput(intent, daemon, {
      id: executionId,
      completionToken,
      deadlineAt,
    });
    const execution =
      durableId === undefined
        ? await this.options.database.insertAgentExecution(executionInput)
        : await this.options.database.insertAgentExecutionIfAbsent(executionInput);
    if (execution === undefined) return undefined;
    if (execution.workflowStepRunId !== null) {
      await this.options.database.linkWorkflowStepRunExecution(
        execution.workflowStepRunId,
        execution.id,
        intent,
      );
    }

    return {
      intent,
      daemon,
      execution,
      completionToken,
      deadlineAt,
      publicBaseUrl: this.options.publicBaseUrl,
    };
  }

  private async prepareClaimedDurableDispatch(
    execution: AgentExecutionRecord,
  ): Promise<PreparedDaemonDispatch | undefined> {
    if (!isUnattachedSpawningExecution(execution)) return undefined;
    const intent = execution.launchIntent;
    const daemonId = execution.daemonId ?? intent?.environment.daemonId;
    if (
      intent === null ||
      daemonId === undefined ||
      execution.deadlineAt === null ||
      this.options.publicBaseUrl === undefined
    ) {
      throw new Error(`durable execution cannot be resumed: ${execution.id}`);
    }
    const daemon = await this.options.database.findDaemonForOrganization(
      execution.organizationId,
      daemonId,
    );
    if (daemon === undefined) throw new Error(`daemon not found: ${daemonId}`);
    const completionToken = this.completionToken(execution.id);
    const preparedExecution = await this.options.database.prepareAgentExecutionForDispatch(
      execution.id,
      daemon.id,
      daemon.machineId,
      hashAgentExecutionCompletionToken(completionToken),
    );
    if (preparedExecution.deadlineAt === null) {
      throw new Error(`durable execution has no deadline: ${execution.id}`);
    }
    return {
      intent,
      daemon,
      execution: preparedExecution,
      completionToken,
      deadlineAt: preparedExecution.deadlineAt,
      publicBaseUrl: this.options.publicBaseUrl,
    };
  }

  private startDurableDispatch(
    prepared: PreparedDaemonDispatch,
    accepted: Promise<void> | undefined,
  ): void {
    if (this.activeExecutionDispatches.has(prepared.execution.id)) return;
    const tracked = Promise.resolve(accepted)
      .then(() => this.spawnPreparedDispatch(prepared, false))
      .catch((error: unknown) => {
        this.report(error, "daemon.dispatch.durable", { executionId: prepared.execution.id });
      })
      .finally(() => {
        if (this.activeExecutionDispatches.get(prepared.execution.id) === tracked) {
          this.activeExecutionDispatches.delete(prepared.execution.id);
        }
      });
    this.activeExecutionDispatches.set(prepared.execution.id, tracked);
  }

  private async spawnPreparedDispatch(
    prepared: PreparedDaemonDispatch,
    notifyAccepted = true,
  ): Promise<DaemonDispatchResult> {
    const { intent, daemon, execution, completionToken, deadlineAt, publicBaseUrl } = prepared;
    try {
      if (notifyAccepted) {
        await this.notifyDispatchAccepted(intent, false, execution.id);
      }

      const agentId = await this.acquireAndSpawnAgent(
        {
          daemonId: daemon.id,
          machineId: daemon.machineId,
          executionId: execution.id,
          ...optionalDeliveryId(intent.triggerContext),
          intent,
          hubExecutionEnv: {
            executionId: execution.id,
            completionToken,
            publicBaseUrl,
          },
        },
        deadlineAt,
      );

      return { execution, agentId };
    } catch (error) {
      if (error instanceof DaemonResponseLostError) throw error;
      const failure = toDaemonDispatchFailure(error);
      this.logDispatchFailure(failure, {
        daemonId: intent.environment.daemonId,
        authoredSlug: intent.environment.authoredSlug,
        machineId: daemon.machineId,
        executionId: execution.id,
        ...optionalDeliveryId(intent.triggerContext),
      });
      await this.failAgentExecution(execution.id, failure.reason);
      throw failure;
    }
  }

  private async materializeLaunch(
    intent: LaunchMachineIntent,
    provider: TriggerProvider | undefined,
    executionId: string,
  ): Promise<{ intent: LaunchMachineIntent; env: Record<string, string> }> {
    const persistedWorktree = intent.environment.worktree;
    const materialized =
      provider?.materializeLaunch === undefined
        ? {}
        : await provider.materializeLaunch({
            executionId,
            organizationId: intent.organizationId,
            projectId: intent.projectId,
            ...(intent.environment.env === undefined
              ? {}
              : { environmentEnv: intent.environment.env }),
            ...(persistedWorktree === undefined ? {} : { environmentWorktree: persistedWorktree }),
            triggerContext: intent.triggerContext,
          });
    const materializedIntent = applyLaunchMaterialization(intent, materialized, persistedWorktree);
    if (this.options.executionAuthority === undefined && materializedIntent.github !== undefined) {
      throw new Error("GitHub step authority is unavailable");
    }
    const authoredEnv = {
      ...launchEnvironmentEnv(intent, materialized),
      ...materializedIntent.env,
    };
    let env: Record<string, string>;
    if (
      this.options.executionAuthority === undefined ||
      (Object.keys(authoredEnv).length === 0 && materializedIntent.github === undefined)
    ) {
      env = authoredEnv;
    } else {
      env = (
        await this.options.executionAuthority.materialize({
          executionId,
          projectId: materializedIntent.projectId,
          triggerContext: materializedIntent.triggerContext,
          ...authorityLaunchOptions(authoredEnv, materializedIntent),
        })
      ).env;
    }
    return { intent: materializedIntent, env };
  }

  private async buildCreateAgentOptions(
    intent: LaunchMachineIntent,
    hubExecutionEnv: HubExecutionEnv,
  ): Promise<DaemonCreateAgentOptions> {
    const provider = this.findProviderForTriggerContext(intent.triggerContext);
    const materialized = await this.materializeLaunch(
      intent,
      provider,
      hubExecutionEnv.executionId,
    );
    return buildCreateAgentOptions(
      materialized.intent,
      hubExecutionEnv,
      this.executionCapabilities,
      materialized.env,
    );
  }

  async handleAgentStreamEvent(
    executionId: string,
    event: DaemonAgentStreamEvent,
    observedAt: Date,
  ): Promise<void> {
    if (event.type === "thread_started") {
      if (await this.refreshAgentIdleDeadline(executionId, observedAt)) {
        await this.startAgentExecution(executionId);
      }
      return;
    }
    assertIdleRefreshEvent(event);
    await this.refreshAgentIdleDeadline(executionId, observedAt);
  }

  private captureTimelineEvent(
    executionId: string,
    event: Extract<DaemonEvent, { type: "agent_stream" }>["event"],
    observedAt: Date,
    source: "live" | "snapshot",
  ): void {
    try {
      this.options.timeline?.observeAgentEvent(executionId, event, observedAt, source);
    } catch (error) {
      this.report(error, "run.timeline.capture", { executionId });
    }
  }

  private handleDaemonEvent(
    executionId: string,
    daemonId: string,
    event: DaemonEvent,
    source: "live" | "snapshot" = "live",
  ): Promise<void> {
    return event.type === "agent_stream"
      ? this.handleDaemonStreamMessage(executionId, event, source)
      : this.handleDaemonStatusEvent(executionId, daemonId, event, source);
  }

  private async handleDaemonStreamMessage(
    executionId: string,
    event: Extract<DaemonEvent, { type: "agent_stream" }>,
    source: "live" | "snapshot",
  ): Promise<void> {
    const observedAt = new Date(event.timestamp);
    this.captureTimelineEvent(executionId, event.event, observedAt, source);
    const item = finishExecutionToolCall(event.event);
    if (
      item !== undefined &&
      (await this.options.database.findAgentExecutionById(executionId))?.launchIntent
        ?.continuation === undefined
    ) {
      await this.options.database.recordAgentExecutionHubAcknowledgement(executionId, {
        kind: "finish_execution",
        callId: item.callId,
        status: item.status,
        observedAt,
      });
    }
    await this.handleAgentStreamEvent(executionId, event.event, observedAt);
    if (event.event.type === "turn_completed") {
      await this.options.database.recordAgentExecutionHubAcknowledgement(executionId, {
        kind: "terminal",
        observedAt,
      });
      await this.acknowledgeAgentExecutionHubAction(executionId, event.agentId, observedAt);
    } else if (event.event.type === "timeline") {
      await this.acknowledgeAgentExecutionHubAction(executionId, event.agentId, observedAt);
    }
  }

  private async handleDaemonStatusEvent(
    executionId: string,
    daemonId: string,
    event: Exclude<DaemonEvent, { type: "agent_stream" }>,
    source: "live" | "snapshot",
  ): Promise<void> {
    if (source === "snapshot") {
      // Watches read state before delivering a prompt. That state belongs to the previous turn
      // until this execution has finished; it must not start or fail the new execution.
      const execution = await this.options.database.findAgentExecutionById(executionId);
      if (execution === undefined || execution.completedByAgentAt === null) return;
    }
    if (isInterruptedAgentState(event.agent)) {
      await this.options.database.attachAgentToExecution(executionId, daemonId, event.agentId);
    }
    const observedAt = new Date(event.timestamp);
    await this.handleAgentStatus(executionId, event.agent.status, "live", observedAt);
    if (event.agent.status === "idle") {
      await this.options.database.recordAgentExecutionHubAcknowledgement(executionId, {
        kind: "idle",
        observedAt,
      });
      await this.acknowledgeAgentExecutionHubAction(executionId, event.agentId, observedAt);
    }
  }

  private async acknowledgeAgentExecutionHubAction(
    executionId: string,
    agentId: string,
    observedAt: Date,
  ): Promise<void> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (
      execution === undefined ||
      (execution.daemonAgentId !== null && execution.daemonAgentId !== agentId)
    ) {
      return;
    }
    if (
      execution.status !== "succeeded" ||
      execution.hubAction !== "archive" ||
      execution.completedByAgentAt === null ||
      execution.hubActionCompletedAt !== null
    ) {
      return;
    }
    const ready = await this.options.database.markAgentExecutionHubActionReady(
      executionId,
      observedAt,
    );
    if (ready !== undefined) {
      await this.reconcileHubActionSafely(ready);
      this.releaseExecutionResources(executionId);
    }
  }

  private async handleAgentStatus(
    executionId: string,
    status: AgentStatus,
    source: "live" | "restore",
    observedAt: Date,
  ): Promise<void> {
    if (status === "error" || status === "closed") {
      await this.failAgentExecution(executionId, "agent_interrupted");
      return;
    }

    let execution = await this.options.database.findAgentExecutionById(executionId);
    if (!isActiveExecution(execution)) return;
    const processedAt = new Date(this.now());
    if (
      await this.expireIfDaemonEventDeadlineElapsed(executionId, execution, observedAt, processedAt)
    )
      return;
    if ((status === "running" || status === "idle") && execution.status === "spawning") {
      await this.startAgentExecution(executionId);
      execution = await this.options.database.findAgentExecutionById(executionId);
      if (!isActiveExecution(execution)) return;
    }

    const idleDeadlineAt = this.idleDeadlineForStatus(execution, status, source, observedAt);
    const updated = await this.options.database.setAgentExecutionIdleDeadline(
      executionId,
      idleDeadlineAt,
      observedAt,
      processedAt,
    );
    await this.armOrExpireExecution(executionId, updated, processedAt);
  }

  private async expireIfDaemonEventDeadlineElapsed(
    executionId: string,
    execution: AgentExecutionRecord,
    observedAt: Date,
    processedAt: Date,
  ): Promise<boolean> {
    if (daemonEventDeadlineElapsed(execution, observedAt, processedAt)) {
      await this.expireExecutionAtCurrentDeadline(executionId, false);
      return true;
    }
    return false;
  }

  private idleDeadlineForStatus(
    execution: AgentExecutionRecord,
    status: AgentStatus,
    source: "live" | "restore",
    observedAt: Date,
  ): Date | null {
    if (status === "idle") {
      if (source === "restore" && execution.idleDeadlineAt !== null) {
        return execution.idleDeadlineAt;
      }
      return new Date(
        Math.min(
          observedAt.getTime() +
            (execution.launchIntent?.idleTimeoutMs ?? DEFAULT_AGENT_IDLE_TIMEOUT_MS),
          execution.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
        ),
      );
    }
    return null;
  }

  private async armOrExpireExecution(
    executionId: string,
    execution: AgentExecutionRecord,
    processedAt: Date,
  ): Promise<void> {
    const deadline = nextExecutionDeadline(execution);
    if (deadline !== undefined && deadline.at.getTime() <= processedAt.getTime()) {
      await this.expireExecutionAtCurrentDeadline(executionId, false);
      return;
    }
    this.armExecutionDeadline(execution);
  }

  private async refreshAgentIdleDeadline(executionId: string, observedAt: Date): Promise<boolean> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (!isActiveExecution(execution)) {
      return false;
    }
    const processedAt = new Date(this.now());
    if (daemonEventDeadlineElapsed(execution, observedAt, processedAt)) {
      await this.expireExecutionAtCurrentDeadline(executionId, false);
      return false;
    }
    if (execution.idleDeadlineAt === null) {
      return true;
    }
    const idleTimeoutMs = execution.launchIntent?.idleTimeoutMs ?? DEFAULT_AGENT_IDLE_TIMEOUT_MS;
    const idleDeadlineAt = new Date(
      Math.min(
        observedAt.getTime() + idleTimeoutMs,
        execution.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
      ),
    );
    const updated = await this.options.database.setAgentExecutionIdleDeadline(
      executionId,
      idleDeadlineAt,
      observedAt,
      processedAt,
    );
    if (isTerminalExecutionStatus(updated.status)) return false;
    await this.armOrExpireExecution(executionId, updated, processedAt);
    return true;
  }

  async completeAgentExecutionFromCallback(
    input: CompletionCallbackInput,
    options: CompletionCallbackOptions = {},
  ): Promise<AgentExecutionRecord> {
    const existingExecution = await this.options.database.findAgentExecutionById(input.executionId);
    assertCompletionExecutionExists(existingExecution);
    assertCompletionToken(existingExecution, input);

    if (isTerminalExecutionStatus(existingExecution.status)) {
      return existingExecution;
    }

    await this.waitForPendingStreamHandlers(input.executionId);
    const currentExecution = await this.options.database.findAgentExecutionById(input.executionId);
    assertCompletionExecutionExists(currentExecution);
    if (isTerminalExecutionStatus(currentExecution.status)) {
      return currentExecution;
    }
    if (await this.expireExecutionIfDeadlineElapsed(currentExecution)) {
      throw new AgentExecutionCompletionFailure("expired");
    }

    validateCallbackOutput(currentExecution, input);
    this.clearExecutionDeadline(input.executionId);
    this.replyCapture?.noteExplicitFinish(input.executionId);
    const execution = await this.completeAgentExecution(
      input.executionId,
      callbackCompletionOptions(input, options),
    );
    if (defersArchiveAcknowledgement(execution, options)) {
      await this.reconcileHubActionSafely(execution);
    }
    if (execution.status !== "succeeded") {
      throw new AgentExecutionCompletionFailure("expired");
    }
    return execution;
  }

  async recoverAgentExecutionDeadlines(): Promise<void> {
    const executions = await this.options.database.findPendingAgentExecutions();
    for (const execution of executions) {
      try {
        if (await this.expireExecutionIfDeadlineElapsed(execution)) {
          continue;
        }
        this.armExecutionDeadline(execution);
      } catch (error: unknown) {
        this.report(error, "daemon.execution.deadline.recover", { executionId: execution.id });
      }
    }
  }

  async recoverPendingHubActions(daemonId?: string): Promise<void> {
    const executions = await this.options.database.findPendingHubActions(daemonId, {
      kind: "ordinary",
    });
    for (const execution of executions) {
      if (
        execution.hubAction !== "archive" ||
        execution.completedByAgentAt === null ||
        execution.hubActionReadyAt !== null ||
        execution.daemonId === null
      ) {
        continue;
      }
      const connection = this.options.connectionForDaemon(execution.daemonId);
      if (connection !== undefined) {
        await this.subscribeRecoveredExecution(execution.id, execution.daemonId, connection);
      }
    }
    await Promise.all(executions.map((execution) => this.reconcileHubActionSafely(execution)));
    await this.recoverStopInterrupts(daemonId);
  }

  private async recoverStopInterrupts(daemonId?: string): Promise<void> {
    if (this.stopping) return;
    const stops = await this.options.database.findPendingHubActions(daemonId, {
      kind: "stop",
      limit: STOP_RECOVERY_BATCH_SIZE,
    });
    for (const execution of stops) {
      if (this.stopping) return;
      await this.reconcileHubActionSafely(execution);
    }
  }

  async recoverWorkflowDeadlineExecutions(executionIds: readonly string[]): Promise<void> {
    for (const executionId of executionIds) await this.releaseWorkflowExecution(executionId);
    await this.recoverPendingHubActions();
  }

  async recoverWorkflowTerminalExecutions(
    executionIds: readonly string[],
    retryStop = false,
  ): Promise<void> {
    await Promise.all(
      executionIds.map(async (executionId) => {
        const execution = await (retryStop
          ? this.options.database.findAgentExecutionById(executionId)
          : this.releaseWorkflowExecution(executionId));
        if (execution !== undefined) await this.reconcileHubActionSafely(execution);
      }),
    );
  }

  private async releaseWorkflowExecution(executionId: string) {
    this.clearExecutionDeadline(executionId);
    this.releaseExecutionResources(executionId);
    this.startedExecutions.delete(executionId);
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined || !isTerminalExecutionStatus(execution.status)) return undefined;
    await this.notifyExecutionTerminal(execution);
    return execution;
  }

  recoverDaemon(daemon: DaemonRecord): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const recovery = Promise.all([
      this.recoverPendingHubActions(daemon.id),
      this.recoverLiveExecutions(daemon),
    ]).then(() => undefined);
    this.daemonRecoveries.add(recovery);
    void recovery.then(
      () => this.daemonRecoveries.delete(recovery),
      () => this.daemonRecoveries.delete(recovery),
    );
    return recovery;
  }

  private async recoverLiveExecutions(daemon: DaemonRecord): Promise<void> {
    const executions = await this.options.database.findPendingAgentExecutions();
    await Promise.all(
      executions
        .filter(
          (execution) =>
            execution.daemonId === daemon.id ||
            (execution.daemonId === null && execution.machineId === daemon.machineId),
        )
        .map((execution) => this.recoverExecutionOnce(daemon, execution)),
    );
  }

  private recoverExecutionOnce(
    daemon: DaemonRecord,
    execution: AgentExecutionRecord,
  ): Promise<void> {
    const active = this.activeExecutionDispatches.get(execution.id);
    if (active) {
      return active.then(async () => {
        const current = await this.options.database.findAgentExecutionById(execution.id);
        // Agent identity is persisted before delivery; the replacement must also restore observation.
        if (current !== undefined && !isTerminalExecutionStatus(current.status)) {
          return this.recoverExecutionOnce(daemon, current);
        }
        return undefined;
      });
    }
    const recovery = this.recoverExecution(daemon, execution)
      .catch((error: unknown) => {
        if (!this.stopping) {
          this.report(error, "daemon.execution.recover", {
            executionId: execution.id,
            daemonId: daemon.id,
          });
        }
      })
      .finally(() => {
        if (this.activeExecutionDispatches.get(execution.id) === recovery)
          this.activeExecutionDispatches.delete(execution.id);
      });
    this.activeExecutionDispatches.set(execution.id, recovery);
    return recovery;
  }

  private async recoverExecution(
    daemon: DaemonRecord,
    execution: AgentExecutionRecord,
  ): Promise<void> {
    const connection = this.options.connectionForDaemon(daemon.id);
    if (connection === undefined) return;

    const current = await this.options.database.findAgentExecutionById(execution.id);
    if (current === undefined || isTerminalExecutionStatus(current.status)) return;
    if (this.stopping) return;

    const intent = current.launchIntent;
    if (intent === null || this.options.publicBaseUrl === undefined)
      throw new Error("execution launch intent cannot be recovered");
    // An existing agent cannot receive replacement process environment credentials.
    const options = this.options;
    if (
      current.agentSessionId !== null &&
      hasExecutionAuthority(options) &&
      !(await this.sessionOwner().canResumeAuthority(current, (executionId) =>
        options.executionAuthority.canResume({
          executionId,
          projectId: intent.projectId,
          triggerContext: intent.triggerContext,
          env: { ...intent.environment.env, ...intent.env },
          ...(intent.github === undefined ? {} : { github: intent.github }),
        }),
      ))
    ) {
      await this.failAgentExecution(current.id, "execution_credentials_unavailable");
      return;
    }
    await this.dispatchSession({
      daemonId: daemon.id,
      executionId: current.id,
      intent,
      hubExecutionEnv: {
        executionId: current.id,
        completionToken: this.completionToken(current.id),
        publicBaseUrl: this.options.publicBaseUrl,
      },
    }).catch(async (error: unknown) => {
      if (error instanceof AgentSessionError || error instanceof DaemonAgentError) {
        await this.failAgentExecution(current.id, toDaemonDispatchFailure(error).reason);
        return;
      }
      throw error;
    });
  }

  private async subscribeRecoveredExecution(
    executionId: string,
    daemonId: string,
    connection: DaemonConnection,
  ): Promise<void> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (!execution?.daemonAgentId) return;
    try {
      const intent = execution.launchIntent;
      this.options.timeline?.begin(
        executionId,
        intent === null
          ? undefined
          : {
              organizationId: execution.organizationId,
              triggerRunId: intent.triggerRunId,
            },
      );
    } catch (error) {
      this.report(error, "run.timeline.capture", { executionId });
    }
    const unsubscribe = await connection.agents.watch(execution.daemonAgentId, (event) =>
      this.observeSessionEvent(executionId, daemonId, event),
    );
    this.executionSubscriptions.get(executionId)?.();
    this.executionSubscriptions.set(executionId, unsubscribe);
    await this.releaseIfArchiveFinished(executionId, unsubscribe);
  }

  // The archive can finish while watch() is still pending, so there was nothing to release then.
  private async releaseIfArchiveFinished(
    executionId: string,
    unsubscribe: () => void,
  ): Promise<void> {
    const current = await this.options.database.findAgentExecutionById(executionId);
    if (current === undefined || current.hubActionCompletedAt === null) return;
    if (this.executionSubscriptions.get(executionId) === unsubscribe) {
      this.releaseExecutionResources(executionId);
    }
  }

  async failPendingExecutionsForDisconnectedMachine(
    machineId: string,
    reason: string,
  ): Promise<void> {
    const executions = (await this.options.database.findPendingAgentExecutions()).filter(
      (execution) => execution.machineId === machineId,
    );

    const failedExecutions = await Promise.all(
      executions.map(async (execution) => {
        const failed = await this.failAgentExecution(execution.id, "daemon_disconnected", {
          notifyProvider: false,
        });
        return failed === undefined ? undefined : execution;
      }),
    );

    await this.options.database.transitionMachine(machineId, "terminated", {
      reason,
    });

    await Promise.all(
      failedExecutions.map((execution) =>
        execution === undefined
          ? Promise.resolve()
          : this.notifyMachineTerminatedForExecution(execution, reason).catch((error: unknown) => {
              this.report(error, "daemon.provider.machine-termination", {
                executionId: execution.id,
              });
            }),
      ),
    );
  }

  private async startAgentExecution(executionId: string): Promise<void> {
    const alreadyStarted = this.startedExecutions.has(executionId);
    this.startedExecutions.add(executionId);
    const transition = await this.options.database.transitionAgentExecution(executionId, "running");
    if (isCanceledExecution(transition.execution)) {
      this.releaseExecutionResources(executionId);
      this.startedExecutions.delete(executionId);
      return;
    }

    if (alreadyStarted || !transition.transitioned) {
      return;
    }

    const { execution } = transition;
    await this.notifyExecutionLifecycle(execution).catch((error: unknown) => {
      this.report(error, "daemon.provider.execution-start", { executionId });
    });
  }

  private async completeAgentExecution(
    executionId: string,
    options: CompleteAgentExecutionOptions = {},
  ): Promise<AgentExecutionRecord> {
    const existing = await this.options.database.findAgentExecutionById(executionId);
    if (existing === undefined) throw new Error(`agent execution not found: ${executionId}`);
    const { fields, workflow } = successfulExecutionTransition(existing, options);
    const transition = await this.transitionTerminalAgentExecution(
      executionId,
      "succeeded",
      fields,
      workflow,
    );
    if (!transition.transitioned) {
      this.releaseIfExecutionTerminal(executionId, transition.execution);
      return transition.execution;
    }

    this.clearExecutionDeadline(executionId);
    this.clearTurnEnd(executionId);
    this.finishCalls.release(executionId);

    const { execution } = transition;
    if (this.hasRunReplyCapture(executionId))
      await this.completeRunReplyCapture(execution, options.completedByAgent === true);
    if (!defersArchiveAcknowledgement(execution, options)) {
      this.releaseExecutionResources(executionId);
    }
    this.startedExecutions.delete(executionId);
    await this.notifyExecutionTerminal(execution);
    if (options.deferHubAction !== true) await this.reconcileHubActionSafely(execution);
    if (execution.workflowStepRunId === null) {
      await this.notifyExecutionLifecycle(execution).catch((error: unknown) => {
        this.report(error, "daemon.provider.execution-complete", { executionId });
      });
    }
    return execution;
  }

  private hasRunReplyCapture(executionId: string): boolean {
    return this.replyCapture?.has(executionId) === true;
  }

  private releaseIfExecutionTerminal(executionId: string, execution: AgentExecutionRecord): void {
    if (isTerminalExecutionStatus(execution.status)) this.releaseExecutionResources(executionId);
  }

  private async failAgentExecution(
    executionId: string,
    reason: string,
    details: FailAgentExecutionDetails = {},
  ): Promise<AgentExecutionRecord | undefined> {
    const current = await this.options.database.findAgentExecutionById(executionId);
    if (current === undefined) throw new Error(`agent execution not found: ${executionId}`);
    const { fields, workflow } = failedExecutionTransition(current, reason, details, () =>
      this.now(),
    );
    const transition = await this.transitionTerminalAgentExecution(
      executionId,
      "failed",
      fields,
      workflow,
    );
    if (!transition.transitioned) {
      this.releaseIfExecutionTerminal(executionId, transition.execution);
      return undefined;
    }

    this.clearExecutionDeadline(executionId);
    this.releaseExecutionResources(executionId);

    const { execution } = transition;
    this.startedExecutions.delete(executionId);
    await this.notifyExecutionTerminal(execution);
    await this.reconcileHubActionSafely(execution);
    if (details.notifyProvider !== false && execution.workflowStepRunId === null) {
      await this.notifyExecutionLifecycle(execution, reason).catch((error: unknown) => {
        this.report(error, "daemon.provider.execution-fail", { executionId });
      });
    }

    return execution;
  }

  private async transitionTerminalAgentExecution(
    executionId: string,
    status: "succeeded" | "failed",
    fields: TransitionAgentExecutionFields,
    workflow: Pick<WorkflowAgentCompletionInput, "stepStatus" | "stepOutput" | "failureReason">,
  ): Promise<TransitionAgentExecutionResult> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined) throw new Error(`agent execution not found: ${executionId}`);
    const hubAction =
      fields.hubAction === undefined ? deriveHubAction(execution, status) : fields.hubAction;
    if (execution.workflowStepRunId !== null) {
      return this.options.database.completeWorkflowAgentExecution({
        executionId,
        executionStatus: status,
        stepStatus: workflow.stepStatus,
        result: fields.result,
        stepOutput: workflow.stepOutput,
        ...(workflow.failureReason === undefined ? {} : { failureReason: workflow.failureReason }),
        ...(fields.completedByAgent === undefined
          ? {}
          : { completedByAgent: fields.completedByAgent }),
        ...(fields.deadlineCondition === undefined
          ? {}
          : { deadlineCondition: fields.deadlineCondition }),
        observedAt: new Date(this.now()),
        hubAction,
      });
    }
    return this.options.database.transitionAgentExecution(executionId, status, {
      ...fields,
      hubAction,
    });
  }

  private reconcileHubActionSafely(execution: AgentExecutionRecord): Promise<void> {
    return this.reconcileHubAction(execution).catch((error: unknown) => {
      this.report(error, "daemon.execution.hub-action", {
        executionId: execution.id,
        hubAction: execution.hubAction,
      });
    });
  }

  private reconcileHubAction(execution: AgentExecutionRecord): Promise<void> {
    return this.reconcileHubActionAfterDurableAcknowledgement(execution);
  }

  private async reconcileHubActionAfterDurableAcknowledgement(
    execution: AgentExecutionRecord,
  ): Promise<void> {
    if (
      this.stopping ||
      execution.hubAction === null ||
      execution.hubActionCompletedAt !== null ||
      execution.daemonId === null
    ) {
      return;
    }
    let current = execution;
    if (
      current.hubAction === "archive" &&
      current.completedByAgentAt !== null &&
      current.hubActionReadyAt === null
    ) {
      const ready = await this.options.database.markAgentExecutionHubActionReady(current.id);
      if (ready === undefined) return;
      current = ready;
    }
    const existing = this.reconcilingHubActions.get(current.id);
    if (existing !== undefined) return existing;
    const operation = this.sendPendingHubAction(current).finally(() => {
      if (this.reconcilingHubActions.get(current.id) === operation) {
        this.reconcilingHubActions.delete(current.id);
      }
    });
    this.reconcilingHubActions.set(current.id, operation);
    await operation;
  }

  private async sendPendingHubAction(candidate: AgentExecutionRecord): Promise<void> {
    const execution = await this.options.database.findAgentExecutionById(candidate.id);
    if (!isUnfinishedHubAction(execution) || this.stopping) return;
    const action = execution.hubAction;
    const daemonId = execution.daemonId;
    if (action === null || daemonId === null) return;
    const connection = this.options.connectionForDaemon(daemonId);
    if (isCanceledInterruptAction(execution, action)) {
      // Keep the generation observed by this recovery so a queued contender cannot
      // claim a new attempt after another worker releases the row.
      const generation = candidate.hubActionAcknowledgements.stopInterruptGeneration ?? null;
      await this.sendStopInterrupt(execution, daemonId, connection?.agents, generation);
    } else if (connection !== undefined) {
      const settled = await withHubActionTimeout(
        this.sessionOwner().control(execution, connection.agents, action),
        this.dispatchTimeoutMs,
        (callback, delayMs) => this.scheduleDeadline(async () => callback(), delayMs),
      );
      if (settled !== undefined) await this.completeHubAction(execution.id, action);
    }
  }

  private async completeHubAction(
    executionId: string,
    action: NonNullable<AgentExecutionRecord["hubAction"]>,
  ): Promise<void> {
    await this.options.database.completeHubAction(executionId, action);
    // Either the idle event or recovery can mark the archive ready, and only the first released.
    if (action === "archive") this.releaseExecutionResources(executionId);
  }

  private async sendStopInterrupt(
    execution: AgentExecutionRecord,
    daemonId: string,
    agents: DaemonConnection["agents"] | undefined,
    generation: string | null,
  ) {
    const database = this.options.database;
    const store = database.stopInterrupts;
    const token = randomUUID();
    const claimed = await store.claim(execution.id, token, generation);
    if (claimed === undefined) return;
    try {
      const { state } = claimed;
      let interrupted = state?.acknowledgedPeerIds;
      if (interrupted === undefined) {
        const daemon = await database.findDaemonById(daemonId);
        const delivery = stopInterruptDelivery(daemon, claimed, state);
        const outcome =
          typeof delivery === "string"
            ? delivery
            : await this.sessionOwner().interruptStoppedExecution(
                execution,
                agents,
                token,
                delivery.approvedPeerIds,
              );
        if (typeof outcome === "string") {
          await store.complete(execution.id, token, outcome);
        } else {
          interrupted = outcome;
        }
      }
      if (interrupted === undefined) return;
      await Promise.all(
        interrupted.map((id) =>
          this.failAgentExecution(id, "agent_interrupted", { alreadyInterrupted: true }),
        ),
      );
      await store.complete(execution.id, token, "confirmed");
    } finally {
      await store.release(execution.id, token);
    }
  }

  private async notifyMachineTerminated(
    triggerContext: unknown,
    reason: string,
    reactionState?: TriggerProviderReactionState,
  ): Promise<TriggerProviderReactionState> {
    const provider = this.findProviderForTriggerContext(triggerContext);
    if (provider === undefined) {
      return reactionState ?? null;
    }

    return notifyMachineTerminated({
      provider,
      triggerContext,
      reason,
      ...(reactionState === undefined ? {} : { reactionState }),
    });
  }

  private async notifyDispatchAccepted(
    intent: LaunchMachineIntent,
    swallowErrors = false,
    executionId = durableExecutionId(intent),
  ): Promise<void> {
    if (intent.workflowStepRunId !== undefined && intent.workflowStepRunId !== null) return;
    const provider = this.findProviderForTriggerContext(intent.triggerContext);
    if (provider === undefined) return;
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined) return;
    try {
      const reactionState = await notifyDispatchAccepted({
        provider,
        triggerContext: intent.triggerContext,
        outputContext: intent.outputContext,
        reactionState: execution.reactionState,
      });
      await this.options.database.setAgentExecutionReactionState(execution.id, reactionState);
    } catch (error: unknown) {
      this.report(error, "daemon.provider.dispatch-accepted", { executionId });
      if (!swallowErrors) throw error;
    }
  }

  private async notifyExecutionLifecycle(
    execution: AgentExecutionRecord,
    failureReason?: string,
  ): Promise<void> {
    const provider = this.findProviderForTriggerContext(execution.triggerContext);
    if (provider === undefined) return;
    if (execution.workflowStepRunId !== null) {
      return;
    }
    const reactionState = await notifyIndividualExecution(provider, execution, failureReason);
    await this.options.database.setAgentExecutionReactionState(execution.id, reactionState);
  }

  private async notifyExecutionTerminal(execution: AgentExecutionRecord): Promise<void> {
    const provider = this.findProviderForTriggerContext(execution.triggerContext);
    if (provider !== undefined) {
      await notifyAgentExecutionTerminal({
        provider,
        executionId: execution.id,
        triggerContext: execution.triggerContext,
      }).catch((error: unknown) => {
        this.report(error, "daemon.provider.terminal-cleanup", { executionId: execution.id });
      });
    }
    const authority = this.options.executionAuthority;
    if (authority === undefined) return;
    const release = (executionId: string) => authority.onExecutionTerminal(executionId);
    await (
      execution.agentSessionId === null
        ? release(execution.id)
        : this.sessionOwner().releaseAuthority(execution, release)
    ).catch((error: unknown) => {
      this.report(error, "daemon.execution-authority.terminal-cleanup", {
        executionId: execution.id,
      });
    });
  }

  private async notifyMachineTerminatedForExecution(
    execution: AgentExecutionRecord,
    reason: string,
  ): Promise<void> {
    if (execution.workflowStepRunId !== null && execution.workflowStepRunId !== undefined) {
      return;
    }
    const reactionState = await this.notifyMachineTerminated(
      execution.triggerContext,
      reason,
      execution.reactionState,
    );
    await this.options.database.setAgentExecutionReactionState(execution.id, reactionState);
  }

  private findProviderForTriggerContext(triggerContext: unknown): TriggerProvider | undefined {
    if (typeof triggerContext !== "object" || triggerContext === null) {
      return undefined;
    }

    const providerName = hasProviderName(triggerContext) ? triggerContext.provider : undefined;
    return typeof providerName === "string" ? this.providersByName.get(providerName) : undefined;
  }

  private logDispatchFailure(
    failure: DaemonDispatchFailure,
    fields: {
      daemonId: string;
      authoredSlug: string;
      machineId: string;
      executionId: string;
      deliveryId?: string;
    },
  ): void {
    if (failure.cause instanceof DaemonSpawnAckTimeoutError) {
      this.report(
        failure,
        "daemon.dispatch.spawn-ack",
        { ...fields, timeoutMs: failure.cause.timeoutMs },
        "timeout",
      );
      return;
    }

    this.report(failure, "daemon.dispatch", { ...fields, ...retryDiagnostic(failure.cause) });
  }

  private report(
    error: unknown,
    operation: string,
    diagnostic?: Record<string, unknown>,
    kind?: "timeout",
  ): void {
    reportFailure(
      error,
      { operation, component: "daemons" },
      {
        logger: this.logger,
        ...(kind === undefined ? {} : { kind }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      },
    );
  }

  private get logger(): Logger {
    return this.options.test?.logger ?? defaultLogger;
  }

  private get dispatchTimeoutMs(): number {
    return this.options.test?.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  }

  private async acquireAndSpawnAgent(
    input: {
      daemonId: string;
      machineId: string;
      executionId: string;
      deliveryId?: string;
      intent: LaunchMachineIntent;
      hubExecutionEnv: HubExecutionEnv;
    },
    deadlineAt: Date,
  ): Promise<string> {
    let canceled = false;
    const timeoutMs = Math.max(
      0,
      Math.min(
        input.intent.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        deadlineAt.getTime() - this.now(),
      ),
    );
    try {
      return await withDispatchTimeout(
        this.acquireAndSpawnAgentWithoutTimeout(input, () => canceled),
        timeoutMs,
        () => {
          canceled = true;
          this.releaseExecutionResources(input.executionId);
        },
        (callback, delayMs) => this.scheduleDeadline(async () => callback(), delayMs),
      );
    } catch (error) {
      if (deadlineAt.getTime() <= this.now()) {
        throw new DaemonDispatchFailure("timeout", { cause: error });
      }
      throw error;
    }
  }

  private sessionOwner(): AgentSessions {
    if (!this.options.completionTokenSecret || !this.options.publicBaseUrl)
      throw new Error("Session capabilities are unavailable");
    return new AgentSessions(
      this.options.database,
      this.options.completionTokenSecret,
      this.options.publicBaseUrl,
      { outputs: this.executionCapabilities, now: () => this.now() },
    );
  }

  private async dispatchSession(input: {
    daemonId: string;
    executionId: string;
    intent: LaunchMachineIntent;
    hubExecutionEnv: HubExecutionEnv;
    beforePromptSend?: () => void;
  }): Promise<string> {
    const connection = this.options.connectionForDaemon(input.daemonId);
    if (!connection) throw new DaemonDispatchFailure("daemon_unreachable");
    const dispatched = await this.sessionOwner()
      .dispatch({
        executionId: input.executionId,
        intent: input.intent,
        connection: connection.agents,
        beforePromptSend: () => {
          this.watchForTurnEnd(input.executionId, input.intent);
          if (input.intent.replyMessage === true || input.intent.replyCaptureCandidate === true) {
            this.replyCapture?.begin(input.executionId, {
              organizationId: input.intent.organizationId,
              runId: input.intent.triggerRunId,
            });
          }
          try {
            this.options.timeline?.begin(input.executionId, {
              organizationId: input.intent.organizationId,
              triggerRunId: input.intent.triggerRunId,
            });
          } catch (error) {
            this.report(error, "run.timeline.capture", { executionId: input.executionId });
          }
          input.beforePromptSend?.();
        },
        createOptions: () =>
          this.buildCreateAgentOptions(input.intent, input.hubExecutionEnv).catch(
            (error: unknown) => {
              throw toDispatchPreparationFailure(error);
            },
          ),
        onEvent: (event) => this.observeSessionEvent(input.executionId, input.daemonId, event),
      })
      .catch(async (error: unknown) => {
        const execution = await this.options.database.findAgentExecutionById(input.executionId);
        if (execution && isTerminalExecutionStatus(execution.status)) {
          await this.reconcileHubActionSafely(execution);
        }
        throw error;
      });
    this.executionSubscriptions.get(input.executionId)?.();
    this.executionSubscriptions.set(input.executionId, dispatched.unsubscribe);
    await this.startAgentExecution(input.executionId);
    await this.armLiveExecutionDeadline(input.executionId);
    return dispatched.agentId;
  }

  private observeSessionEvent(executionId: string, daemonId: string, event: AgentEvent): void {
    this.replyCapture?.observe(executionId, event);
    const turnEnd = this.turnEnds.get(executionId);
    if (turnEnd !== undefined) this.observeTurnEnd(executionId, turnEnd, event);
    const normalized =
      event.type === "agent_stream"
        ? { ...event, executionId }
        : {
            ...event,
            type: "agent_update" as const,
            executionId,
            agentId: event.agent.id,
            agent: { ...event.agent, status: event.agent.status },
          };
    void this.queueDaemonEvent(
      executionId,
      daemonId,
      normalized,
      event.type === "agent_snapshot" ? "snapshot" : "live",
    ).catch((error: unknown) => {
      this.report(error, "daemon.session.event", { executionId });
    });
  }

  private async acquireAndSpawnAgentWithoutTimeout(
    input: {
      daemonId: string;
      machineId: string;
      executionId: string;
      deliveryId?: string;
      intent: LaunchMachineIntent;
      hubExecutionEnv: HubExecutionEnv;
    },
    isCanceled: () => boolean,
  ): Promise<string> {
    if (isCanceled()) throw new DaemonSpawnAckTimeoutError(this.dispatchTimeoutMs);
    if (!(await this.armLiveExecutionDeadline(input.executionId))) {
      throw new DaemonDispatchFailure("timeout");
    }
    const agentId = await this.dispatchSessionWithRetry(input, isCanceled);
    if (isCanceled()) {
      this.releaseExecutionResources(input.executionId);
      throw new DaemonSpawnAckTimeoutError(this.dispatchTimeoutMs);
    }
    return agentId;
  }

  /**
   * Retries a transient database failure only while nothing irreversible has happened. Creating
   * the agent is safe to repeat because its idempotency key is the session id. Sending the prompt
   * is not known to be, so once the send has started a failure is final.
   */
  private dispatchSessionWithRetry(
    input: {
      daemonId: string;
      executionId: string;
      intent: LaunchMachineIntent;
      hubExecutionEnv: HubExecutionEnv;
    },
    isCanceled: () => boolean,
  ): Promise<string> {
    let promptSendStarted = false;
    return retryWithBackoff(
      () =>
        this.dispatchSession({
          ...input,
          beforePromptSend: () => {
            promptSendStarted = true;
          },
        }),
      {
        ...this.options.test?.retry,
        isRetryable: (error) =>
          !promptSendStarted && !isCanceled() && !this.stopping && isTransientDatabaseError(error),
        onRetry: ({ attempt, delayMs }) => {
          this.logger.warn(
            { executionId: input.executionId, attempt, delayMs: Math.round(delayMs) },
            "agent dispatch hit a transient database error and will be retried",
          );
        },
      },
    );
  }

  /** Starts following turn ends for an opted-in execution; events before this are not counted. */
  private watchForTurnEnd(executionId: string, intent: LaunchMachineIntent): void {
    this.clearTurnEnd(executionId);
    if (intent.completeOnTurnEnd === true)
      this.turnEnds.set(executionId, new TurnEndTracker(intent.replyMessage !== true));
  }

  private async completeRunReplyCapture(execution: AgentExecutionRecord, explicit: boolean) {
    try {
      if (!this.stopping && !(await this.hasOtherActiveSessionExecution(execution)))
        this.replyCapture?.complete(execution.id, explicit);
    } catch (error) {
      this.report(error, "daemon.execution.reply-capture", { executionId: execution.id });
    }
  }

  private clearTurnEnd(executionId: string): void {
    this.turnEndTimers.get(executionId)?.();
    this.turnEndTimers.delete(executionId);
    this.turnEnds.delete(executionId);
  }

  private observeTurnEnd(executionId: string, tracker: TurnEndTracker, event: AgentEvent): void {
    const verdict = tracker.observe(event);
    if (verdict === "none") return;
    this.turnEndTimers.get(executionId)?.();
    this.turnEndTimers.delete(executionId);
    if (verdict !== "finished") return;
    const generation = tracker.currentGeneration;
    const clear = this.scheduleDeadline(async () => {
      this.turnEndTimers.delete(executionId);
      // Tracked so stop() can wait for a completion that is already past its timer.
      const run = this.completeFinishedTurn(executionId, tracker, generation)
        .catch((error: unknown) => {
          this.report(error, "daemon.execution.turn-end", { executionId });
        })
        .finally(() => this.turnEndRuns.delete(run));
      this.turnEndRuns.add(run);
      await run;
    }, TURN_END_SETTLE_MS);
    this.turnEndTimers.set(executionId, clear);
  }

  /**
   * Completes an opted-in execution whose agent ended its turn without calling finish_execution.
   * Every check that can say no runs again here, after the settle period, because the state that
   * armed the timer may have changed. An explicit finish that wins the race is left alone: the
   * transition below changes only an execution that is still running.
   */
  private async completeFinishedTurn(
    executionId: string,
    tracker: TurnEndTracker,
    generation: number,
  ): Promise<void> {
    // Shutdown and new agent activity can both land during any await below, so the same check
    // runs after each one and again right before the write.
    const stillWanted = () =>
      !this.stopping && this.turnEnds.get(executionId) === tracker && tracker.isCurrent(generation);
    const ownsTurnEnd = () => stillWanted() && !this.finishCalls.ownsOutcome(executionId);
    await this.waitForPendingStreamHandlers(executionId);
    if (!ownsTurnEnd()) return;
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (
      !isTurnEndCandidate(execution, stillWanted) ||
      (await this.expireExecutionIfDeadlineElapsed(execution))
    )
      return;
    if (
      !stillWanted() ||
      (await this.hasOtherActiveSessionExecution(execution)) ||
      !stillWanted() ||
      !(await this.agentIsIdle(execution)) ||
      !ownsTurnEnd()
    )
      return;
    await this.completeAgentExecution(executionId, { turnEnd: tracker.finalOutput() ?? null });
  }

  /** One agent turn can serve several queued prompts, so it cannot be tied to one execution. */
  private async hasOtherActiveSessionExecution(execution: AgentExecutionRecord): Promise<boolean> {
    if (execution.agentSessionId === null) return false;
    const siblings = await this.options.database.listAgentSessionExecutions(
      execution.agentSessionId,
    );
    return siblings.some(
      (other) => other.id !== execution.id && !isTerminalExecutionStatus(other.status),
    );
  }

  /** The daemon's own answer, not the events Hub happened to see. */
  private async agentIsIdle(execution: AgentExecutionRecord): Promise<boolean> {
    if (execution.daemonId === null || execution.daemonAgentId === null) return false;
    const connection = this.options.connectionForDaemon(execution.daemonId);
    if (connection === undefined) return false;
    try {
      return (await connection.agents.get(execution.daemonAgentId)).status === "idle";
    } catch (error) {
      this.report(error, "daemon.execution.turn-end.status", { executionId: execution.id });
      return false;
    }
  }

  /** Resolves once every daemon event already received for the execution has been handled. */
  async waitForPendingStreamHandlers(executionId: string): Promise<void> {
    await this.pendingStreamHandlersByExecution.get(executionId)?.catch(() => undefined);
  }

  private queueDaemonEvent(
    executionId: string,
    daemonId: string,
    event: DaemonEvent,
    source: "live" | "snapshot" = "live",
  ): Promise<void> {
    const previous = this.pendingStreamHandlersByExecution.get(executionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => this.handleDaemonEvent(executionId, daemonId, event, source));
    this.pendingStreamHandlersByExecution.set(executionId, current);
    const clearCurrent = () => {
      if (this.pendingStreamHandlersByExecution.get(executionId) === current) {
        this.pendingStreamHandlersByExecution.delete(executionId);
      }
    };
    void current.then(clearCurrent, clearCurrent);
    return current;
  }

  private armExecutionDeadline(execution: AgentExecutionRecord): void {
    this.clearExecutionDeadline(execution.id);
    const deadline = nextExecutionDeadline(execution);
    if (deadline === undefined || isTerminalExecutionStatus(execution.status)) return;

    const delayMs = Math.max(0, deadline.at.getTime() - this.now());
    const clear = this.scheduleDeadline(async () => {
      await this.expireExecutionAtCurrentDeadline(execution.id).catch((error: unknown) => {
        this.report(error, "daemon.execution.timeout", { executionId: execution.id });
        void this.retryExecutionDeadline(execution.id).catch((retryError: unknown) => {
          this.report(retryError, "daemon.execution.timeout.retry-schedule", {
            executionId: execution.id,
          });
        });
      });
    }, delayMs);
    this.deadlineTimersByExecution.set(execution.id, clear);
  }

  private async armLiveExecutionDeadline(executionId: string): Promise<boolean> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined) return true;
    if (isTerminalExecutionStatus(execution.status)) return false;

    const deadline = nextExecutionDeadline(execution);
    if (deadline !== undefined && deadline.at.getTime() <= this.now()) {
      return !(await this.expireExecutionAtCurrentDeadline(executionId));
    }

    this.armExecutionDeadline(execution);
    return true;
  }

  private clearExecutionDeadline(executionId: string): void {
    const clear = this.deadlineTimersByExecution.get(executionId);
    if (clear !== undefined) {
      clear();
      this.deadlineTimersByExecution.delete(executionId);
    }
  }

  private releaseExecutionResources(executionId: string): void {
    try {
      this.options.timeline?.release(executionId);
    } catch (error) {
      this.report(error, "run.timeline.capture", { executionId });
    }
    if (this.replyCapture?.release(executionId) !== false) this.unsubscribeExecution(executionId);
    this.clearTurnEnd(executionId);
    this.finishCalls.release(executionId);
  }

  private unsubscribeExecution(executionId: string): void {
    this.executionSubscriptions.get(executionId)?.();
    this.executionSubscriptions.delete(executionId);
  }

  private async expireExecutionAtCurrentDeadline(
    executionId: string,
    waitForPendingStreamHandlers = true,
  ): Promise<boolean> {
    if (waitForPendingStreamHandlers) {
      await this.waitForPendingStreamHandlers(executionId);
    }
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (!isActiveExecution(execution)) return false;
    const deadline = nextExecutionDeadline(execution);
    if (deadline === undefined || deadline.at.getTime() > this.now()) {
      this.armExecutionDeadline(execution);
      return false;
    }

    const wholeRunExpired = await this.isWholeRunDeadlineExpired(execution);
    const failure = deadlineFailure(execution, deadline, wholeRunExpired);
    const failed = await this.failAgentExecution(executionId, failure.reason, {
      deadlineCondition: {
        kind: deadline.kind,
        deadlineAt: deadline.at,
        observedAt: new Date(this.now()),
      },
      ...(failure.deadlineKind === undefined ? {} : { deadlineKind: failure.deadlineKind }),
    });
    if (failed === undefined) {
      const current = await this.options.database.findAgentExecutionById(executionId);
      if (isActiveExecution(current)) this.armExecutionDeadline(current);
    }
    return failed !== undefined;
  }

  private async isWholeRunDeadlineExpired(execution: AgentExecutionRecord): Promise<boolean> {
    if (execution.workflowStepRunId === null) return false;
    const step = await this.options.database.findWorkflowStepRunById(execution.workflowStepRunId);
    if (step === undefined) return false;
    const run = await this.options.database.findTriggerRunById(step.triggerRunId);
    return (
      run?.outcome === "accepted" &&
      run.status === "running" &&
      run.deadlineAt.getTime() <= this.now()
    );
  }

  private async retryExecutionDeadline(executionId: string): Promise<void> {
    const execution = await this.options.database.findAgentExecutionById(executionId);
    if (execution === undefined || isTerminalExecutionStatus(execution.status)) {
      return;
    }

    this.clearExecutionDeadline(executionId);
    const clear = this.scheduleDeadline(async () => {
      await this.expireExecutionAtCurrentDeadline(executionId).catch((error: unknown) => {
        this.report(error, "daemon.execution.timeout.retry", { executionId });
        void this.retryExecutionDeadline(executionId).catch((retryError: unknown) => {
          this.report(retryError, "daemon.execution.timeout.retry-schedule", { executionId });
        });
      });
    }, 1_000);
    this.deadlineTimersByExecution.set(executionId, clear);
  }

  private async expireExecutionIfDeadlineElapsed(
    execution: AgentExecutionRecord,
  ): Promise<boolean> {
    const deadline = nextExecutionDeadline(execution);
    if (deadline === undefined || deadline.at.getTime() > this.now()) {
      return false;
    }

    return this.expireExecutionAtCurrentDeadline(execution.id);
  }

  private now(): number {
    return this.deadlineClock.now();
  }

  private scheduleDeadline(callback: () => Promise<void>, delayMs: number): () => void {
    return this.deadlineClock.schedule(async () => {
      try {
        await callback();
      } catch (error) {
        this.report(error, "daemon.deadline.callback");
      }
    }, delayMs);
  }

  private get deadlineClock(): ExecutionDeadlineClock {
    return this.options.test?.deadlineClock ?? systemExecutionDeadlineClock;
  }

  private completionToken(executionId: string): string {
    if (!this.options.completionTokenSecret) {
      throw new DaemonDispatchFailure("completion_auth_not_configured");
    }
    return deriveAgentExecutionCompletionToken(this.options.completionTokenSecret, executionId);
  }
}

function assertDispatchAuthority(
  intent: LaunchMachineIntent,
  run: Awaited<ReturnType<Database["findTriggerRunById"]>>,
  config: Awaited<ReturnType<Database["findProjectConfigurationRevision"]>>,
  daemonMachine: Awaited<ReturnType<Database["findMachineForOrganization"]>>,
): void {
  if (
    run === undefined ||
    run.organizationId !== intent.organizationId ||
    run.projectId !== intent.projectId ||
    config?.projectId !== intent.projectId ||
    daemonMachine?.orgId !== intent.organizationId
  ) {
    throw new DaemonDispatchFailure("tenant_authority_mismatch");
  }
}

function dispatchExecutionInput(
  intent: LaunchMachineIntent,
  daemon: DaemonRecord,
  { id, completionToken, deadlineAt }: { id: string; completionToken: string; deadlineAt: Date },
): Parameters<Database["insertAgentExecutionIfAbsent"]>[0] {
  return {
    id,
    organizationId: intent.organizationId,
    projectId: intent.projectId,
    machineId: daemon.machineId,
    daemonId: daemon.id,
    triggerContext: intent.triggerContext,
    outputContext: intent.outputContext,
    configurationRevisionId: intent.configurationRevisionId,
    completionTokenHash: hashAgentExecutionCompletionToken(completionToken),
    deadlineAt,
    workflowStepRunId: intent.workflowStepRunId ?? null,
    launchIntent: intent,
  };
}

function hasExecutionAuthority(
  options: DaemonDispatchLifecycleOptions,
): options is DaemonDispatchLifecycleOptions & { executionAuthority: ExecutionAuthority } {
  return Boolean(options.executionAuthority);
}

function isUnattachedSpawningExecution(execution: AgentExecutionRecord): boolean {
  return execution.status === "spawning" && execution.daemonAgentId === null;
}

function applyLaunchMaterialization(
  intent: LaunchMachineIntent,
  materialized: Awaited<ReturnType<NonNullable<TriggerProvider["materializeLaunch"]>>>,
  persistedWorktree: LaunchMachineIntent["environment"]["worktree"],
): LaunchMachineIntent {
  const {
    env: _persistedEnvironmentEnv,
    worktree: _persistedWorktree,
    ...environment
  } = intent.environment;
  const environmentWorktree = materialized.environmentWorktree ?? persistedWorktree;
  return {
    ...intent,
    environment: {
      ...environment,
      ...(materialized.environmentEnv === undefined ? {} : { env: materialized.environmentEnv }),
      ...(environmentWorktree === undefined ? {} : { worktree: environmentWorktree }),
    },
  };
}

function authorityLaunchOptions(authoredEnv: Record<string, string>, intent: LaunchMachineIntent) {
  return {
    ...(Object.keys(authoredEnv).length === 0 ? {} : { env: authoredEnv }),
    ...(intent.github === undefined ? {} : { github: intent.github }),
  };
}

function launchEnvironmentEnv(
  intent: LaunchMachineIntent,
  materialized: Awaited<ReturnType<NonNullable<TriggerProvider["materializeLaunch"]>>>,
) {
  return materialized.environmentEnv ?? intent.environment.env;
}

function assertIdleRefreshEvent(
  event: Exclude<DaemonAgentStreamEvent, { type: "thread_started" }>,
): void {
  switch (event.type) {
    case "timeline":
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
    case "permission_requested":
    case "permission_resolved":
    case "turn_started":
    case "attention_required":
      return;
  }
  assertNeverAgentStreamEvent(event);
}

function finishExecutionToolCall(event: DaemonAgentStreamEvent) {
  if (event.type !== "timeline" || event.item.type !== "tool_call") return undefined;
  const item = event.item;
  return isRecognizedFinishExecutionToolCall(item) ? item : undefined;
}

type TimelineItem = Extract<DaemonAgentStreamEvent, { type: "timeline" }>["item"];

function isRecognizedFinishExecutionToolCall(
  item: TimelineItem,
): item is TimelineItem & { callId: string; status: AgentExecutionHubFinishExecutionStatus } {
  return (
    typeof item.name === "string" &&
    isHubFinishExecutionToolName(item.name) &&
    typeof item.callId === "string" &&
    isHubFinishExecutionStatus(item.status)
  );
}

function isActiveExecution(
  execution: AgentExecutionRecord | undefined,
): execution is AgentExecutionRecord {
  return execution !== undefined && !isTerminalExecutionStatus(execution.status);
}

function daemonEventDeadlineElapsed(
  execution: AgentExecutionRecord,
  observedAt: Date,
  processedAt: Date,
): boolean {
  return (
    (execution.deadlineAt !== null && execution.deadlineAt.getTime() <= processedAt.getTime()) ||
    (execution.idleDeadlineAt !== null &&
      execution.idleDeadlineAt.getTime() <= observedAt.getTime())
  );
}

function assertCompletionExecutionExists(
  execution: AgentExecutionRecord | undefined,
): asserts execution is AgentExecutionRecord {
  if (execution === undefined) throw new AgentExecutionCompletionFailure("not_found");
}

function assertCompletionToken(
  execution: AgentExecutionRecord,
  input: CompletionCallbackInput,
): void {
  if (
    execution.completionTokenHash === null ||
    !verifyAgentExecutionCompletionToken(input.token, execution.completionTokenHash)
  ) {
    throw new AgentExecutionCompletionFailure("unauthorized");
  }
}

function validateCallbackOutput(
  execution: AgentExecutionRecord,
  input: CompletionCallbackInput,
): void {
  if (execution.launchIntent?.outputSchema !== undefined) {
    validateStructuredOutput(execution.launchIntent.outputSchema, input.output);
  }
}

function callbackCompletionOptions(
  input: CompletionCallbackInput,
  options: CompletionCallbackOptions,
): CompleteAgentExecutionOptions {
  return {
    completedByAgent: true,
    ...(options.deferHubAction === undefined ? {} : { deferHubAction: options.deferHubAction }),
    ...(input.output === undefined ? {} : { output: input.output }),
  };
}

function defersArchiveAcknowledgement(
  execution: AgentExecutionRecord,
  options: CompletionCallbackOptions,
): boolean {
  return options.deferHubAction === true && execution.hubAction === "archive";
}

interface ExecutionTransition {
  fields: TransitionAgentExecutionFields;
  workflow: Pick<
    WorkflowAgentCompletionInput,
    "stepStatus" | "stepOutput" | "failureReason" | "deadlineKind"
  >;
}

function successfulExecutionTransition(
  existing: AgentExecutionRecord,
  options: CompleteAgentExecutionOptions,
): ExecutionTransition {
  const structuredOutput =
    existing.launchIntent?.outputSchema === undefined || options.output === undefined
      ? undefined
      : jsonValue(options.output);
  const inferred = inferredTurnEndResult(
    options.turnEnd,
    existing.launchIntent?.replyMessage !== true,
  );
  return {
    fields: {
      result:
        inferred ??
        (structuredOutput === undefined
          ? { status: "succeeded" }
          : { status: "succeeded", output: options.output }),
      completedByAgent: options.completedByAgent === true,
    },
    workflow: {
      stepStatus: "succeeded",
      stepOutput: inferred ?? structuredOutput,
    },
  };
}

function failedExecutionTransition(
  current: AgentExecutionRecord,
  reason: string,
  details: FailAgentExecutionDetails,
  now: () => number,
): ExecutionTransition {
  const result = {
    status: "failed" as const,
    reason,
    ...(details.lastInvalidOutput === undefined
      ? {}
      : { lastInvalidOutput: details.lastInvalidOutput }),
  };
  const stepStatus = failedExecutionStepStatus(current, details, now);
  return {
    fields: {
      result,
      ...(details.alreadyInterrupted === true ? { hubAction: null } : {}),
      ...(details.deadlineCondition === undefined
        ? {}
        : { deadlineCondition: details.deadlineCondition }),
    },
    workflow: {
      stepStatus,
      stepOutput: result,
      failureReason: reason,
      ...(details.deadlineKind === undefined ? {} : { deadlineKind: details.deadlineKind }),
    },
  };
}

function failedExecutionStepStatus(
  current: AgentExecutionRecord,
  details: FailAgentExecutionDetails,
  now: () => number,
): "timed_out" | "failed" {
  const workflowDeadline =
    current.workflowStepRunId !== null && details.deadlineCondition !== undefined;
  return workflowDeadline ||
    (details.deadlineCondition?.kind === "hard" &&
      current.deadlineAt !== null &&
      current.deadlineAt.getTime() <= now())
    ? "timed_out"
    : "failed";
}

function isUnfinishedHubAction(
  execution: AgentExecutionRecord | undefined,
): execution is AgentExecutionRecord {
  return execution !== undefined && execution.hubActionCompletedAt === null;
}

function isCanceledInterruptAction(execution: AgentExecutionRecord, action: HubAction): boolean {
  return action === "interrupt" && isCanceledExecution(execution);
}

function stopInterruptDelivery(
  daemon: DaemonRecord | undefined,
  claim: { expired: boolean },
  state: StopInterruptState | null,
): "target_gone" | "delivery_unconfirmed" | StopInterruptState {
  if (daemon?.status === "revoked" && !stopInterruptMayHaveSent(state)) {
    return "target_gone";
  }
  if (claim.expired || state === null || stopInterruptMayHaveSent(state)) {
    return "delivery_unconfirmed";
  }
  return state;
}

function isTurnEndCandidate(
  execution: AgentExecutionRecord | undefined,
  stillWanted: () => boolean,
): execution is AgentExecutionRecord {
  return execution !== undefined && mayCompleteOnTurnEnd(execution) && stillWanted();
}

export function durableExecutionId(
  intent: Pick<
    LaunchMachineIntent,
    "triggerRunId" | "configurationRevisionId" | "triggerName" | "workflowStepRunId"
  >,
): string {
  const bytes = createHash("sha256")
    .update("paseo-durable-execution-v1\0")
    .update(intent.triggerRunId)
    .update("\0")
    .update(intent.configurationRevisionId)
    .update("\0")
    .update(intent.triggerName)
    .update("\0")
    .update(intent.workflowStepRunId ?? "")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function notifyIndividualExecution(
  provider: TriggerProvider,
  execution: AgentExecutionRecord,
  failureReason?: string,
): Promise<TriggerProviderReactionState> {
  if (execution.status === "failed") {
    return notifyAgentExecutionFailed({
      provider,
      triggerContext: execution.triggerContext,
      outputContext: execution.outputContext,
      reason: failureReason ?? executionFailureReason(execution) ?? "agent_execution_failed",
      reactionState: execution.reactionState,
    });
  } else if (execution.status === "succeeded") {
    return notifyAgentExecutionCompleted({
      provider,
      triggerContext: execution.triggerContext,
      outputContext: execution.outputContext,
      result: { status: "succeeded" },
      reactionState: execution.reactionState,
    });
  } else {
    return notifyAgentExecutionStarted({
      provider,
      triggerContext: execution.triggerContext,
      outputContext: execution.outputContext,
      reactionState: execution.reactionState,
    });
  }
}

function executionFailureReason(execution: AgentExecutionRecord | undefined): string | undefined {
  if (typeof execution?.result !== "object" || execution.result === null) return undefined;
  const reason = (execution.result as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function validateStructuredOutput(schema: JsonValue, output: unknown): asserts output is JsonValue {
  const validator = compileJsonSchema(schema).validate;
  if (!isJsonValue(output))
    throw new AgentExecutionOutputValidationFailure(["output must be valid JSON"]);
  if (validator(output)) return;
  const errors = formatJsonSchemaErrors(validator.errors);
  throw new AgentExecutionOutputValidationFailure(
    errors.length === 0 ? ["output is invalid"] : errors,
  );
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  }
  throw new AgentExecutionOutputValidationFailure(["output must be valid JSON"]);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && value !== null && Object.values(value).every(isJsonValue);
}

export function createDaemonDispatchLifecycle(
  options: DaemonDispatchLifecycleOptions,
): DaemonDispatchLifecycle {
  return new DaemonDispatchLifecycle(options);
}

function isTerminalExecutionStatus(status: AgentExecutionRecord["status"]): boolean {
  return status === "succeeded" || status === "failed";
}

/**
 * A finished turn stands in for finish_execution only when nothing else owns the outcome: the
 * agent has not finished explicitly, a finish call is not still in flight, and the step has no
 * output contract that free text could not meet.
 */
export function mayCompleteOnTurnEnd(execution: AgentExecutionRecord): boolean {
  const intent = execution.launchIntent;
  if (isTerminalExecutionStatus(execution.status)) return false;
  if (intent?.completeOnTurnEnd !== true || execution.completedByAgentAt !== null) return false;
  if (intent.outputSchema !== undefined) return false;
  if (intent.allowOutputs.some((output) => output.required === true)) return false;
  const finishCall = execution.hubActionAcknowledgements.finishExecutionCall;
  return (
    finishCall === null || (finishCall.status !== "running" && finishCall.status !== "completed")
  );
}

function isHubFinishExecutionStatus(
  value: unknown,
): value is AgentExecutionHubFinishExecutionStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "canceled";
}

function deriveHubAction(
  execution: AgentExecutionRecord,
  status: "succeeded" | "failed",
): HubAction | null {
  if (execution.daemonId === null) return null;
  if (execution.launchIntent?.autoArchive === true) return "archive";
  return status === "failed" ? "interrupt" : null;
}

function isInterruptedAgentState(state: { status: AgentStatus }): boolean {
  return state.status === "closed" || state.status === "error";
}

function toDaemonDispatchFailure(error: unknown): DaemonDispatchFailure {
  if (error instanceof AgentSessionError || error instanceof DaemonAgentError)
    return new DaemonDispatchFailure(error.message, { cause: error });
  if (error instanceof DaemonDispatchFailure) {
    return error;
  }

  if (error instanceof DaemonSpawnAckTimeoutError) {
    return new DaemonDispatchFailure("daemon_timeout", { cause: error });
  }

  return new DaemonDispatchFailure("internal", { cause: error });
}

function toDispatchPreparationFailure(error: unknown): DaemonDispatchFailure {
  const candidate =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "internal";
  const code = DISPATCH_PREPARATION_FAILURE_CODES.has(candidate) ? candidate : "internal";
  return new DaemonDispatchFailure(code, { cause: error });
}

const DISPATCH_PREPARATION_FAILURE_CODES = new Set([
  "discord_trigger_unavailable",
  "execution_authority_stopped",
  "execution_terminal",
  "github_authority_scope_invalid",
  "github_authority_unavailable",
  "github_integration_unavailable",
  "github_trigger_unavailable",
  "slack_trigger_unavailable",
]);

function isDurablePrelaunchFailure(error: unknown): error is DaemonDispatchFailure {
  return error instanceof DaemonDispatchFailure && error.reason === "daemon_not_registered";
}

async function buildCreateAgentOptions(
  intent: LaunchMachineIntent,
  hubExecutionEnv: {
    executionId: string;
    completionToken: string;
    publicBaseUrl: string;
  },
  capabilities: OutputExecutorRegistry,
  materializedEnv: Readonly<Record<string, string>>,
): Promise<DaemonCreateAgentOptions> {
  return {
    provider: intent.agent.provider,
    background: intent.background,
    title: EXECUTION_AGENT_TITLE,
    workspaceTitle: executionWorkspaceTitle(intent, hubExecutionEnv.executionId),
    ...(intent.agent.mode === undefined ? {} : { mode: intent.agent.mode }),
    ...(intent.agent.model === undefined ? {} : { model: intent.agent.model }),
    ...(intent.agent.thinkingOptionId === undefined
      ? {}
      : { thinkingOptionId: intent.agent.thinkingOptionId }),
    ...(intent.agent.options === undefined
      ? {}
      : { providerOptions: structuredClone(intent.agent.options) }),
    cwd: intent.environment.cwd,
    env: buildAgentEnv(intent, materializedEnv),
    mcpServers: {
      hub: buildExecutionCapabilityMcpServer(hubExecutionEnv),
    },
    ...(sendsToolPolicy(intent.agent.provider)
      ? {
          toolPolicy: executionToolPolicy({
            allowOutputs: intent.allowOutputs,
            outputContext: intent.outputContext,
            ...(intent.outputSchema === undefined ? {} : { outputSchema: intent.outputSchema }),
            capabilities,
          }),
        }
      : {}),
    ...(intent.environment.worktree === undefined
      ? {}
      : {
          worktree: intent.environment.worktree,
        }),
  };
}

/**
 * Paseo shows the agent title beside the workspace title, so the agent title is static and the
 * workspace carries the identity: an authored `run.title` when present, otherwise the trigger
 * name (which already carries the platform or the bot's job) and the execution prefix that tells
 * runs of one trigger apart. A continuation session keeps the titles from the execution that
 * created it. The daemon rejects titles over its limit, so clamp instead of failing.
 */
export const EXECUTION_AGENT_TITLE = "Hub agent";

export function executionWorkspaceTitle(
  intent: Pick<LaunchMachineIntent, "title" | "triggerName">,
  executionId: string,
): string {
  const authored = intent.title?.trim() ?? "";
  const title =
    authored.length > 0 ? authored : `Hub · ${intent.triggerName} · ${executionId.slice(0, 8)}`;
  return title.slice(0, MAX_EXPLICIT_AGENT_TITLE_CHARS).trim();
}

function buildAgentEnv(
  intent: LaunchMachineIntent,
  materializedEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...materializedEnv,
    PASEO_AGENT_PROVIDER: intent.agent.provider,
    ...(intent.agent.mode === undefined ? {} : { PASEO_AGENT_MODE: intent.agent.mode }),
    PASEO_HUB_CONFIG_JSON: JSON.stringify(intent.hubConfig),
  };
}

function optionalDeliveryId(triggerContext: unknown): { deliveryId?: string } {
  if (typeof triggerContext !== "object" || triggerContext === null) {
    return {};
  }

  if (!("deliveryId" in triggerContext)) {
    return {};
  }

  const { deliveryId } = triggerContext;
  return typeof deliveryId === "string" ? { deliveryId } : {};
}

function nextExecutionDeadline(execution: AgentExecutionRecord): ExecutionDeadline | undefined {
  if (execution.deadlineAt === null) {
    return execution.idleDeadlineAt === null
      ? undefined
      : { kind: "idle", at: execution.idleDeadlineAt };
  }
  if (
    execution.idleDeadlineAt === null ||
    execution.deadlineAt.getTime() <= execution.idleDeadlineAt.getTime()
  ) {
    return { kind: "hard", at: execution.deadlineAt };
  }
  return { kind: "idle", at: execution.idleDeadlineAt };
}

interface DeadlineFailure {
  reason: string;
  deadlineKind?: WorkflowDeadlineKind;
}

function deadlineFailure(
  execution: AgentExecutionRecord,
  deadline: ExecutionDeadline,
  wholeRunExpired: boolean,
): DeadlineFailure {
  if (wholeRunExpired) {
    return { reason: "whole_run_timeout", deadlineKind: "whole_run" };
  }
  if (execution.workflowStepRunId === null) {
    return { reason: deadline.kind === "idle" ? "idle_timeout" : "timeout" };
  }
  if (deadline.kind === "idle") {
    return { reason: "step_idle_timeout", deadlineKind: "step_idle" };
  }
  return { reason: "step_hard_timeout", deadlineKind: "step_hard" };
}

function hasProviderName(value: object): value is { provider?: unknown } {
  return "provider" in value;
}

function assertNeverAgentStreamEvent(value: never): never {
  throw new Error(`unhandled daemon agent stream event: ${JSON.stringify(value)}`);
}

async function withDispatchTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<T> {
  let clearTimer: (() => void) | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        clearTimer = schedule(() => {
          onTimeout();
          reject(new DaemonSpawnAckTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimer?.();
  }
}

async function withHubActionTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<T> {
  let clearTimer: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        clearTimer = schedule(
          () => reject(new Error("timed out waiting for daemon execution control ack")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimer?.();
  }
}
