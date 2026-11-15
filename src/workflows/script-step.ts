import type { CompiledScriptStep, JsonValue } from "../config/compiler.js";
import { retryWithBackoff, type BackoffPolicy, type RetryRuntime } from "../db/retry.js";
import type {
  AcceptedTriggerRunRecord,
  Database,
  WorkflowStepRunRecord,
  WorkflowWakeupRecord,
} from "../db/types.js";
import { durableExecutionId } from "../daemons/lifecycle.js";
import {
  ScriptRunAborted,
  type ScriptCleanupTarget,
  type ScriptStepRunner,
} from "../daemons/terminals/script.js";
import { asTriggerContextValue, type TriggerProvider } from "../triggers/index.js";
import {
  isScriptStepRun,
  readScriptStepHandle,
  readScriptStepResult,
  scriptTerminalName,
  stepRunIdFromTerminalName,
  type ScriptStepCleanup,
  type ScriptStepResult,
} from "./script-output.js";
import type { ScriptLimits } from "./script-limits.js";

/** A terminal argument over this size would be refused by the host's exec limits. */
export const MAX_EVENT_JSON_BYTES = 100_000;
/** Time past the runner's own deadline for it to kill the terminal before deadline recovery acts. */
const KILL_GRACE_MS = 60_000;
/** A step held back by a concurrency cap is looked at again after this long. */
const CAP_RETRY_MS = 2_000;
/** The sweep runs at most this often on its own. */
const SWEEP_INTERVAL_MS = 60_000;
/** Recording a finished script is worth waiting out a database outage for: about a minute. */
const FINISH_BACKOFF: BackoffPolicy = { baseMs: 500, factor: 2, capMs: 15_000, maxAttempts: 8 };

export const SCRIPT_INTERRUPTED_REASON = "script interrupted: Hub restarted while it was running";
export const SCRIPT_RUNNER_UNAVAILABLE_REASON =
  "This Hub cannot run scripts: it has no daemon terminal channel.";

const EMPTY_RESULT: ScriptStepResult = { exit_code: null, output_tail: "", truncated: false };

export interface ScriptStepRuntimeOptions {
  database: Database;
  runner: ScriptStepRunner | undefined;
  providers: readonly TriggerProvider[];
  limits: ScriptLimits;
  now: () => Date;
  canDispatchToDaemon: ((daemonId: string) => boolean) | undefined;
  report: (error: unknown, operation: string, diagnostic?: Record<string, unknown>) => void;
  /** Fails the whole run with the reason and tells the run's source. */
  failRun: (triggerRunId: string, reason: string, stepId: string) => Promise<void>;
  /** Tells the run's source the first step has started. */
  notifyStarted: (triggerRunId: string) => Promise<void>;
  /** Makes the retries of the watcher's database writes deterministic in tests. */
  retry?: RetryRuntime | undefined;
}

export interface ScriptStepLaunch {
  run: AcceptedTriggerRunRecord;
  step: CompiledScriptStep;
  stepRun: WorkflowStepRunRecord;
  daemonId: string;
  cwd: string;
  /** Another step of this run has already started, so the source has been told. */
  runAlreadyStarted: boolean;
}

interface ActiveScript {
  controller: AbortController;
  done: Promise<void>;
  daemonId: string;
  triggerKey: string;
}

/**
 * Runs script steps for the durable workflow engine. A script outlives the wakeup that starts it,
 * so each one is watched by a task of its own while the engine goes on with other runs. The step
 * is marked running before the terminal exists and is never started again: a restart finds it
 * running, stops whatever it left on the host, and fails it as interrupted.
 *
 * What is guaranteed: a terminal the daemon confirms stopped is recorded as clean, and one it does
 * not confirm is recorded on the step as a pending cleanup that the sweep retries whenever the
 * daemon connects, at start, and about once a minute. What is best effort: the sweep only looks
 * in directories named by a pending record, so a terminal Hub never heard of is not found.
 */
export class ScriptStepRuntime {
  private readonly active = new Map<string, ActiveScript>();
  private sweeping: Promise<void> | undefined;
  private lastSweepAt = 0;

  constructor(private readonly options: ScriptStepRuntimeOptions) {}

  isActive(triggerRunId: string): boolean {
    return this.active.has(triggerRunId);
  }

  /** Runs a live watcher handles, which need no wakeup of their own. */
  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  /** Aborts every watcher, which stops its terminal, and waits for them. */
  async stop(): Promise<void> {
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.all([...this.active.values()].map(({ done }) => done));
    await this.sweeping;
  }

  /** Starts the script and returns once it is running. `deferred` means try again later. */
  async start(
    launch: ScriptStepLaunch,
    wakeup: WorkflowWakeupRecord,
  ): Promise<"deferred" | undefined> {
    const { database } = this.options;
    const { run, step, stepRun } = launch;
    if (this.options.runner === undefined) {
      await this.options.failRun(run.id, SCRIPT_RUNNER_UNAVAILABLE_REASON, step.id);
      return undefined;
    }
    if (this.options.canDispatchToDaemon?.(launch.daemonId) === false) {
      await database.releaseWorkflowWakeup(run.id, this.options.now(), wakeup.leaseExpiresAt!);
      return "deferred";
    }
    if (this.atCapacity(launch)) {
      // The step stays pending. Its wakeup comes back after a pause, not at the next tick.
      const now = this.options.now();
      await database.releaseWorkflowWakeup(
        run.id,
        now,
        wakeup.leaseExpiresAt!,
        new Date(now.getTime() + CAP_RETRY_MS),
      );
      return "deferred";
    }
    const eventJson = await this.eventJson(launch);
    if (eventJson === undefined) return undefined;
    const startedAt = this.options.now();
    const timeoutMs = Math.min(step.maxRuntimeMs, run.deadlineAt.getTime() - startedAt.getTime());
    const started = await database.startWorkflowScriptStep({
      stepRunId: stepRun.id,
      startedAt,
      deadlineAt: new Date(
        Math.min(run.deadlineAt.getTime(), startedAt.getTime() + timeoutMs + KILL_GRACE_MS),
      ),
      // Named from the start, so a step that ends before it has a terminal can still be cleaned up.
      output: { daemon_id: launch.daemonId, cwd: launch.cwd },
    });
    if (started?.started !== true) {
      await database.deleteWorkflowWakeup(run.id);
      return undefined;
    }
    if (!launch.runAlreadyStarted) await this.options.notifyStarted(run.id);
    const controller = new AbortController();
    const done = this.watch(launch, eventJson, Math.max(timeoutMs, 0), controller.signal)
      .catch((error: unknown) =>
        this.options.report(error, "workflow.script.watch", { triggerRunId: run.id }),
      )
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, {
      controller,
      done,
      daemonId: launch.daemonId,
      triggerKey: triggerKey(run),
    });
    await database.deleteWorkflowWakeup(run.id);
    return undefined;
  }

  private atCapacity(launch: ScriptStepLaunch): boolean {
    const { maxPerDaemon, maxPerTrigger } = this.options.limits;
    const key = triggerKey(launch.run);
    let onDaemon = 0;
    let onTrigger = 0;
    for (const running of this.active.values()) {
      if (running.daemonId === launch.daemonId) onDaemon += 1;
      if (running.triggerKey === key) onTrigger += 1;
    }
    return onDaemon >= maxPerDaemon || onTrigger >= maxPerTrigger;
  }

  /**
   * A step left running by a Hub that is gone. Its terminal is stopped and the step fails; the
   * script is not run again, because it may not be safe to repeat.
   */
  async recoverOrphan(
    launch: ScriptStepLaunch,
    wakeup: WorkflowWakeupRecord,
  ): Promise<"deferred" | undefined> {
    const { database } = this.options;
    const { run, step, stepRun } = launch;
    if (this.isActive(run.id)) {
      await database.deleteWorkflowWakeup(run.id);
      return undefined;
    }
    if (this.options.canDispatchToDaemon?.(launch.daemonId) === false) {
      await database.releaseWorkflowWakeup(run.id, this.options.now(), wakeup.leaseExpiresAt!);
      return "deferred";
    }
    let reason = SCRIPT_INTERRUPTED_REASON;
    const handle = readScriptStepHandle(stepRun.output);
    const target: ScriptCleanupTarget = {
      cwd: launch.cwd,
      name: scriptTerminalName(stepRun.id),
      terminalId: handle?.terminal_id,
      workspaceId: handle?.workspace_id,
    };
    let output: ScriptStepResult = EMPTY_RESULT;
    try {
      if (this.options.runner === undefined) throw new Error("no terminal channel");
      await this.options.runner.cleanup(launch.daemonId, target);
    } catch (error) {
      this.options.report(error, "workflow.script.recover", {
        triggerRunId: run.id,
        stepId: step.id,
      });
      reason = `${reason}; Hub could not confirm its terminal on the host stopped`;
      output = { ...EMPTY_RESULT, cleanup: cleanupRecord(launch.daemonId, target) };
    }
    await this.finish(stepRun.id, "failed", reason, output);
    return undefined;
  }

  /**
   * Deadline recovery ended these runs' steps in the database without touching the host. Stop
   * the terminals of their script steps, unless a live watcher is doing it already.
   */
  async cleanupAfterDeadline(triggerRunId: string): Promise<void> {
    if (this.isActive(triggerRunId)) return;
    const steps = await this.options.database.listWorkflowStepRunsForTriggerRun(triggerRunId);
    for (const step of steps) await this.settleEndedStep(step);
  }

  /**
   * Stops what pending records name, then every leftover script terminal in their directories
   * that no running step owns. Called when a daemon connects, at start, and about once a minute.
   */
  sweep(daemonId?: string): Promise<void> {
    // One at a time: a sweep that starts while another runs waits, so a daemon that connected
    // meanwhile is still covered.
    const run: Promise<void> = (this.sweeping ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.sweepNow(daemonId))
      .finally(() => {
        this.lastSweepAt = this.options.now().getTime();
        if (this.sweeping === run) this.sweeping = undefined;
      });
    this.sweeping = run;
    return run;
  }

  /** Starts a sweep in the background when none has run for a while. */
  sweepIfDue(): void {
    if (this.sweeping !== undefined || this.options.runner === undefined) return;
    if (this.options.now().getTime() - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = this.options.now().getTime();
    void this.sweep().catch((error: unknown) =>
      this.options.report(error, "workflow.script.sweep"),
    );
  }

  private async sweepNow(daemonId: string | undefined): Promise<void> {
    const { database, runner } = this.options;
    if (runner === undefined) return;
    const pending = (await database.listWorkflowScriptStepsPendingCleanup()).filter((step) => {
      const target = pendingDaemon(step);
      return (
        target !== undefined &&
        (daemonId === undefined || target === daemonId) &&
        this.options.canDispatchToDaemon?.(target) !== false &&
        !this.active.has(step.triggerRunId)
      );
    });
    // Each place to look once: the workspace the daemon chose when a record has it, else the directory.
    const places = new Map<string, { daemon: string; cwd: string; workspaceId?: string }>();
    for (const step of pending) {
      await this.settleEndedStep(step);
      const target = pendingTarget(step);
      if (target === undefined) continue;
      const workspaceId = target.workspaceId;
      places.set(`${target.daemonId}\0${workspaceId ?? target.cwd}`, {
        daemon: target.daemonId,
        cwd: target.cwd,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });
    }
    for (const { daemon, ...scope } of places.values()) {
      try {
        await runner.sweep(daemon, scope, (name) => this.ownedByRunningStep(name));
      } catch (error) {
        this.options.report(error, "workflow.script.sweep", { daemonId: daemon });
      }
    }
  }

  /** A terminal a running step owns is not a leftover, whatever process holds its watcher. */
  private async ownedByRunningStep(name: string): Promise<boolean> {
    const stepRunId = stepRunIdFromTerminalName(name);
    if (stepRunId === undefined) return false;
    const step = await this.options.database.findWorkflowStepRunById(stepRunId);
    return step?.status === "running" || step?.status === "pending";
  }

  /**
   * An ended step whose output still names a terminal: stop it, and when the daemon confirms,
   * leave the plain result. When it does not, keep a pending record for the sweep.
   */
  private async settleEndedStep(step: WorkflowStepRunRecord): Promise<void> {
    if (
      step.status === "running" ||
      step.status === "pending" ||
      !isScriptStepRun(step) ||
      this.options.runner === undefined
    ) {
      return;
    }
    const target = pendingTarget(step);
    if (target === undefined) return;
    const { daemonId, ...cleanup } = target;
    try {
      await this.options.runner.cleanup(daemonId, cleanup);
    } catch (error) {
      this.options.report(error, "workflow.script.cleanup", {
        triggerRunId: step.triggerRunId,
        stepId: step.stepId,
      });
      const kept = readScriptStepResult(step.output) ?? EMPTY_RESULT;
      await this.options.database.setWorkflowScriptStepOutput(step.id, {
        ...kept,
        cleanup: cleanupRecord(daemonId, cleanup),
      });
      return;
    }
    const { cleanup: _confirmed, ...result } = readScriptStepResult(step.output) ?? EMPTY_RESULT;
    await this.options.database.setWorkflowScriptStepOutput(step.id, result);
  }

  private async watch(
    launch: ScriptStepLaunch,
    eventJson: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { run, step, stepRun, daemonId } = launch;
    let result;
    try {
      result = await this.options.runner!.run(daemonId, {
        cwd: launch.cwd,
        script: step.script,
        eventJson,
        name: scriptTerminalName(stepRun.id),
        timeoutMs,
        signal,
        onTerminal: async ({ id, workspaceId }) => {
          await this.persist(() =>
            this.options.database.updateWorkflowScriptStep(stepRun.id, {
              status: "running",
              output: {
                daemon_id: daemonId,
                cwd: launch.cwd,
                terminal_id: id,
                ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
              },
              at: this.options.now(),
            }),
          );
        },
      });
    } catch (error) {
      // Shutdown: the terminal was stopped and the step stays running for recovery to fail.
      if (error instanceof ScriptRunAborted) return;
      this.options.report(error, "workflow.script.run", {
        triggerRunId: run.id,
        stepId: step.id,
      });
      await this.finish(
        stepRun.id,
        "failed",
        `script failed: ${error instanceof Error ? error.message : String(error)}`,
        EMPTY_RESULT,
      ).catch((finishError: unknown) =>
        this.options.report(finishError, "workflow.script.finish", { triggerRunId: run.id }),
      );
      return;
    }
    const reason =
      result.status === "timed_out"
        ? timeoutReason(step.maxRuntimeMs, timeoutMs)
        : result.failureReason;
    await this.finish(stepRun.id, result.status, reason, {
      exit_code: result.exitCode,
      output_tail: result.outputTail,
      truncated: result.truncated,
      ...(result.cleanup === undefined ? {} : { cleanup: cleanupRecord(daemonId, result.cleanup) }),
    }).catch((finishError: unknown) =>
      this.options.report(finishError, "workflow.script.finish", { triggerRunId: run.id }),
    );
  }

  /** A transient database error must not turn a script that ran into one that failed. */
  private persist<T>(operation: () => Promise<T>): Promise<T> {
    return retryWithBackoff(operation, {
      policy: FINISH_BACKOFF,
      ...this.options.retry,
      onRetry: ({ attempt, error }) =>
        this.options.report(error, "workflow.script.persist.retry", { attempt }),
    });
  }

  private async finish(
    stepRunId: string,
    status: "succeeded" | "failed" | "timed_out",
    failureReason: string | undefined,
    output: ScriptStepResult,
  ): Promise<void> {
    await this.persist(() =>
      this.options.database.updateWorkflowScriptStep(stepRunId, {
        status,
        output,
        ...(failureReason === undefined ? {} : { failureReason }),
        at: this.options.now(),
      }),
    );
  }

  /** The JSON for HUB_EVENT_JSON: the same context an agent prompt gets for `paseo.context`. */
  private async eventJson(launch: ScriptStepLaunch): Promise<string | undefined> {
    const { run, step } = launch;
    let json: string;
    try {
      json = JSON.stringify(await this.eventContext(launch));
    } catch (error) {
      this.options.report(error, "workflow.script.context", {
        triggerRunId: run.id,
        stepId: step.id,
      });
      await this.options.failRun(
        run.id,
        error instanceof Error ? error.message : "trigger_context_unavailable",
        step.id,
      );
      return undefined;
    }
    if (Buffer.byteLength(json) > MAX_EVENT_JSON_BYTES) {
      await this.options.failRun(
        run.id,
        `The event data is larger than ${String(MAX_EVENT_JSON_BYTES)} bytes, which is too large to pass to a script.`,
        step.id,
      );
      return undefined;
    }
    return json;
  }

  private async eventContext(launch: ScriptStepLaunch): Promise<JsonValue> {
    const { run, stepRun } = launch;
    const triggerContext: unknown = run.triggerContext;
    const providerName =
      typeof triggerContext === "object" &&
      triggerContext !== null &&
      "provider" in triggerContext &&
      typeof triggerContext.provider === "string"
        ? triggerContext.provider
        : undefined;
    const provider = this.options.providers.find(({ name }) => name === providerName);
    if (provider?.materializeContext !== undefined) {
      return asTriggerContextValue(
        await provider.materializeContext({
          executionId: durableExecutionId({
            triggerRunId: run.id,
            configurationRevisionId: run.configurationRevisionId,
            triggerName: run.configuredTriggerName,
            workflowStepRunId: stepRun.id,
          }),
          organizationId: run.organizationId,
          projectId: run.projectId,
          providerEventReceiptId: run.providerEventReceiptId,
          triggerContext: run.triggerContext,
        }),
      );
    }
    // A manual run has no provider-side history to fetch; its own input is the event.
    if (
      providerName === "manual" &&
      typeof triggerContext === "object" &&
      triggerContext !== null &&
      "event" in triggerContext
    ) {
      return asTriggerContextValue(triggerContext.event);
    }
    throw new Error("trigger_context_materializer_unavailable");
  }
}

function triggerKey(run: AcceptedTriggerRunRecord): string {
  return `${run.projectId}\0${run.configuredTriggerName}`;
}

function cleanupRecord(daemonId: string, target: ScriptCleanupTarget): ScriptStepCleanup {
  return {
    daemon_id: daemonId,
    cwd: target.cwd,
    name: target.name,
    ...(target.terminalId === undefined ? {} : { terminal_id: target.terminalId }),
    ...(target.workspaceId === undefined ? {} : { workspace_id: target.workspaceId }),
  };
}

/** The daemon an ended step's output says holds its terminal, from a handle or a pending record. */
function pendingDaemon(step: WorkflowStepRunRecord): string | undefined {
  return pendingTarget(step)?.daemonId;
}

function pendingTarget(
  step: WorkflowStepRunRecord,
): (ScriptCleanupTarget & { daemonId: string }) | undefined {
  // An agent step's output is whatever the agent produced, so its shape proves nothing.
  if (!isScriptStepRun(step)) return undefined;
  const result = readScriptStepResult(step.output);
  if (result?.cleanup !== undefined) {
    const { cleanup } = result;
    return {
      daemonId: cleanup.daemon_id,
      cwd: cleanup.cwd,
      name: cleanup.name,
      terminalId: cleanup.terminal_id,
      workspaceId: cleanup.workspace_id,
    };
  }
  const handle = readScriptStepHandle(step.output);
  if (handle === undefined) return undefined;
  return {
    daemonId: handle.daemon_id,
    cwd: handle.cwd,
    name: scriptTerminalName(step.id),
    terminalId: handle.terminal_id,
    workspaceId: handle.workspace_id,
  };
}

/** Says which deadline ended the script: its own, or the trigger's when that came first. */
function timeoutReason(configuredMs: number, effectiveMs: number): string {
  // The trigger deadline is measured from when the run was accepted, so a few milliseconds
  // shorter than the step's own limit is the step's limit.
  if (formatDuration(effectiveMs) === formatDuration(configuredMs) || effectiveMs >= configuredMs) {
    return `script timed out after ${formatDuration(configuredMs)}`;
  }
  return `script timed out after ${formatDuration(effectiveMs)}, when the trigger's deadline came first (the step allows ${formatDuration(configuredMs)})`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 1_000) milliseconds = Math.round(milliseconds / 1_000) * 1_000;
  if (milliseconds % 3_600_000 === 0) return `${String(milliseconds / 3_600_000)}h`;
  if (milliseconds % 60_000 === 0) return `${String(milliseconds / 60_000)}m`;
  if (milliseconds % 1_000 === 0) return `${String(milliseconds / 1_000)}s`;
  return `${String(milliseconds)}ms`;
}
