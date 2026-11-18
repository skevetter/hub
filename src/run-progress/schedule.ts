import type { RunTimelineBus } from "../run-timeline/bus.js";
import type { RunProgressMessage } from "../run-timeline/store.js";
import type { RunProgressSettings } from "./settings.js";
import type { ProgressClock, ProgressProvider, ProgressStore } from "./types.js";
import {
  type MessageScope,
  type MessageWriter,
  canEditRegularly,
  regularEditAt,
  repairAt,
} from "./writer.js";

interface Entry {
  scope: MessageScope;
  row: RunProgressMessage;
  wakeAt: number;
  running: boolean;
  dirty: boolean;
  reading: boolean;
  cancel?: (() => void) | undefined;
}

interface ScheduleOptions {
  database: ProgressStore;
  writer: MessageWriter;
  providerFor: (name: ProgressProvider["name"]) => ProgressProvider | undefined;
  clock: ProgressClock;
  settings: Pick<RunProgressSettings, "minEditSeconds" | "maxEdits">;
  report: (code: string, scope: MessageScope) => void;
}

export class MessageSchedule {
  private readonly entries = new Map<string, Entry>();
  private stopped = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: ScheduleOptions) {}

  start(bus: RunTimelineBus): void {
    this.unsubscribe = bus.observe(({ runId }) => {
      const entry = this.entries.get(runId);
      if (entry === undefined || (entry.row.state !== "pending" && entry.row.state !== "active"))
        return;
      entry.dirty = true;
      if (!entry.reading) void this.observe(entry);
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    for (const entry of this.entries.values()) this.remove(entry);
  }

  track(row: RunProgressMessage, wakeAt?: number): void {
    if (this.stopped) return;
    let entry = this.entries.get(row.triggerRunId);
    if (entry === undefined) {
      entry = {
        scope: { organizationId: row.organizationId, triggerRunId: row.triggerRunId },
        row,
        wakeAt: Infinity,
        running: false,
        reading: false,
        dirty: false,
      };
      this.entries.set(row.triggerRunId, entry);
    } else if (row.version >= entry.row.version && !entry.running) {
      entry.row = row;
    }
    const due = Math.min(wakeAt ?? Infinity, repairAt(row) ?? Infinity);
    if (Number.isFinite(due)) this.wake(entry, due);
  }

  private async observe(entry: Entry): Promise<void> {
    entry.reading = true;
    try {
      while (entry.dirty && this.isCurrent(entry)) {
        entry.dirty = false;
        const { database, clock, settings } = this.options;
        const run = await database.findTriggerRunForOrganization(
          entry.scope.organizationId,
          entry.scope.triggerRunId,
        );
        if (run?.outcome !== "accepted" || !this.isCurrent(entry)) return;
        const now = clock.now();
        if (
          entry.row.state === "active" &&
          run.status === "running" &&
          !canEditRegularly(entry.row, settings.maxEdits)
        )
          continue;
        const due =
          entry.row.state === "active" && run.status === "running"
            ? regularEditAt(entry.row, now, run.createdAt.getTime(), settings.minEditSeconds)
            : Math.max(now, entry.row.retryAt?.getTime() ?? 0);
        this.wake(entry, due);
      }
    } catch {
      this.options.report("observation_failed", entry.scope);
    } finally {
      entry.reading = false;
    }
  }

  private wake(entry: Entry, when: number): void {
    if (!this.isCurrent(entry) || when >= entry.wakeAt) return;
    entry.wakeAt = when;
    if (!entry.running) this.arm(entry);
  }

  private arm(entry: Entry): void {
    if (!Number.isFinite(entry.wakeAt)) return;
    entry.cancel?.();
    entry.cancel = this.options.clock.timer(
      () => {
        entry.cancel = undefined;
        entry.wakeAt = Infinity;
        void this.write(entry);
      },
      Math.max(0, entry.wakeAt - this.options.clock.now()),
    );
  }

  private async write(entry: Entry): Promise<void> {
    if (!this.isCurrent(entry)) return;
    entry.running = true;
    try {
      const provider = this.options.providerFor(entry.row.provider);
      if (provider === undefined) return;
      const { row, wakeAt, regularPace } = await this.options.writer.write(entry.scope, provider);
      if (!this.isCurrent(entry)) return;
      if (row === undefined) {
        this.remove(entry);
        return;
      }
      entry.row = row;
      const due = repairAt(row);
      if (row.state !== "active" && row.state !== "pending") {
        if (due === undefined && wakeAt === undefined) {
          this.remove(entry);
          return;
        }
      }
      if (wakeAt !== undefined) {
        entry.wakeAt = regularPace ? Math.min(entry.wakeAt, wakeAt) : wakeAt;
      } else if (due !== undefined) {
        this.wake(entry, due);
      }
    } catch {
      this.options.report("writer_failed", entry.scope);
      this.wake(entry, this.options.clock.now() + 5_000);
    } finally {
      entry.running = false;
      if (this.isCurrent(entry)) this.arm(entry);
    }
  }

  private isCurrent(entry: Entry): boolean {
    return !this.stopped && this.entries.get(entry.scope.triggerRunId) === entry;
  }

  private remove(entry: Entry): void {
    entry.cancel?.();
    this.entries.delete(entry.scope.triggerRunId);
  }
}
