import type { Database, AcceptedTriggerRunRecord, WorkflowStepRunRecord } from "../db/types.js";
import type { DaemonAgentStreamEvent } from "../daemons/protocol.js";
import type { RunTimelineBus } from "./bus.js";
import type {
  ProjectedTimelineEvent,
  TimelineProjectionInput,
  TimelineQueue,
  TimelineRunScope,
  TimelineScrubber,
} from "./capture-types.js";
import { timelineDedupeKey } from "./data.js";
import { projectTimelineEvent } from "./project.js";
import { RunTimelineQueue } from "./queue.js";
import { isRunTimelineExpired, retentionCutoff } from "./retention.js";

interface ExecutionAssociation extends TimelineRunScope {
  stepId: string;
}

interface PendingAgentEvent {
  event: ProjectedTimelineEvent;
  at: Date;
  key: string | undefined;
}

interface ExecutionCapture {
  binding: Promise<ExecutionAssociation | undefined>;
  scope: TimelineRunScope | undefined;
  pending: PendingAgentEvent[];
  dropped: number;
  seen: Set<string>;
  disabled: boolean;
}

export interface RunTimelineOptions {
  maxEvents: number;
  retentionDays: number;
  scrub: TimelineScrubber;
  bus: RunTimelineBus;
  now?: () => Date;
  reportFailure?: (error: unknown, operation: string, scope?: TimelineRunScope) => void;
}

export class RunTimeline implements TimelineQueue {
  private readonly queue: RunTimelineQueue;
  private readonly executions = new Map<string, ExecutionCapture>();
  private readonly bindings = new Set<Promise<ExecutionAssociation | undefined>>();
  private closed = false;
  private stopping = false;

  constructor(
    private readonly database: Database,
    private readonly options: RunTimelineOptions,
  ) {
    this.queue = new RunTimelineQueue(database, options);
  }

  begin(executionId: string, scope?: TimelineRunScope): void {
    if (this.closed || this.stopping || this.executions.has(executionId)) return;
    const binding = this.resolveAssociation(executionId, scope);
    const capture: ExecutionCapture = {
      binding,
      scope,
      pending: [],
      dropped: 0,
      seen: new Set(),
      disabled: false,
    };
    this.executions.set(executionId, capture);
    this.bindings.add(binding);
    void binding
      .then((association) => {
        if (association === undefined || this.closed) {
          capture.disabled = true;
          capture.pending.length = 0;
          return false;
        }
        capture.scope = association;
        const pending = capture.pending;
        capture.pending = [];
        for (const item of pending) {
          this.queue.enqueue(association, () => this.appendAgentEvent(capture, item));
        }
        this.queue.recordDrops(association, capture.dropped);
        capture.dropped = 0;
        return true;
      })
      .catch((error: unknown) => {
        capture.disabled = true;
        capture.pending.length = 0;
        this.report(error, "run.timeline.capture", capture.scope);
      })
      .finally(() => this.bindings.delete(binding));
  }

  release(executionId: string): void {
    this.executions.delete(executionId);
  }

  observeAgentEvent(
    executionId: string,
    event: DaemonAgentStreamEvent,
    observedAt: Date,
    source: "live" | "snapshot" = "live",
  ): void {
    const capture = this.executions.get(executionId);
    if (
      this.closed ||
      this.stopping ||
      capture === undefined ||
      capture.disabled ||
      source === "snapshot" ||
      event["source"] === "snapshot"
    )
      return;
    try {
      const projected = projectTimelineEvent({ kind: "agent_event", event }, this.options.scrub);
      if (projected === undefined) return;
      const key = timelineDedupeKey(projected.kind, "", projected.data);
      if (key !== undefined && capture.seen.has(key)) return;
      const item = { event: projected, at: observedAt, key };
      if (capture.scope === undefined) {
        if (capture.pending.length >= 200) {
          capture.dropped += 1;
          return;
        }
        capture.pending.push(item);
      } else if (!this.queue.enqueue(capture.scope, () => this.appendAgentEvent(capture, item)))
        return;
      if (key !== undefined) capture.seen.add(key);
    } catch (error) {
      this.report(error, "run.timeline.capture", capture.scope);
    }
  }

  recordRunStart(scope: TimelineRunScope): void {
    if (this.closed || this.stopping) return;
    this.queue.enqueue(scope, async () => {
      const context = await this.startContext(scope);
      if (context === undefined) return;
      await this.append(scope, "", context.at, {
        kind: "run_started",
        trigger: context.run.configuredTriggerName,
        steps: context.steps.length,
      });
    });
  }

  recordStepStart(scope: TimelineRunScope, stepId: string): void {
    if (this.closed || this.stopping) return;
    this.queue.enqueue(scope, async () => {
      const context = await this.startContext(scope);
      if (context === undefined) return;
      const step = context.steps.find((candidate) => candidate.stepId === stepId);
      if (step?.startedAt == null) return;
      await this.append(scope, "", context.at, {
        kind: "run_started",
        trigger: context.run.configuredTriggerName,
        steps: context.steps.length,
      });
      const execution =
        step.agentExecutionId === null
          ? undefined
          : await this.database.findAgentExecutionById(step.agentExecutionId);
      const agent = step.dispatchIntent?.agent ?? execution?.launchIntent?.agent;
      await this.append(scope, stepId, step.startedAt, {
        kind: "step_started",
        type: step.agentExecutionId === null ? "script" : "agent",
        ...(agent === undefined
          ? {}
          : {
              agent: {
                provider: agent.provider,
                ...(agent.mode === undefined ? {} : { mode: agent.mode }),
              },
            }),
      });
    });
  }

  run(scope: TimelineRunScope, operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Timeline capture is closed"));
    return this.queue.run(scope, operation);
  }

  depth(): number {
    let total = this.queue.depth();
    for (const capture of this.executions.values()) total += capture.pending.length;
    return total;
  }

  activeExecutionCount(): number {
    return this.executions.size;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.executions.clear();
    await this.flush(2000);
    this.closed = true;
  }

  async flush(deadlineMs = 2000): Promise<void> {
    const started = performance.now();
    const deadline = Promise.withResolvers<void>();
    const timer = setTimeout(() => deadline.resolve(), deadlineMs);
    timer.unref();
    try {
      await Promise.race([Promise.allSettled(this.bindings), deadline.promise]);
      const remaining = Math.max(0, deadlineMs - (performance.now() - started));
      if (remaining === 0) {
        this.closed = true;
        for (const capture of this.executions.values()) capture.pending.length = 0;
      }
      if (!(await this.queue.flush(remaining))) this.closed = true;
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveAssociation(
    executionId: string,
    expected?: TimelineRunScope,
  ): Promise<ExecutionAssociation | undefined> {
    const association = await this.database.resolveRunForExecution(executionId);
    if (association === undefined) return undefined;
    if (
      expected !== undefined &&
      (association.organizationId !== expected.organizationId ||
        association.triggerRunId !== expected.triggerRunId)
    )
      return undefined;
    const run = await this.database.findTriggerRunForOrganization(
      association.organizationId,
      association.triggerRunId,
    );
    if (
      run === undefined ||
      run.outcome !== "accepted" ||
      isRunTimelineExpired(
        run,
        retentionCutoff(this.options.now?.() ?? new Date(), this.options.retentionDays),
      )
    )
      return undefined;
    return association;
  }

  private async appendAgentEvent(
    capture: ExecutionCapture,
    item: PendingAgentEvent,
  ): Promise<void> {
    try {
      const association = await capture.binding;
      if (association === undefined || this.closed) return;
      const result = await this.database.appendRunTimelineEvent({
        ...association,
        kind: item.event.kind,
        data: item.event.data,
        at: item.at,
        origin: "captured",
        maxEvents: this.options.maxEvents,
      });
      if (result === undefined || "reason" in result) {
        if (item.key !== undefined) capture.seen.delete(item.key);
        return;
      }
      if (result.inserted) this.publish(association, result.seq);
    } catch (error) {
      if (item.key !== undefined) capture.seen.delete(item.key);
      throw error;
    }
  }

  private async startContext(
    scope: TimelineRunScope,
  ): Promise<
    { run: AcceptedTriggerRunRecord; steps: WorkflowStepRunRecord[]; at: Date } | undefined
  > {
    const run = await this.database.findTriggerRunForOrganization(
      scope.organizationId,
      scope.triggerRunId,
    );
    if (run === undefined || run.outcome !== "accepted") return undefined;
    const state = await this.database.readRunTimelineState(
      scope.organizationId,
      scope.triggerRunId,
    );
    if (
      isRunTimelineExpired(
        { completedAt: run.completedAt, expiredAt: state?.expiredAt ?? null },
        retentionCutoff(this.options.now?.() ?? new Date(), this.options.retentionDays),
      )
    )
      return undefined;
    const steps = await this.database.listWorkflowStepRunsForTriggerRun(scope.triggerRunId);
    let at: Date | undefined;
    for (const step of steps)
      if (step.startedAt !== null && (at === undefined || step.startedAt < at)) at = step.startedAt;
    return { run, steps, at: at ?? run.createdAt };
  }

  private async append(
    scope: TimelineRunScope,
    stepId: string,
    at: Date,
    input: TimelineProjectionInput,
  ): Promise<void> {
    if (this.closed) return;
    const event = projectTimelineEvent(input, this.options.scrub);
    if (event === undefined) return;
    const result = await this.database.appendRunTimelineEvent({
      ...scope,
      stepId,
      at,
      kind: event.kind,
      data: event.data,
      origin: "captured",
      maxEvents: this.options.maxEvents,
    });
    if (result !== undefined && "seq" in result && result.inserted) this.publish(scope, result.seq);
  }

  private publish(scope: TimelineRunScope, seq: number): void {
    try {
      this.options.bus.publish(scope.triggerRunId, seq);
    } catch (error) {
      this.report(error, "run.timeline.notify", scope);
    }
  }

  private report(error: unknown, operation: string, scope?: TimelineRunScope): void {
    try {
      this.options.reportFailure?.(error, operation, scope);
    } catch {}
  }
}
