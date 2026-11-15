import type { CompiledScriptStep, JsonValue } from "../config/compiler.js";
import type {
  AcceptedTriggerRunRecord,
  Database,
  WorkflowStepRunRecord,
  WorkflowWakeupRecord,
} from "../db/types.js";
import { durableExecutionId } from "../daemons/lifecycle.js";
import { ScriptRunAborted, type ScriptStepRunner } from "../daemons/terminals/script.js";
import { asTriggerContextValue, type TriggerProvider } from "../triggers/index.js";
import {
  readScriptStepHandle,
  scriptTerminalName,
  type ScriptStepResult,
} from "./script-output.js";

/** A terminal argument over this size would be refused by the host's exec limits. */
export const MAX_EVENT_JSON_BYTES = 100_000;
/** Time past the runner's own deadline for it to kill the terminal before deadline recovery acts. */
const KILL_GRACE_MS = 60_000;

export const SCRIPT_INTERRUPTED_REASON = "script interrupted: Hub restarted while it was running";
export const SCRIPT_RUNNER_UNAVAILABLE_REASON =
  "This Hub cannot run scripts: it has no daemon terminal channel.";

export interface ScriptStepRuntimeOptions {
  database: Database;
  runner: ScriptStepRunner | undefined;
  providers: readonly TriggerProvider[];
  now: () => Date;
  canDispatchToDaemon: ((daemonId: string) => boolean) | undefined;
  report: (error: unknown, operation: string, diagnostic?: Record<string, unknown>) => void;
  /** Fails the whole run with the reason and tells the run's source. */
  failRun: (triggerRunId: string, reason: string, stepId: string) => Promise<void>;
  /** Tells the run's source the first step has started. */
  notifyStarted: (triggerRunId: string) => Promise<void>;
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
}

/**
 * Runs script steps for the durable workflow engine. A script outlives the wakeup that starts it,
 * so each one is watched by a task of its own while the engine goes on with other runs. The step
 * is marked running before the terminal exists and is never started again: a restart finds it
 * running, stops whatever it left on the host, and fails it as interrupted.
 */
export class ScriptStepRuntime {
  private readonly active = new Map<string, ActiveScript>();

  constructor(private readonly options: ScriptStepRuntimeOptions) {}

  isActive(triggerRunId: string): boolean {
    return this.active.has(triggerRunId);
  }

  /** Aborts every watcher, which kills its terminal, and waits for them. */
  async stop(): Promise<void> {
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }

  /** Starts the script and returns once it is running. `deferred` means try again elsewhere. */
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
    this.active.set(run.id, { controller, done });
    await database.deleteWorkflowWakeup(run.id);
    return undefined;
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
    try {
      if (this.options.runner === undefined) throw new Error("no terminal channel");
      await this.options.runner.cleanup(launch.daemonId, {
        cwd: launch.cwd,
        name: scriptTerminalName(stepRun.id),
        terminalId: readScriptStepHandle(stepRun.output)?.terminal_id,
      });
    } catch (error) {
      this.options.report(error, "workflow.script.recover", {
        triggerRunId: run.id,
        stepId: step.id,
      });
      reason = `${reason}; Hub could not stop its terminal on the host`;
    }
    await this.finish(stepRun.id, "failed", reason, {
      exit_code: null,
      output_tail: "",
      truncated: false,
    });
    return undefined;
  }

  private async watch(
    launch: ScriptStepLaunch,
    eventJson: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { run, step, stepRun, daemonId } = launch;
    try {
      const result = await this.options.runner!.run(daemonId, {
        cwd: launch.cwd,
        script: step.script,
        eventJson,
        name: scriptTerminalName(stepRun.id),
        timeoutMs,
        signal,
        onTerminal: async ({ id }) => {
          await this.options.database.updateWorkflowScriptStep(stepRun.id, {
            status: "running",
            output: { terminal_id: id, daemon_id: daemonId },
            at: this.options.now(),
          });
        },
      });
      const reason =
        result.status === "timed_out"
          ? `script timed out after ${formatDuration(step.maxRuntimeMs)}`
          : result.failureReason;
      await this.finish(stepRun.id, result.status, reason, {
        exit_code: result.exitCode,
        output_tail: result.outputTail,
        truncated: result.truncated,
      });
    } catch (error) {
      // Shutdown: the terminal was killed and the step stays running for recovery to fail.
      if (error instanceof ScriptRunAborted) return;
      this.options.report(error, "workflow.script.run", {
        triggerRunId: run.id,
        stepId: step.id,
      });
      await this.finish(
        stepRun.id,
        "failed",
        `script failed: ${error instanceof Error ? error.message : String(error)}`,
        { exit_code: null, output_tail: "", truncated: false },
      ).catch((finishError: unknown) =>
        this.options.report(finishError, "workflow.script.finish", { triggerRunId: run.id }),
      );
    }
  }

  private async finish(
    stepRunId: string,
    status: "succeeded" | "failed" | "timed_out",
    failureReason: string | undefined,
    output: ScriptStepResult,
  ): Promise<void> {
    await this.options.database.updateWorkflowScriptStep(stepRunId, {
      status,
      output,
      ...(failureReason === undefined ? {} : { failureReason }),
      at: this.options.now(),
    });
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

function formatDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${String(milliseconds / 3_600_000)}h`;
  if (milliseconds % 60_000 === 0) return `${String(milliseconds / 60_000)}m`;
  if (milliseconds % 1_000 === 0) return `${String(milliseconds / 1_000)}s`;
  return `${String(milliseconds)}ms`;
}
