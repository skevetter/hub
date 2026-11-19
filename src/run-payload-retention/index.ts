import { logger } from "../logger.js";
import { retentionCutoff } from "../run-timeline/retention.js";
import type { RunPayloadRetentionSettings } from "./settings.js";
import type {
  AuxiliaryPayloadDisposition,
  AuxiliaryPayloadCandidate,
  AuxiliaryPayloadKind,
  RunPayloadCandidate,
  RunPayloadDisposition,
  RunPayloadRetentionStore,
} from "./store.js";

const PAGE_SIZE = 100;
const HOUR_MS = 60 * 60_000;
const BATCH_DELAY_MS = 250;
const RETRY_DELAY_MS = 60_000;

type Counts = Partial<Record<RunPayloadDisposition, { count: number; oldestAgeMs: number }>>;
type AuxiliaryCounts = Partial<
  Record<AuxiliaryPayloadDisposition, { count: number; oldestAgeMs: number | null }>
>;
const APPLY_STAGES = ["run", "launchIntent", "session"] as const;
type Stage = (typeof APPLY_STAGES)[number] | "machine";
type SweepCandidate =
  | (RunPayloadCandidate & { kind: "run" })
  | (AuxiliaryPayloadCandidate & { kind: AuxiliaryPayloadKind });

function auxiliaryCounts(): Record<AuxiliaryPayloadKind, AuxiliaryCounts> {
  return { launchIntent: {}, session: {}, machine: {} };
}

export class RunPayloadRetention {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;
  private cursor: string | null = null;
  private cutoff: Date | undefined;
  private now: Date | undefined;
  private counts: Counts = {};
  private auxiliaryCounts = auxiliaryCounts();
  private expired = 0;
  private launchIntentsExpired = 0;
  private sessionsReduced = 0;
  private stageOffset = 0;
  private stages: Stage[] | undefined;

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
    this.stages ??= [
      ...APPLY_STAGES.slice(this.stageOffset),
      ...APPLY_STAGES.slice(0, this.stageOffset),
      ...(countOnly ? ["machine" as const] : []),
    ];
    const report = (complete: boolean) => ({
      complete,
      counts: this.counts,
      auxiliaryCounts: this.auxiliaryCounts,
      expired: this.expired,
      launchIntentsExpired: this.launchIntentsExpired,
      sessionsReduced: this.sessionsReduced,
    });
    for (let stage = this.stages[0]; stage !== undefined; stage = this.stages[0]) {
      if (shouldStop()) return report(false);
      const page = await this.scanStage(stage, cutoff, limit, countOnly);
      for (const candidate of page) {
        if (shouldStop()) return report(false);
        if (!countOnly && candidate.disposition === "eligible") {
          const completed = await this.applyCandidate(candidate, cutoff, now);
          if (!completed) return report(false);
        }
        this.countCandidate(candidate, this.now);
        this.cursor = candidate.id;
        if (
          stage !== "machine" &&
          this.expired + this.launchIntentsExpired + this.sessionsReduced >=
            this.settings.maxRunsPerPass
        ) {
          this.stageOffset = (APPLY_STAGES.indexOf(stage) + 1) % APPLY_STAGES.length;
          return this.finishSweep(report(true));
        }
      }
      if (page.length >= limit) return report(false);
      this.stages.shift();
      this.cursor = null;
    }
    return this.finishSweep(report(true));
  }

  private async scanStage(
    stage: Stage,
    cutoff: Date,
    limit: number,
    countOnly: boolean,
  ): Promise<SweepCandidate[]> {
    if (stage === "run") {
      const page = await this.store.scanRunPayloads(this.cursor, cutoff, limit, countOnly);
      return page.map(({ id, disposition, ageFrom }) => ({
        id,
        disposition,
        ageFrom,
        kind: stage,
      }));
    }
    const page = await this.store.scanAuxiliaryPayloads(stage, this.cursor, cutoff, limit);
    return page.map(({ id, disposition, ageFrom }) => ({ id, disposition, ageFrom, kind: stage }));
  }

  private async applyCandidate(
    candidate: SweepCandidate,
    cutoff: Date,
    now: Date,
  ): Promise<boolean> {
    const { id, kind } = candidate;
    if (kind === "run") {
      const result = await this.store.expireRunPayloadChunk(id, cutoff, now);
      if (result === "expired") this.expired++;
      return result !== "expiring";
    }
    if (kind === "launchIntent" && (await this.store.expireLaunchIntent(id, cutoff, now))) {
      this.launchIntentsExpired++;
    }
    if (kind === "session" && (await this.store.reduceSessionOptions(id, cutoff, now))) {
      this.sessionsReduced++;
    }
    return true;
  }

  private countCandidate(candidate: SweepCandidate, now: Date): void {
    if (candidate.kind === "run") {
      const count = this.counts[candidate.disposition] ?? { count: 0, oldestAgeMs: 0 };
      count.count++;
      count.oldestAgeMs = Math.max(count.oldestAgeMs, now.getTime() - candidate.ageFrom.getTime());
      this.counts[candidate.disposition] = count;
      return;
    }
    const counts = this.auxiliaryCounts[candidate.kind];
    const count = counts[candidate.disposition] ?? { count: 0, oldestAgeMs: null };
    count.count++;
    if (candidate.ageFrom !== null) {
      count.oldestAgeMs = Math.max(
        count.oldestAgeMs ?? 0,
        now.getTime() - candidate.ageFrom.getTime(),
      );
    }
    counts[candidate.disposition] = count;
  }

  private finishSweep<T>(result: T): T {
    this.stages = undefined;
    this.cursor = null;
    this.cutoff = undefined;
    this.now = undefined;
    this.counts = {};
    this.auxiliaryCounts = auxiliaryCounts();
    this.expired = 0;
    this.launchIntentsExpired = 0;
    this.sessionsReduced = 0;
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
