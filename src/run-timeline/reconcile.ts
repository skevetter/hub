import type { AcceptedTriggerRunRecord, Database, WorkflowStepRunRecord } from "../db/types.js";
import { readScriptStepResult } from "../workflows/script-output.js";
import type { RunTimelineBus } from "./bus.js";
import type {
  TimelineProjectionInput,
  TimelineQueue,
  TimelineRunScope,
  TimelineScrubber,
  TimelineStepCounts,
} from "./capture-types.js";
import { projectTimelineEvent } from "./project.js";
import { isRunTimelineExpired, retentionCutoff } from "./retention.js";
import type { TimelineOrigin } from "./store.js";

export interface RunTimelineReconcilerOptions {
  queue: TimelineQueue;
  maxEvents: number;
  retentionDays: number;
  scrub: TimelineScrubber;
  bus: RunTimelineBus;
  now?: () => Date;
  reportFailure?: (error: unknown, operation: string, scope?: TimelineRunScope) => void;
}

interface PendingReconciliation {
  rerun: boolean;
  promise: Promise<void>;
}

interface ReconciliationContext {
  scope: TimelineRunScope;
  run: AcceptedTriggerRunRecord;
  steps: WorkflowStepRunRecord[];
  origin: TimelineOrigin;
  now: Date;
  startedAt: Date;
}

function terminalStep(
  status: WorkflowStepRunRecord["status"],
): status is "succeeded" | "failed" | "timed_out" | "skipped" {
  return status !== "pending" && status !== "running";
}

function duration(start: Date | null, end: Date): number {
  return start === null ? 0 : Math.max(0, end.getTime() - start.getTime());
}

function earliestStepStart(steps: readonly WorkflowStepRunRecord[], fallback: Date): Date {
  let startedAt: Date | undefined;
  for (const step of steps) {
    if (step.startedAt !== null && (startedAt === undefined || step.startedAt < startedAt))
      startedAt = step.startedAt;
  }
  return startedAt ?? fallback;
}

export class RunTimelineReconciler {
  private readonly pending = new Map<string, PendingReconciliation>();
  private activeSweep: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private accepting = true;
  private closed = false;

  constructor(
    private readonly database: Database,
    private readonly options: RunTimelineReconcilerOptions,
  ) {}

  reconcile(organizationId: string, runId: string): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const scope = { organizationId, triggerRunId: runId };
    const key = JSON.stringify([organizationId, runId]);
    const current = this.pending.get(key);
    if (current) {
      current.rerun = true;
      return current.promise;
    }
    const completion = Promise.withResolvers<void>();
    const pending: PendingReconciliation = { rerun: false, promise: completion.promise };
    this.pending.set(key, pending);
    void this.performReconciliation(key, scope, pending).then(
      completion.resolve,
      completion.reject,
    );
    return pending.promise;
  }

  sweep(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    if (this.activeSweep) return this.activeSweep;
    const completion = Promise.withResolvers<void>();
    this.activeSweep = completion.promise;
    void this.performSweep().then(completion.resolve, completion.reject);
    return completion.promise;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.accepting = true;
    this.closed = false;
    this.schedule();
  }

  stopAdmission(): void {
    this.accepting = false;
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async stop(): Promise<void> {
    this.stopAdmission();
    try {
      await this.withDeadline(
        Promise.allSettled([
          ...(this.activeSweep ? [this.activeSweep] : []),
          ...Array.from(this.pending.values(), ({ promise }) => promise),
        ]).then(() => undefined),
      );
    } catch (error) {
      this.report(error, "run.timeline.stop");
    } finally {
      this.closed = true;
    }
  }

  async reconcileBeforeTerminal(organizationId: string, runId: string): Promise<void> {
    try {
      await this.withDeadline(this.reconcile(organizationId, runId));
    } catch (error) {
      this.report(error, "run.timeline.reconcile", { organizationId, triggerRunId: runId });
    }
  }

  private async withDeadline(operation: Promise<void>): Promise<void> {
    const deadline = Promise.withResolvers<void>();
    const timer = setTimeout(
      () => deadline.reject(new Error("Timeline reconciliation deadline exceeded")),
      2000,
    );
    timer.unref();
    try {
      await Promise.race([operation, deadline.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async performReconciliation(
    key: string,
    scope: TimelineRunScope,
    pending: PendingReconciliation,
  ): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      do {
        pending.rerun = false;
        try {
          await this.options.queue.run(scope, () => this.reconcileRun(scope));
        } catch (error) {
          failure ??= { error };
        }
      } while (pending.rerun);
      if (failure) throw failure.error;
    } finally {
      this.pending.delete(key);
    }
  }

  private async performSweep(): Promise<void> {
    try {
      const now = this.options.now?.() ?? new Date();
      const runs = await this.database.listUnsealedTerminalRuns(
        new Date(now.getTime() - 5000),
        retentionCutoff(now, this.options.retentionDays),
        500,
      );
      for (const run of runs) {
        if (!this.accepting) break;
        const scope = { organizationId: run.organizationId, triggerRunId: run.id };
        try {
          await this.reconcile(run.organizationId, run.id);
        } catch (error) {
          this.report(error, "run.timeline.reconcile", scope);
        }
      }
    } finally {
      this.activeSweep = undefined;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sweep()
        .catch((error: unknown) => {
          this.report(error, "run.timeline.reconcile.sweep");
        })
        .finally(() => this.schedule());
    }, 60_000);
    this.timer.unref();
  }

  private report(error: unknown, operation: string, scope?: TimelineRunScope): void {
    try {
      this.options.reportFailure?.(error, operation, scope);
    } catch {}
  }

  private async reconcileRun(scope: TimelineRunScope): Promise<void> {
    if (this.closed) return;
    const context = await this.readContext(scope);
    if (context === undefined) return;
    const { run, steps, origin, startedAt } = context;
    if (
      !(await this.append(scope, origin, startedAt, {
        kind: "run_started",
        trigger: run.configuredTriggerName,
        steps: steps.length,
      }))
    )
      return;
    const counts: TimelineStepCounts = {
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      skipped: 0,
      not_run: 0,
      total: steps.length,
    };
    let terminalCount = 0;
    for (const step of steps) {
      if (!(await this.appendStepStart(context, step))) return;
      if (!terminalStep(step.status)) {
        counts.not_run += 1;
        continue;
      }
      counts[step.status] += 1;
      terminalCount += 1;
      if (terminalCount <= 100 && !(await this.appendStepEnd(context, step, step.status))) return;
    }
    if (run.status === "running") return;
    const endedAt = run.completedAt ?? context.now;
    await this.append(scope, origin, endedAt, {
      kind: "run_finished",
      status: run.status,
      durationMs: duration(startedAt, endedAt),
      failure: run.failureReason,
      steps: counts,
      stepRowsOmitted: Math.max(0, terminalCount - 100),
    });
  }

  private async readContext(scope: TimelineRunScope): Promise<ReconciliationContext | undefined> {
    const run = await this.database.findTriggerRunForOrganization(
      scope.organizationId,
      scope.triggerRunId,
    );
    if (this.closed || run === undefined || run.outcome !== "accepted") return undefined;
    const state = await this.database.readRunTimelineState(
      scope.organizationId,
      scope.triggerRunId,
    );
    const now = this.options.now?.() ?? new Date();
    if (
      this.closed ||
      state?.sealedSeq != null ||
      isRunTimelineExpired(
        {
          completedAt: run.completedAt,
          expiredAt: state?.expiredAt ?? null,
        },
        retentionCutoff(now, this.options.retentionDays),
      )
    )
      return undefined;
    if (state === undefined && run.status === "running") return undefined;
    const steps = await this.database.listWorkflowStepRunsForTriggerRun(run.id);
    return {
      scope,
      run,
      steps,
      origin: state?.origin ?? "derived",
      now,
      startedAt: earliestStepStart(steps, run.createdAt),
    };
  }

  private async appendStepStart(
    context: ReconciliationContext,
    step: WorkflowStepRunRecord,
  ): Promise<boolean> {
    if (step.startedAt === null) return true;
    let intent = step.dispatchIntent;
    if (intent === null && step.agentExecutionId !== null) {
      intent =
        (await this.database.findAgentExecutionById(step.agentExecutionId))?.launchIntent ?? null;
    }
    const agent =
      step.agentExecutionId !== null && intent !== null
        ? {
            provider: intent.agent.provider,
            ...(intent.agent.mode === undefined ? {} : { mode: intent.agent.mode }),
          }
        : undefined;
    return this.append(
      context.scope,
      context.origin,
      step.startedAt,
      {
        kind: "step_started",
        type: step.agentExecutionId === null ? "script" : "agent",
        ...(agent === undefined ? {} : { agent }),
      },
      step.stepId,
    );
  }

  private async appendStepEnd(
    context: ReconciliationContext,
    step: WorkflowStepRunRecord,
    status: "succeeded" | "failed" | "timed_out" | "skipped",
  ): Promise<boolean> {
    const endedAt = step.completedAt ?? context.run.completedAt ?? context.now;
    const inferred =
      step.output !== null &&
      typeof step.output === "object" &&
      "completion" in step.output &&
      step.output.completion === "inferred_from_turn_end";
    return this.append(
      context.scope,
      context.origin,
      endedAt,
      {
        kind: "step_finished",
        status,
        durationMs: duration(step.startedAt, endedAt),
        failure: step.failureReason,
        ...(step.agentExecutionId === null
          ? { exitCode: readScriptStepResult(step.output)?.exit_code ?? null }
          : {}),
        ...(inferred ? { completion: "inferred_from_turn_end" } : {}),
      },
      step.stepId,
    );
  }

  private async append(
    scope: TimelineRunScope,
    origin: TimelineOrigin,
    at: Date,
    input: TimelineProjectionInput,
    stepId?: string,
  ): Promise<boolean> {
    if (this.closed) return false;
    const projected = projectTimelineEvent(input, this.options.scrub);
    if (projected === undefined) throw new Error("Persisted timeline event could not be projected");
    const result = await this.database.appendRunTimelineEvent({
      ...scope,
      ...projected,
      origin,
      at,
      maxEvents: this.options.maxEvents,
      ...(stepId === undefined ? {} : { stepId }),
    });
    if (!result) return false;
    if ("seq" in result) {
      if (result.inserted) this.options.bus.publish(scope.triggerRunId, result.seq);
      return true;
    }
    return result.reason === "cap";
  }
}
