import type { AcceptedTriggerRunRecord } from "../db/types.js";
import type { RunTimelineBus } from "../run-timeline/bus.js";
import { CredentialBackoff } from "./backoff.js";
import { MessageSchedule } from "./schedule.js";
import type { RunProgressSettings } from "./settings.js";
import {
  progressClock,
  type ProgressClock,
  type ProgressProvider,
  type ProgressStore,
} from "./types.js";
import {
  MessageWriter,
  SWEEP_MS,
  type LateWriteObservers,
  type MessageScope,
  repairAt,
} from "./writer.js";

export type { ProgressProvider } from "./types.js";

const BATCH_SIZE = 500;

interface ProgressReporterOptions {
  database: ProgressStore;
  bus: RunTimelineBus;
  providers: readonly ProgressProvider[] | (() => readonly ProgressProvider[]);
  settings: Pick<RunProgressSettings, "minEditSeconds" | "maxEdits" | "retentionDays">;
  clock?: ProgressClock;
  lateWrites?: LateWriteObservers | undefined;
  random?: () => number;
  publicBaseUrl?: string | undefined;
  reportFailure?: (code: string, scope?: MessageScope) => void;
}

export class ProgressReporter {
  private readonly clock: ProgressClock;
  private readonly providers: () => ReadonlyMap<ProgressProvider["name"], ProgressProvider>;
  private readonly schedule: MessageSchedule;
  private readonly shutdown = new AbortController();
  private cancelSweep: (() => void) | undefined;
  private started = false;
  private sweeping = false;
  private restored = false;

  constructor(private readonly options: ProgressReporterOptions) {
    this.clock = options.clock ?? progressClock;
    const { providers } = options;
    if (typeof providers === "function") {
      this.providers = () => indexProviders(providers());
    } else {
      const registered = indexProviders(providers);
      this.providers = () => registered;
    }
    const report = (code: string, scope: MessageScope) => this.report(code, scope);
    const writer = new MessageWriter({
      ...options,
      clock: this.clock,
      backoff: new CredentialBackoff(options.random),
      report,
      signal: this.shutdown.signal,
    });
    this.schedule = new MessageSchedule({
      ...options,
      writer,
      providerFor: (name) => this.providers().get(name),
      clock: this.clock,
      settings: options.settings,
      report,
    });
  }

  start(): void {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true;
    this.schedule.start(this.options.bus);
    if (this.providers().size > 0) void this.restore();
    this.armSweep(0);
  }

  stop(): void {
    this.shutdown.abort();
    this.cancelSweep?.();
    this.schedule.stop();
  }

  request(run: AcceptedTriggerRunRecord): void {
    if (this.shutdown.signal.aborted) return;
    queueMicrotask(() => {
      if (!this.shutdown.signal.aborted) void this.optIn(run);
    });
  }

  private async optIn(run: AcceptedTriggerRunRecord): Promise<void> {
    const scope = { organizationId: run.organizationId, triggerRunId: run.id };
    try {
      const { database } = this.options;
      const receipt = await database.findProviderEventReceiptById(run.providerEventReceiptId);
      if (this.shutdown.signal.aborted || receipt?.organizationId !== run.organizationId) return;
      const name = receipt.provider === "github_notification" ? "github" : receipt.provider;
      if (name !== "github" && name !== "linear" && name !== "slack") return;
      if (!this.providers().has(name)) return;
      const row = await database.insertRunProgressMessageIfAbsent({
        ...scope,
        provider: name,
        now: new Date(this.clock.now()),
      });
      if (row !== undefined) this.schedule.track(row, this.clock.now());
    } catch {
      this.report("opt_in_failed", scope);
    }
  }

  private async restore(): Promise<void> {
    this.restored = true;
    try {
      let afterRunId: string | null = null;
      while (!this.shutdown.signal.aborted) {
        const batch = await this.options.database.listOpenRunProgressMessages(
          afterRunId,
          BATCH_SIZE,
        );
        for (const row of batch) {
          const wakeAt = row.state === "pending" ? this.clock.now() : row.retryAt?.getTime();
          this.schedule.track(row, wakeAt);
        }
        if (batch.length < BATCH_SIZE) break;
        afterRunId = batch.at(-1)!.triggerRunId;
      }
    } catch {
      this.report("startup_read_failed");
    }
  }

  private armSweep(delay: number): void {
    this.cancelSweep = this.clock.timer(() => {
      this.cancelSweep = undefined;
      this.armSweep(SWEEP_MS);
      void this.sweep();
    }, delay);
  }

  private async sweep(): Promise<void> {
    if (this.sweeping || this.shutdown.signal.aborted) return;
    this.sweeping = true;
    try {
      if (this.providers().size === 0) return;
      if (!this.restored) await this.restore();
      if (this.shutdown.signal.aborted) return;
      const now = this.clock.now();
      const rows = await this.options.database.listRunProgressMessagesToFinish(
        new Date(now),
        BATCH_SIZE,
        new Date(now + SWEEP_MS),
      );
      for (const row of rows)
        this.schedule.track(row, row.state === "finished" ? repairAt(row) : now);
    } catch {
      this.report("sweep_failed");
    } finally {
      this.sweeping = false;
    }
  }

  private report(code: string, scope?: MessageScope): void {
    if (this.shutdown.signal.aborted) return;
    try {
      this.options.reportFailure?.(code, scope);
    } catch {}
  }
}

function indexProviders(providers: readonly ProgressProvider[]) {
  const indexed = new Map(providers.map((provider) => [provider.name, provider]));
  if (indexed.size !== providers.length)
    throw new Error("Duplicate progress provider registration");
  return indexed;
}
