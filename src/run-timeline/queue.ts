import type { Database } from "../db/types.js";
import type { TimelineQueue, TimelineRunScope } from "./capture-types.js";
import type { RunTimelineBus } from "./bus.js";

interface TimelineWork {
  operation: () => Promise<void>;
  ordinary: boolean;
  resolve?: () => void;
  reject?: (error: unknown) => void;
  next?: TimelineWork | undefined;
}

interface PendingRun {
  scope: TimelineRunScope;
  head?: TimelineWork | undefined;
  executing?: TimelineWork | undefined;
  tail?: TimelineWork | undefined;
  running: boolean;
  ordinaryCount: number;
  controlCount: number;
  dropped: number;
  dropsReady: boolean;
}

export interface RunTimelineQueueOptions {
  bus: RunTimelineBus;
  now?: () => Date;
  reportFailure?: (error: unknown, operation: string, scope?: TimelineRunScope) => void;
}

export class RunTimelineQueue implements TimelineQueue {
  private readonly queues = new Map<string, PendingRun>();
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  private lastFailureAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: Pick<Database, "recordRunTimelineDrops">,
    private readonly options: RunTimelineQueueOptions,
  ) {}

  enqueue(scope: TimelineRunScope, operation: () => Promise<void>): boolean {
    if (this.closed) return false;
    const queue = this.pending(scope);
    if (queue.ordinaryCount >= 200) {
      queue.dropped += 1;
      queue.dropsReady = true;
      return false;
    }
    queue.ordinaryCount += 1;
    this.append(queue, { operation, ordinary: true });
    return true;
  }

  recordDrops(scope: TimelineRunScope, count: number): void {
    if (this.closed || count === 0) return;
    const queue = this.pending(scope);
    queue.dropped += count;
    queue.dropsReady = true;
    this.start(queue);
  }

  run(scope: TimelineRunScope, operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Timeline capture queue is closed"));
    const queue = this.pending(scope);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    queue.controlCount += 1;
    this.append(queue, { operation, ordinary: false, resolve, reject });
    return promise;
  }

  depth(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.ordinaryCount + queue.controlCount;
    return total;
  }

  async flush(deadlineMs = 2000): Promise<boolean> {
    const deadline = Promise.withResolvers<"deadline">();
    const timer = setTimeout(() => deadline.resolve("deadline"), deadlineMs);
    timer.unref();
    const drain = async () => {
      while (this.active.size !== 0) await Promise.allSettled(this.active);
      return "drained" as const;
    };
    try {
      const result = await Promise.race([drain(), deadline.promise]);
      if (result === "deadline") this.closePending();
      return result === "drained";
    } finally {
      clearTimeout(timer);
    }
  }

  private pending(scope: TimelineRunScope): PendingRun {
    let queue = this.queues.get(scope.triggerRunId);
    if (queue === undefined) {
      queue = {
        scope,
        running: false,
        ordinaryCount: 0,
        controlCount: 0,
        dropped: 0,
        dropsReady: false,
      };
      this.queues.set(scope.triggerRunId, queue);
    } else if (queue.scope.organizationId !== scope.organizationId) {
      throw new Error("Timeline queue organization mismatch");
    }
    return queue;
  }

  private append(queue: PendingRun, work: TimelineWork): void {
    if (queue.tail === undefined) queue.head = work;
    else queue.tail.next = work;
    queue.tail = work;
    queue.dropsReady = true;
    this.start(queue);
  }

  private start(queue: PendingRun): void {
    if (queue.running || this.closed) return;
    queue.running = true;
    const operation = this.drain(queue);
    this.active.add(operation);
    void operation
      .finally(() => {
        this.active.delete(operation);
        queue.running = false;
        if (!this.closed && (queue.head !== undefined || (queue.dropped !== 0 && queue.dropsReady)))
          this.start(queue);
        else if (
          (this.closed || queue.dropped === 0) &&
          this.queues.get(queue.scope.triggerRunId) === queue
        )
          this.queues.delete(queue.scope.triggerRunId);
      })
      .catch((error: unknown) => this.report(error, queue.scope));
  }

  private async drain(queue: PendingRun): Promise<void> {
    while (!this.closed) {
      const work = queue.head;
      if (work === undefined) {
        await this.flushDrops(queue);
        if (queue.head === undefined) return;
        continue;
      }
      if (!work.ordinary) await this.flushDrops(queue);
      if (this.closed) return;
      queue.executing = work;
      try {
        await work.operation();
        work.resolve?.();
      } catch (error) {
        if (work.reject !== undefined) work.reject(error);
        else this.report(error, queue.scope);
      } finally {
        if (work.ordinary) queue.ordinaryCount -= 1;
        else queue.controlCount -= 1;
        queue.head = work.next;
        if (queue.head === undefined) queue.tail = undefined;
        queue.executing = undefined;
      }
    }
  }

  private async flushDrops(queue: PendingRun): Promise<void> {
    if (queue.dropped === 0 || !queue.dropsReady || this.closed) return;
    const count = queue.dropped;
    queue.dropped = 0;
    queue.dropsReady = false;
    let result: { seq: number; inserted: boolean } | undefined;
    try {
      result = await this.database.recordRunTimelineDrops(
        queue.scope.organizationId,
        queue.scope.triggerRunId,
        count,
        this.options.now?.() ?? new Date(),
      );
    } catch (error) {
      if (!this.closed) queue.dropped += count;
      this.report(error, queue.scope);
      return;
    }
    if (result?.inserted) this.options.bus.publish(queue.scope.triggerRunId, result.seq);
  }

  private closePending(): void {
    this.closed = true;
    for (const queue of this.queues.values()) {
      const current = queue.executing;
      let work = current === undefined ? queue.head : current.next;
      if (current !== undefined) current.next = undefined;
      queue.head = current;
      queue.tail = current;
      while (work !== undefined) {
        if (work.ordinary) queue.ordinaryCount -= 1;
        else {
          queue.controlCount -= 1;
          work.reject?.(new Error("Timeline capture flush exceeded its deadline"));
        }
        const next = work.next;
        work.next = undefined;
        work = next;
      }
      queue.dropped = 0;
    }
  }

  private report(error: unknown, scope: TimelineRunScope): void {
    const now = this.options.now?.().getTime() ?? Date.now();
    if (now - this.lastFailureAt < 30000) return;
    this.lastFailureAt = now;
    try {
      this.options.reportFailure?.(error, "run.timeline.write", scope);
    } catch {}
  }
}
