import { logger } from "../logger.js";
import { retentionCutoff } from "../run-timeline/retention.js";
import type { RunPayloadRetentionSettings } from "./settings.js";
import type { RunPayloadDisposition, RunPayloadRetentionStore } from "./store.js";

const PAGE_SIZE = 100;
const HOUR_MS = 60 * 60_000;
const BATCH_DELAY_MS = 250;
const RETRY_DELAY_MS = 60_000;

type Counts = Partial<Record<RunPayloadDisposition, { count: number; oldestAgeMs: number }>>;

export class RunPayloadRetention {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;
  private cursor: string | null = null;
  private cutoff: Date | undefined;
  private now: Date | undefined;
  private counts: Counts = {};
  private expired = 0;

  constructor(
    private readonly store: RunPayloadRetentionStore,
    private readonly settings: RunPayloadRetentionSettings,
  ) {}

  start(): void {
    if (!this.stopped || this.active || this.settings.mode === "off") return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  async runBatch(now = new Date(), shouldStop = () => false) {
    this.now ??= now;
    const cutoff = (this.cutoff ??= retentionCutoff(this.now, this.settings.retentionDays));
    const countOnly = this.settings.mode !== "on";
    const limit = Math.min(PAGE_SIZE, this.settings.maxRunsPerPass);
    const page = await this.store.scanRunPayloads(this.cursor, cutoff, limit, countOnly);
    for (const candidate of page) {
      if (shouldStop()) return { complete: false, counts: this.counts, expired: this.expired };
      if (!countOnly && candidate.disposition === "eligible") {
        const result = await this.store.expireRunPayloadChunk(candidate.id, cutoff, now);
        if (result === "expiring") {
          return { complete: false, counts: this.counts, expired: this.expired };
        }
        if (result === "expired") this.expired++;
      }
      const { disposition, ageFrom } = candidate;
      const count = this.counts[disposition] ?? { count: 0, oldestAgeMs: 0 };
      count.count++;
      count.oldestAgeMs = Math.max(count.oldestAgeMs, this.now.getTime() - ageFrom.getTime());
      this.counts[disposition] = count;
      this.cursor = candidate.id;
      if (this.expired >= this.settings.maxRunsPerPass) break;
    }
    const complete = page.length < limit || this.expired >= this.settings.maxRunsPerPass;
    const result = { complete, counts: this.counts, expired: this.expired };
    if (complete) {
      this.cursor = null;
      this.cutoff = undefined;
      this.now = undefined;
      this.counts = {};
      this.expired = 0;
    }
    return result;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.tick();
    }, ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let next = RETRY_DELAY_MS;
    try {
      const result = await this.runBatch(new Date(), () => this.stopped);
      if (result.complete) {
        logger.info(
          { operation: "run_payload_retention.sweep", mode: this.settings.mode, ...result },
          "run payload retention",
        );
      }
      next = result.complete ? HOUR_MS : BATCH_DELAY_MS;
    } catch {
      logger.warn({ operation: "run_payload_retention.sweep" }, "run payload retention will retry");
    } finally {
      this.active = undefined;
      this.schedule(next);
    }
  }
}
