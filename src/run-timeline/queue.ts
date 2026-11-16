import { randomUUID } from "node:crypto";
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

interface DropBatch {
  id: string;
  count: number;
  at: Date;
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
  batch?: DropBatch | undefined;
  dropsReady: boolean;
  inFlightDrops: number;
  recoveryAt?: number | undefined;
  recoveryAttempts: number;
  recoveryReady: boolean;
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
  private stopping = false;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recoveryTimerAt = Number.POSITIVE_INFINITY;
  private giveUps = 0;
  private abandonedDrops = 0;
  private lastFailureAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly database: Pick<Database, "recordRunTimelineDrops">,
    private readonly options: RunTimelineQueueOptions,
  ) {}

  enqueue(scope: TimelineRunScope, operation: () => Promise<void>): boolean {
    if (this.stopping || this.closed) return false;
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
    if (this.stopping || this.closed || count === 0) return;
    const queue = this.pending(scope);
    queue.dropped += count;
    queue.dropsReady = true;
    this.start(queue);
  }

  run(scope: TimelineRunScope, operation: () => Promise<void>): Promise<void> {
    if (this.stopping || this.closed)
      return Promise.reject(new Error("Timeline capture queue is closed"));
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

  accountingStats(): {
    queueEntries: number;
    retainedEntries: number;
    giveUps: number;
    abandonedDrops: number;
  } {
    let retainedEntries = 0;
    for (const queue of this.queues.values()) {
      if (this.hasDrops(queue)) retainedEntries += 1;
    }
    return {
      queueEntries: this.queues.size,
      retainedEntries,
      giveUps: this.giveUps,
      abandonedDrops: this.abandonedDrops,
    };
  }

  async stop(deadlineMs = 2000): Promise<boolean> {
    this.stopping = true;
    this.clearRecoveryTimer();
    if (deadlineMs <= 0) {
      const drained = this.active.size === 0 && this.accountingStats().retainedEntries === 0;
      this.closed = true;
      this.discardPending();
      return drained;
    }
    for (const queue of this.queues.values()) {
      if (this.hasDrops(queue)) {
        queue.dropsReady = true;
        this.start(queue);
      }
    }
    try {
      return await this.flush(deadlineMs);
    } finally {
      this.closed = true;
      this.discardPending();
    }
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
      if (result === "deadline") {
        this.closed = true;
        this.discardPending();
      }
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
        inFlightDrops: 0,
        recoveryAttempts: 0,
        recoveryReady: false,
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
        if (
          !this.closed &&
          (queue.head !== undefined || (this.hasDrops(queue) && queue.dropsReady))
        )
          this.start(queue);
        else this.reclaim(queue);
        this.scheduleRecovery();
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
      if (queue.head !== work) continue;
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

  private hasDrops(queue: PendingRun): boolean {
    return queue.dropped !== 0 || queue.batch !== undefined;
  }

  private async flushDrops(queue: PendingRun): Promise<void> {
    const batches = queue.batch === undefined ? 1 : 2;
    for (let remaining = batches; remaining > 0; remaining--) {
      if (!this.hasDrops(queue) || !queue.dropsReady || this.closed) return;
      if (queue.batch === undefined) {
        queue.batch = {
          id: randomUUID(),
          count: queue.dropped,
          at: this.options.now?.() ?? new Date(),
        };
        queue.dropped = 0;
      }
      const batch = queue.batch;
      const scheduled = queue.recoveryReady;
      queue.recoveryReady = false;
      if (scheduled) queue.recoveryAttempts += 1;
      queue.inFlightDrops = batch.count;
      queue.dropsReady = false;
      let result: { seq: number; inserted: boolean; noticeSeq?: number } | undefined;
      try {
        result = await this.database.recordRunTimelineDrops(
          queue.scope.organizationId,
          queue.scope.triggerRunId,
          batch.count,
          batch.at,
          batch.id,
        );
      } catch (error) {
        if (this.stopping || this.closed || queue.recoveryAttempts >= 5) {
          this.abandon(queue, batch.count);
          queue.batch = undefined;
          queue.recoveryAt = undefined;
          queue.recoveryAttempts = 0;
        } else {
          queue.recoveryAt ??= performance.now() + 30000;
          if (scheduled) queue.recoveryAt = performance.now() + 30000;
        }
        this.report(error, queue.scope);
        return;
      } finally {
        queue.inFlightDrops = 0;
      }
      queue.batch = undefined;
      queue.recoveryAt = undefined;
      queue.recoveryAttempts = 0;
      queue.dropsReady = queue.dropped !== 0;
      if (result !== undefined && (result.inserted || result.noticeSeq !== undefined))
        this.options.bus.publish(queue.scope.triggerRunId, result.noticeSeq ?? result.seq);
    }
  }

  private clearRecoveryTimer(): void {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryTimerAt = Number.POSITIVE_INFINITY;
  }

  private scheduleRecovery(): void {
    if (this.stopping || this.closed) return;
    let due = Number.POSITIVE_INFINITY;
    for (const queue of this.queues.values()) {
      if (!queue.running && this.hasDrops(queue) && queue.recoveryAt !== undefined)
        due = Math.min(due, queue.recoveryAt);
    }
    if (due === Number.POSITIVE_INFINITY) {
      this.clearRecoveryTimer();
      return;
    }
    if (this.recoveryTimer !== undefined && this.recoveryTimerAt <= due) return;
    this.clearRecoveryTimer();
    this.recoveryTimerAt = due;
    this.recoveryTimer = setTimeout(
      () => {
        this.recoveryTimer = undefined;
        this.recoveryTimerAt = Number.POSITIVE_INFINITY;
        let remaining = 100;
        const now = performance.now();
        for (const queue of this.queues.values()) {
          if (
            queue.running ||
            !this.hasDrops(queue) ||
            queue.recoveryAt === undefined ||
            queue.recoveryAt > now
          )
            continue;
          queue.recoveryReady = true;
          queue.dropsReady = true;
          this.start(queue);
          if (--remaining === 0) break;
        }
        this.scheduleRecovery();
      },
      Math.max(0, due - performance.now()),
    );
    this.recoveryTimer.unref();
  }

  private reclaim(queue: PendingRun): void {
    if (
      queue.head === undefined &&
      queue.dropped === 0 &&
      queue.batch === undefined &&
      queue.inFlightDrops === 0 &&
      this.queues.get(queue.scope.triggerRunId) === queue
    )
      this.queues.delete(queue.scope.triggerRunId);
  }

  private abandon(queue: PendingRun, count: number): void {
    if (count === 0) return;
    this.giveUps += 1;
    this.abandonedDrops += count;
    this.report(new Error("Timeline drop accounting batch abandoned"), queue.scope);
  }

  private discardPending(): void {
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
      const retained = queue.inFlightDrops === 0 ? (queue.batch?.count ?? 0) : 0;
      this.abandon(queue, queue.dropped + retained);
      if (queue.inFlightDrops === 0) queue.batch = undefined;
      queue.dropped = 0;
      queue.dropsReady = false;
      queue.recoveryAt = undefined;
      queue.recoveryReady = false;
      this.reclaim(queue);
    }
    if (this.stopping || this.closed) this.clearRecoveryTimer();
    else this.scheduleRecovery();
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
