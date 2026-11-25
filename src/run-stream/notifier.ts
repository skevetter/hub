import type { RunTimelineBus } from "../run-timeline/bus.js";
import type { RunTimelineEvent, RunTimelineStore } from "../run-timeline/store.js";

export class RunStreamNotifier {
  private readonly waiters = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private rows: RunTimelineEvent[] = [];
  version = 0;
  references = 0;

  constructor(
    private readonly store: RunTimelineStore,
    bus: RunTimelineBus,
    private readonly organizationId: string,
    private readonly runId: string,
  ) {
    this.unsubscribe = bus.subscribe(runId, () => this.wake());
    this.schedule();
  }

  wake(): void {
    this.version += 1;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  wait(version: number, signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted || version !== this.version) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const finish = () => {
      this.waiters.delete(finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    this.waiters.add(finish);
    signal.addEventListener("abort", finish, { once: true });
    return promise;
  }

  async page(afterSeq: number): Promise<RunTimelineEvent[]> {
    const first = this.rows[0];
    const last = this.rows.at(-1);
    if (
      first !== undefined &&
      last !== undefined &&
      afterSeq >= first.seq - 1 &&
      afterSeq < last.seq
    ) {
      return this.rows.filter((row) => row.seq > afterSeq).slice(0, 100);
    }
    const page = await this.store.listRunTimelineEvents(this.organizationId, this.runId, {
      afterSeq,
      limit: 100,
    });
    if (!this.closed && page.length > 0) {
      const merged = new Map(this.rows.map((row) => [row.seq, row]));
      for (const row of page) merged.set(row.seq, row);
      const sorted = [...merged.values()].sort((a, b) => a.seq - b.seq);
      const start = contiguousSuffixStart(sorted);
      this.rows = sorted.slice(Math.max(start, sorted.length - 500));
    }
    return page;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.unsubscribe();
    this.rows = [];
    this.wake();
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.store
        .readRunTimelineState(this.organizationId, this.runId)
        .catch(() => undefined)
        .finally(() => {
          if (this.closed) return;
          this.wake();
          this.schedule();
        });
    }, 2000);
    this.timer.unref();
  }
}

function contiguousSuffixStart(sorted: readonly RunTimelineEvent[]): number {
  let start = sorted.length - 1;
  while (start > 0) {
    const current = sorted[start];
    const previous = sorted[start - 1];
    if (current === undefined || previous === undefined)
      throw new Error("run stream notifier invariant: expected adjacent sorted rows");
    if (current.seq !== previous.seq + 1) break;
    start -= 1;
  }
  return start;
}
