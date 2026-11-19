import { logger } from "../logger.js";
import { retentionCutoff } from "../run-timeline/retention.js";
import type {
  CursorDiagnosticCandidate,
  CursorDiagnosticDisposition,
  CursorDiagnosticExpiryResult,
  ReceiptExpiryCandidate,
  ReceiptExpiryResult,
  SyncExpiryCandidate,
  SyncExpiryResult,
  SyncPayloadDisposition,
} from "./receipt-store.js";
import type { ReceiptDisposition } from "./receipt-proof.js";
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

type DispositionCounts<
  Disposition extends string,
  Age extends number | null = number | null,
> = Partial<Record<Disposition, { count: number; oldestAgeMs: Age }>>;
interface ApplyCounts {
  applied: number;
  locked: number;
  changedOrMissing: number;
}
type ReceiptApplyResult = ReceiptExpiryResult | SyncExpiryResult | CursorDiagnosticExpiryResult;

type SyncCountDisposition =
  | Exclude<SyncPayloadDisposition, "eligible">
  | "eligible_pair"
  | "eligible_copy_free";

const APPLY_STAGES = [
  "credentials",
  "run",
  "launchIntent",
  "session",
  "receipt",
  "installationSync",
  "cursorDiagnostic",
] as const;
type Stage = (typeof APPLY_STAGES)[number] | "machine";
type ReceiptStage = "receipt" | "installationSync" | "cursorDiagnostic";

type SweepCandidate =
  | { id: string; kind: "credentials" }
  | (RunPayloadCandidate & { kind: "run" })
  | (AuxiliaryPayloadCandidate & { kind: AuxiliaryPayloadKind })
  | (ReceiptExpiryCandidate & { kind: "receipt" })
  | (SyncExpiryCandidate & { kind: "installationSync" })
  | (Omit<CursorDiagnosticCandidate, "source"> & { id: string; kind: "cursorDiagnostic" });

interface SweepPage {
  candidates: SweepCandidate[];
  nextCursor: string | null;
}

function sweepPage(candidates: SweepCandidate[], limit: number): SweepPage {
  return {
    candidates,
    nextCursor: candidates.length === limit ? (candidates.at(-1)?.id ?? null) : null,
  };
}

function auxiliaryCounts(): Record<
  AuxiliaryPayloadKind,
  DispositionCounts<AuxiliaryPayloadDisposition>
> {
  return { launchIntent: {}, session: {}, machine: {} };
}

function receiptCounts(): {
  receipts: DispositionCounts<ReceiptDisposition>;
  installationSyncs: DispositionCounts<SyncCountDisposition>;
  lifecycleAuditCopies: DispositionCounts<Exclude<SyncCountDisposition, "eligible_copy_free">>;
  cursorDiagnostics: DispositionCounts<CursorDiagnosticDisposition>;
} {
  return { receipts: {}, installationSyncs: {}, lifecycleAuditCopies: {}, cursorDiagnostics: {} };
}

function applyCounts(): Record<ReceiptStage | "lifecycleAuditCopy", ApplyCounts> {
  return {
    receipt: { applied: 0, locked: 0, changedOrMissing: 0 },
    installationSync: { applied: 0, locked: 0, changedOrMissing: 0 },
    lifecycleAuditCopy: { applied: 0, locked: 0, changedOrMissing: 0 },
    cursorDiagnostic: { applied: 0, locked: 0, changedOrMissing: 0 },
  };
}

function countDisposition<Disposition extends string>(
  counts: DispositionCounts<Disposition>,
  disposition: Disposition,
  ageFrom: Date | null,
  now: Date,
): void {
  const count = counts[disposition] ?? { count: 0, oldestAgeMs: null };
  count.count++;
  if (ageFrom !== null) {
    count.oldestAgeMs = Math.max(count.oldestAgeMs ?? 0, now.getTime() - ageFrom.getTime());
  }
  counts[disposition] = count;
}

export class RunPayloadRetention {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;
  private cursor: string | null = null;
  private cutoff: Date | undefined;
  private now: Date | undefined;
  private counts: DispositionCounts<RunPayloadDisposition, number> = {};
  private receiptState: "expiring" | "intact" = "expiring";
  private auxiliaryCounts = auxiliaryCounts();
  private receiptCounts = receiptCounts();
  private receiptApply = applyCounts();
  private receiptWork = 0;
  private expired = 0;
  private credentialFactsBackfilled = 0;
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
      receiptCounts: this.receiptCounts,
      receiptApply: this.receiptApply,
      expired: this.expired,
      credentialFactsBackfilled: this.credentialFactsBackfilled,
      launchIntentsExpired: this.launchIntentsExpired,
      sessionsReduced: this.sessionsReduced,
    });
    if (this.settings.mode === "off") return this.finishSweep(report(true));
    for (let stage = this.stages[0]; stage !== undefined; stage = this.stages[0]) {
      if (shouldStop()) return report(false);
      const page = await this.scanStage(stage, cutoff, limit, countOnly);
      for (const candidate of page.candidates) {
        if (shouldStop()) return report(false);
        if (!(await this.processCandidate(candidate, cutoff, now, this.now))) return report(false);
        this.cursor = candidate.id;
        if (
          !countOnly &&
          stage !== "machine" &&
          this.credentialFactsBackfilled +
            this.expired +
            this.launchIntentsExpired +
            this.sessionsReduced +
            this.receiptWork >=
            this.settings.maxRunsPerPass
        ) {
          this.stageOffset = (APPLY_STAGES.indexOf(stage) + 1) % APPLY_STAGES.length;
          return this.finishSweep(report(true));
        }
      }
      const stageCapped =
        stage === "credentials" && this.credentialFactsBackfilled >= this.settings.maxRunsPerPass;
      if (page.nextCursor !== null && !stageCapped) {
        this.cursor = page.nextCursor;
        return report(false);
      }
      this.cursor = null;
      if (!this.beginIntactReceiptScan(stage)) this.stages.shift();
    }
    return this.finishSweep(report(true));
  }

  private beginIntactReceiptScan(stage: Stage): boolean {
    if (stage !== "receipt" || this.receiptState === "intact") return false;
    this.receiptState = "intact";
    return true;
  }

  private async scanStage(
    stage: Stage,
    cutoff: Date,
    limit: number,
    countOnly: boolean,
  ): Promise<SweepPage> {
    if (stage === "credentials") {
      const page = await this.store.scanUnknownTemporaryCredentials(this.cursor, limit);
      return sweepPage(
        page.map((id) => ({ id, kind: stage })),
        limit,
      );
    }
    if (stage === "run") {
      const page = await this.store.scanRunPayloads(this.cursor, cutoff, limit, countOnly);
      return sweepPage(
        page.map(({ id, disposition, ageFrom }) => ({
          id,
          disposition,
          ageFrom,
          kind: stage,
        })),
        limit,
      );
    }
    if (stage === "receipt") {
      const page = await this.store.scanReceiptPayloads(
        this.cursor,
        cutoff,
        limit,
        this.receiptState,
      );
      return {
        candidates: page.candidates.map(({ id, disposition, ageFrom }) => ({
          id,
          disposition,
          ageFrom,
          kind: stage,
        })),
        nextCursor: page.nextCursor,
      };
    }
    if (stage === "installationSync") {
      const page = await this.store.scanGitHubSyncPayloads(this.cursor, cutoff, limit);
      return sweepPage(
        page.map(({ id, disposition, ageFrom, receiptCopyAgeFrom }) => ({
          id,
          disposition,
          ageFrom,
          receiptCopyAgeFrom,
          kind: stage,
        })),
        limit,
      );
    }
    if (stage === "cursorDiagnostic") {
      const page = await this.store.scanGitHubCursorDiagnostics(this.cursor, cutoff, limit);
      return sweepPage(
        page.map(({ source, disposition, ageFrom }) => ({
          id: source,
          disposition,
          ageFrom,
          kind: stage,
        })),
        limit,
      );
    }
    const page = await this.store.scanAuxiliaryPayloads(stage, this.cursor, cutoff, limit);
    return sweepPage(
      page.map(({ id, disposition, ageFrom }) => ({ id, disposition, ageFrom, kind: stage })),
      limit,
    );
  }

  private async processCandidate(
    candidate: SweepCandidate,
    cutoff: Date,
    now: Date,
    countAt: Date,
  ): Promise<boolean> {
    if (candidate.kind === "credentials") {
      if (
        this.credentialFactsBackfilled < this.settings.maxRunsPerPass &&
        (await this.store.backfillTemporaryCredentialFact(candidate.id))
      ) {
        this.credentialFactsBackfilled++;
      }
      return true;
    }
    if (
      this.settings.mode === "on" &&
      (candidate.disposition === "eligible" || candidate.disposition === "expiring") &&
      !(await this.applyCandidate(candidate, cutoff, now))
    )
      return false;
    this.countCandidate(candidate, countAt);
    return true;
  }

  private async applyCandidate(
    candidate: Exclude<SweepCandidate, { kind: "credentials" }>,
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
    if (kind === "receipt") {
      const result = await this.store.expireReceiptPayload(id, cutoff, now);
      this.recordReceiptOperation(kind, result);
    }
    if (kind === "installationSync") {
      const result = await this.store.expireGitHubSyncPayload(id, cutoff, now);
      this.recordReceiptOperation(kind, result);
      const hasCopy =
        result.status === "expired" ? result.receiptCopy : candidate.receiptCopyAgeFrom !== null;
      if (hasCopy) this.recordReceiptResult("lifecycleAuditCopy", result);
    }
    if (kind === "cursorDiagnostic") {
      const result = await this.store.expireGitHubCursorDiagnostic(id, cutoff, now);
      this.recordReceiptOperation(kind, result);
    }
    return true;
  }

  private recordReceiptOperation(stage: ReceiptStage, result: ReceiptApplyResult): void {
    this.receiptWork++;
    this.recordReceiptResult(stage, result);
  }

  private recordReceiptResult(
    stage: ReceiptStage | "lifecycleAuditCopy",
    result: ReceiptApplyResult,
  ): void {
    const counts = this.receiptApply[stage];
    if (result.status === "expired") counts.applied++;
    else if (result.disposition === "locked") counts.locked++;
    else counts.changedOrMissing++;
  }

  private countCandidate(
    candidate: Exclude<SweepCandidate, { kind: "credentials" }>,
    now: Date,
  ): void {
    if (candidate.kind === "run") {
      const count = this.counts[candidate.disposition] ?? { count: 0, oldestAgeMs: 0 };
      count.count++;
      count.oldestAgeMs = Math.max(count.oldestAgeMs, now.getTime() - candidate.ageFrom.getTime());
      this.counts[candidate.disposition] = count;
      return;
    }
    const { kind, disposition, ageFrom } = candidate;
    if (kind === "receipt") {
      countDisposition(this.receiptCounts.receipts, disposition, ageFrom, now);
    } else if (kind === "installationSync") {
      if (candidate.receiptCopyAgeFrom !== null) {
        const pairDisposition = disposition === "eligible" ? "eligible_pair" : disposition;
        countDisposition(this.receiptCounts.installationSyncs, pairDisposition, ageFrom, now);
        countDisposition(
          this.receiptCounts.lifecycleAuditCopies,
          pairDisposition,
          candidate.receiptCopyAgeFrom,
          now,
        );
      } else {
        const syncDisposition = disposition === "eligible" ? "eligible_copy_free" : disposition;
        countDisposition(this.receiptCounts.installationSyncs, syncDisposition, ageFrom, now);
      }
    } else if (kind === "cursorDiagnostic") {
      countDisposition(this.receiptCounts.cursorDiagnostics, disposition, ageFrom, now);
    } else {
      countDisposition(this.auxiliaryCounts[kind], disposition, ageFrom, now);
    }
  }

  private finishSweep<T>(result: T): T {
    this.stages = undefined;
    this.cursor = null;
    this.cutoff = undefined;
    this.now = undefined;
    this.counts = {};
    this.auxiliaryCounts = auxiliaryCounts();
    this.receiptCounts = receiptCounts();
    this.receiptApply = applyCounts();
    this.receiptWork = 0;
    this.receiptState = "expiring";
    this.expired = 0;
    this.credentialFactsBackfilled = 0;
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
