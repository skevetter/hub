import { createHash, randomUUID } from "node:crypto";
import type { AcceptedTriggerRunRecord } from "../db/types.js";
import type {
  RunProgressMessage,
  RunTimelineEvent,
  UpdateRunProgressMessageInput,
} from "../run-timeline/store.js";
import { isRunTimelineExpired, retentionCutoff } from "../run-timeline/retention.js";
import { CREDENTIAL_CIRCUIT_MS, CredentialBackoff } from "./backoff.js";
import { GitHubProgressProvider } from "./github.js";
import { renderProgress } from "./render.js";
import type { RunProgressSettings } from "./settings.js";
import {
  parseStoredRef,
  type ProgressCall,
  type ProgressClock,
  type ProgressProvider,
  type ProgressStore,
  type StoredRef,
} from "./types.js";

export const SWEEP_MS = 30_000;
const OPERATION_MS = 25_000;
const PROVIDER_MS = 10_000;
const SETTLE_MS = 120_000;
const LEASE_RETRY_MS = 5_000;
const FINAL_RETRY_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
const FINAL_WINDOW_MS = 6 * 60 * 60_000;
const REGULAR_FAILURE_LIMIT = 8;
const REGULAR_TIMEOUT_WAIT_MS = 2_000;
const LATE_WRITE_LIFETIME_MS = 600_000;
const MAX_LATE_WRITE_OBSERVERS = 256;

interface LateWriteObserver {
  signal: AbortSignal;
  repair: () => Promise<unknown>;
  report: () => void;
  cancel: () => void;
  clock: ProgressClock;
  expiresAt: number;
}

export class LateWriteObservers {
  private readonly pending = new Map<symbol, LateWriteObserver>();

  get size(): number {
    return this.pending.size;
  }

  observe(
    write: Promise<ProgressCall>,
    clock: ProgressClock,
    observation: Omit<LateWriteObserver, "cancel" | "clock" | "expiresAt">,
  ): void {
    const ticket = Symbol();
    const oldest = this.pending.keys().next().value;
    if (this.size === MAX_LATE_WRITE_OBSERVERS && oldest !== undefined) this.drop(oldest);
    const expiresAt = clock.monotonic() + LATE_WRITE_LIFETIME_MS;
    const cancel = clock.timer(() => this.drop(ticket), LATE_WRITE_LIFETIME_MS);
    this.pending.set(ticket, { ...observation, cancel, clock, expiresAt });
    // The promise retains only the ticket when the observation expires or is evicted.
    void write.then(
      ({ status }) => this.complete(ticket, status === "ok"),
      () => this.drop(ticket),
    );
  }

  private drop(ticket: symbol): LateWriteObserver | undefined {
    const observer = this.pending.get(ticket);
    this.pending.delete(ticket);
    observer?.cancel();
    return observer;
  }

  private async complete(ticket: symbol, succeeded: boolean): Promise<void> {
    const observer = this.drop(ticket);
    if (!succeeded || !observer?.signal.aborted || observer.clock.monotonic() >= observer.expiresAt)
      return;
    try {
      await observer.repair();
    } catch {
      observer.report();
    }
  }
}

const lateWrites = new LateWriteObservers();

export type MessageScope = Pick<RunProgressMessage, "triggerRunId" | "organizationId">;
type Patch = UpdateRunProgressMessageInput["patch"];
type WriteKind = "create" | "regular" | "final" | "repair";
type Report = (code: string, scope: MessageScope) => void;

export interface WriteResult {
  row?: RunProgressMessage | undefined;
  wakeAt?: number;
  regularPace?: true;
}

interface WriterOptions {
  database: ProgressStore;
  clock: ProgressClock;
  settings: Pick<RunProgressSettings, "minEditSeconds" | "maxEdits" | "retentionDays">;
  backoff: CredentialBackoff;
  lateWrites?: LateWriteObservers | undefined;
  publicBaseUrl?: string | undefined;
  report: Report;
  signal: AbortSignal;
}

class OperationDeadline extends Error {}

class Budget {
  constructor(
    private readonly clock: ProgressClock,
    private readonly stop: AbortSignal,
    private readonly deadline: number,
  ) {}

  check(): void {
    this.stop.throwIfAborted();
    if (this.clock.monotonic() >= this.deadline) throw new OperationDeadline();
  }

  async run<T>(task: (signal: AbortSignal) => Promise<T>, limit = OPERATION_MS): Promise<T> {
    this.check();
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.stop, timeout.signal]);
    const cancel = this.clock.timer(
      () => timeout.abort(new OperationDeadline()),
      Math.min(limit, this.deadline - this.clock.monotonic()),
    );
    const { promise, reject } = Promise.withResolvers<never>();
    const abort = () => {
      cancel();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([task(signal), promise]);
    } finally {
      cancel();
      signal.removeEventListener("abort", abort);
    }
  }
}

interface Operation {
  lease: RunProgressMessage;
  run: AcceptedTriggerRunRecord;
  kind: WriteKind;
  ref: StoredRef;
  body: string;
  hash: string;
  budget: Budget;
}

function credentialKey({ lease, ref }: Pick<Operation, "lease" | "ref">): string {
  return createHash("sha256")
    .update(JSON.stringify([lease.provider, ref.credential]))
    .digest("hex");
}

type MutationOutcome = ProgressCall | "transient" | "timeout";

function uncertain(outcome: MutationOutcome): boolean {
  return typeof outcome === "string" || (outcome.status === "retry" && outcome.transient === true);
}
const FAILURE_CODES = new Set([
  "body_contains_secret",
  "connection_not_owned",
  "connection_unavailable",
  "credential_rejected",
  "edit_window_closed",
  "installation_not_owned",
  "invalid_credential",
  "invalid_destination",
  "invalid_reference",
  "locked",
  "locked_thread",
  "missing_scope",
  "no_credential",
  "no_destination",
  "not_editable",
  "org_not_mapped",
  "public_repo",
  "public_repository",
  "reauthorize",
  "rejected",
  "repo_not_allowed",
  "scope_missing",
  "sso_required",
  "target_mismatch",
  "target_not_found",
  "target_unavailable",
  "visibility_changed",
  "visibility_unknown",
  "workspace_not_owned",
]);

function failureCode(code: string, fallback: string): string {
  return FAILURE_CODES.has(code) ? code : fallback;
}

export function canEditRegularly(row: RunProgressMessage, maxEdits: number): boolean {
  return row.editCount < maxEdits && row.failedEdits < REGULAR_FAILURE_LIMIT;
}

export function regularEditAt(
  row: RunProgressMessage,
  now: number,
  ageFrom: number,
  seconds: number,
  localSendStart?: number,
): number {
  const interval = now - ageFrom > 900_000 ? 60_000 : seconds * 1000;
  const durableStart = (row.lastRegularAttemptAt ?? row.lastEditAt)?.getTime() ?? now - interval;
  return Math.max(
    row.retryAt?.getTime() ?? 0,
    Math.max(durableStart, localSendStart ?? -Infinity) + interval,
  );
}

export function repairAt(row: RunProgressMessage): number | undefined {
  if (row.state !== "active" && row.state !== "finished") return undefined;
  const generationAt =
    row.compensationRequestedGen > row.compensationDoneGen
      ? (row.compensationNotBefore?.getTime() ?? 0)
      : Infinity;
  const at = Math.min(generationAt, row.settleAt?.getTime() ?? Infinity);
  if (at === Infinity) return undefined;
  return Math.max(at, row.retryAt?.getTime() ?? 0);
}

export class MessageWriter {
  private readonly owner = randomUUID();
  private readonly recentRegularStarts = new Map<string, number>();

  constructor(private readonly options: WriterOptions) {
    options.signal.addEventListener("abort", () => this.recentRegularStarts.clear(), {
      once: true,
    });
  }

  async write(scope: MessageScope, provider: ProgressProvider): Promise<WriteResult> {
    const { database, clock, signal } = this.options;
    this.pruneRegularStarts(clock.now());
    const previous = await database.findRunProgressMessage(
      scope.organizationId,
      scope.triggerRunId,
    );
    if (previous === undefined || signal.aborted) return {};
    if (!["pending", "creating", "active", "finished"].includes(previous.state))
      return { row: previous };
    const now = clock.now();
    if (previous.leaseOwner !== null && (previous.leaseExpiresAt?.getTime() ?? 0) > now)
      return { row: previous, wakeAt: now + LEASE_RETRY_MS };
    const budget = new Budget(clock, signal, clock.monotonic() + OPERATION_MS);
    const lease = await budget.run(() =>
      database.acquireRunProgressLease({
        ...scope,
        owner: this.owner,
        now: new Date(now),
      }),
    );
    if (lease === undefined) return { row: previous, wakeAt: now + LEASE_RETRY_MS };
    const operation = this.perform(previous, lease, provider, budget);
    try {
      return await budget.run(() => operation);
    } catch {
      if (signal.aborted) return {};
      return { row: lease, wakeAt: clock.now() + LEASE_RETRY_MS };
    }
  }

  private async perform(
    previous: RunProgressMessage,
    lease: RunProgressMessage,
    provider: ProgressProvider,
    budget: Budget,
  ): Promise<WriteResult> {
    try {
      return await this.withLease(previous, lease, provider, budget);
    } catch (error) {
      if (this.options.signal.aborted) return {};
      this.options.report(
        error instanceof OperationDeadline ? "operation_timeout" : "operation_failed",
        lease,
      );
      return this.release(lease, {}, this.options.clock.now() + LEASE_RETRY_MS);
    }
  }

  private async withLease(
    previous: RunProgressMessage,
    lease: RunProgressMessage,
    provider: ProgressProvider,
    budget: Budget,
  ): Promise<WriteResult> {
    const { database, clock } = this.options;
    if (lease.state === "creating") return this.recoverCreate(lease, provider, budget);
    const expired = previous.leaseOwner !== null && lease.version === previous.version + 1;
    if (expired && lease.state === "active") {
      const generation = await budget.run(() =>
        database.requestCompensation(lease.organizationId, lease.triggerRunId),
      );
      if (generation !== undefined) {
        lease.compensationRequestedGen = generation;
        lease.compensationNotBefore = null;
      }
    }
    const run = await budget.run(() =>
      database.findTriggerRunForOrganization(lease.organizationId, lease.triggerRunId),
    );
    if (run?.outcome !== "accepted") return this.release(lease);
    if (
      isRunTimelineExpired(
        run,
        retentionCutoff(new Date(clock.now()), this.options.settings.retentionDays),
      )
    ) {
      await this.release(lease);
      return {};
    }
    const kind = this.kind(lease, run, clock.now());
    if (kind === undefined) return this.release(lease);
    if (
      kind === "final" &&
      run.completedAt !== null &&
      clock.now() - run.completedAt.getTime() >= FINAL_WINDOW_MS
    )
      return this.stopMessage(lease, "abandoned", "final_retry_expired");
    const nextAt = lease.retryAt?.getTime() ?? 0;
    if (nextAt > clock.now()) return this.release(lease, {}, nextAt);
    if (kind === "regular") {
      const due = this.regularDue(lease, run);
      if (due > clock.now()) return { ...(await this.release(lease, {}, due)), regularPace: true };
    }
    return this.prepare(lease, run, kind, provider, budget);
  }

  private async recoverCreate(
    lease: RunProgressMessage,
    provider: ProgressProvider,
    budget: Budget,
  ): Promise<WriteResult> {
    if (!(provider instanceof GitHubProgressProvider))
      return this.stopMessage(lease, "abandoned", "create_unknown");
    const { database, clock, backoff, settings } = this.options;
    const run = await budget.run(() =>
      database.findTriggerRunForOrganization(lease.organizationId, lease.triggerRunId),
    );
    if (run?.outcome !== "accepted") return this.stopMessage(lease, "abandoned", "create_unknown");
    if (isRunTimelineExpired(run, retentionCutoff(new Date(clock.now()), settings.retentionDays)))
      return this.release(lease);
    const target = provider.destination(run);
    if (target === undefined) return this.stopMessage(lease, "abandoned", "create_unknown");
    const shared = await budget.run(() =>
      database.readProgressCredentialCooldown(credentialKey({ lease, ref: target })),
    );
    const admission = backoff.admit(target.credential, clock.now(), shared);
    if ("waitUntil" in admission) return this.release(lease, {}, admission.waitUntil);
    if ("rejected" in admission) return this.stopMessage(lease, "abandoned", "create_unknown");
    try {
      const found = await budget
        .run((signal) => provider.adopt(run, signal), PROVIDER_MS)
        .catch(() => undefined);
      if (found === undefined) return this.stopMessage(lease, "abandoned", "create_unknown");
      return this.release(
        lease,
        {
          state: "active",
          externalRef: found,
          lastEditAt: new Date(clock.now()),
          retryAt: null,
          failure: null,
        },
        clock.now(),
      );
    } finally {
      admission.release();
    }
  }

  private kind(
    row: RunProgressMessage,
    run: AcceptedTriggerRunRecord,
    now: number,
  ): WriteKind | undefined {
    if (row.state === "pending") return "create";
    if (row.state === "active" && run.status !== "running") return "final";
    if ((repairAt(row) ?? Infinity) <= now) return "repair";
    if (row.state === "active" && canEditRegularly(row, this.options.settings.maxEdits))
      return "regular";
    return undefined;
  }

  private async prepare(
    lease: RunProgressMessage,
    run: AcceptedTriggerRunRecord,
    kind: WriteKind,
    provider: ProgressProvider,
    budget: Budget,
  ): Promise<WriteResult> {
    const { database } = this.options;
    const [steps, events, slug] = await budget.run(() =>
      Promise.all([
        database.listWorkflowStepRunsForTriggerRun(run.id),
        this.timeline(run),
        database.findOrganizationSlugById(run.organizationId),
      ]),
    );
    if (
      kind === "create" &&
      run.status === "running" &&
      !steps.some((step) => step.startedAt !== null) &&
      !events.some((event) => event.kind === "run_started")
    )
      return this.release(lease);
    const ref = parseStoredRef(kind === "create" ? provider.destination(run) : lease.externalRef);
    if (ref === undefined) {
      return this.stopMessage(
        lease,
        "unavailable",
        kind === "create" ? "no_destination" : "invalid_reference",
      );
    }
    const body = renderProgress({
      run,
      steps,
      events,
      provider: provider.name,
      maxBodyChars: provider.maxBodyChars,
      publicBaseUrl: this.options.publicBaseUrl,
      organizationSlug: slug,
    });
    if (body === "") return this.stopMessage(lease, "unavailable", "invalid_body_limit");
    const hash = createHash("sha256").update(body).digest("hex");
    if (kind === "regular" && hash === lease.lastRenderedHash)
      return this.release(lease, { retryAt: null });
    return this.authorizeAndSend({ lease, run, kind, ref, body, hash, budget }, provider);
  }

  private async timeline(run: AcceptedTriggerRunRecord): Promise<RunTimelineEvent[]> {
    const events: RunTimelineEvent[] = [];
    const limit = 500;
    let afterSeq = 0;
    while (!this.options.signal.aborted) {
      const page = await this.options.database.listRunTimelineEvents(run.organizationId, run.id, {
        afterSeq,
        limit,
      });
      events.push(...page);
      if (page.length < limit) break;
      afterSeq = page.at(-1)!.seq;
    }
    return events;
  }

  private async authorizeAndSend(
    operation: Operation,
    provider: ProgressProvider,
  ): Promise<WriteResult> {
    const { lease, run, ref, body, budget } = operation;
    const { backoff, clock, database } = this.options;
    const locator = ref.credential;
    const shared = await budget.run(() =>
      database.readProgressCredentialCooldown(credentialKey(operation)),
    );
    const admission = backoff.admit(locator, clock.now(), shared);
    if ("waitUntil" in admission) return this.release(lease, {}, admission.waitUntil);
    if ("rejected" in admission) return this.credentialRejected(lease);
    try {
      let authorization: Awaited<ReturnType<ProgressProvider["authorize"]>>;
      let secrets: readonly string[] = [];
      try {
        let visibility: Pick<Patch, "visibility" | "visibilityCheckedAt"> | undefined;
        authorization = await budget.run(
          (signal) =>
            provider instanceof GitHubProgressProvider
              ? provider.authorize(locator, run, signal, {
                  visibility: lease.visibility,
                  visibilityCheckedAt: lease.visibilityCheckedAt,
                  now: clock.now(),
                  expectedRepositoryId:
                    typeof ref["repositoryId"] === "number" ? ref["repositoryId"] : undefined,
                  force: run.status !== "running",
                  record: (result) => {
                    visibility = result;
                  },
                })
              : provider.authorize(locator, run, signal),
          PROVIDER_MS,
        );
        const visibilityPatch = visibility;
        if (visibilityPatch !== undefined) {
          const updated = await budget.run(() => this.update(lease, visibilityPatch, false));
          if (updated === undefined) return {};
        }
        if (authorization === "ok")
          secrets = await budget.run((signal) => provider.secrets(locator, signal), PROVIDER_MS);
      } catch {
        if (this.options.signal.aborted) return {};
        const retryAt = await this.recordBackoff(operation, "transient");
        return this.transientFailure(operation, retryAt, false, false);
      }
      if (authorization !== "ok") {
        if ("refused" in authorization)
          return this.stopMessage(
            lease,
            "refused",
            failureCode(authorization.refused, "policy_refused"),
          );
        if (authorization.unavailable === "credential_rejected") {
          await this.recordBackoff(operation, {
            status: "unavailable",
            code: "credential_rejected",
          });
          return this.credentialRejected(lease);
        }
        return this.stopMessage(
          lease,
          "unavailable",
          failureCode(authorization.unavailable, "authorization_unavailable"),
        );
      }
      if (secrets.some((secret) => secret !== "" && body.includes(secret)))
        return this.stopMessage(lease, "refused", "body_contains_secret");
      return await this.send(operation, provider, secrets);
    } finally {
      admission.release();
    }
  }

  private async send(
    operation: Operation,
    provider: ProgressProvider,
    secrets: readonly string[],
  ): Promise<WriteResult> {
    const { lease, kind, budget } = operation;
    const { clock, database } = this.options;
    const admission = await budget.run(() =>
      database.admitProgressWrite({
        triggerRunId: lease.triggerRunId,
        organizationId: lease.organizationId,
        owner: this.owner,
        version: lease.version,
        now: new Date(clock.now()),
        state: lease.state,
        key: credentialKey(operation),
        reservation: kind === "create" || kind === "regular" ? kind : undefined,
      }),
    );
    if (admission.status === "lease_lost") return {};
    if (admission.status === "retry") return this.release(lease, {}, admission.at.getTime());
    if (admission.status === "rejected") return this.credentialRejected(lease);

    const expected = kind === "create" ? "creating" : lease.state;
    const current = await budget.run(() =>
      database.findRunProgressMessage(lease.organizationId, lease.triggerRunId),
    );
    budget.check();
    if (
      current?.leaseOwner !== this.owner ||
      current.version !== lease.version ||
      current.state !== expected ||
      (current.leaseExpiresAt?.getTime() ?? 0) <= clock.now()
    )
      return {};
    const observedGen = current.compensationRequestedGen;
    let outcome: MutationOutcome;
    try {
      outcome = await budget.run(
        (signal) => this.invokeMutation(operation, provider, signal),
        PROVIDER_MS,
      );
    } catch (error) {
      outcome = error instanceof OperationDeadline ? "timeout" : "transient";
    }
    try {
      return await this.record(operation, current, observedGen, outcome, secrets);
    } catch {
      // Preserve the lease for recovery when the outcome and repair signal are both uncertain.
      this.options.report("outcome_record_failed", lease);
      return { row: lease, wakeAt: clock.now() + LEASE_RETRY_MS };
    }
  }

  private invokeMutation(
    { kind, ref, body, lease }: Operation,
    provider: ProgressProvider,
    signal: AbortSignal,
  ): Promise<ProgressCall> {
    const sentAt = this.options.clock.now();
    this.options.backoff.sent(ref.credential, sentAt);
    if (kind === "regular") {
      this.recentRegularStarts.delete(lease.triggerRunId);
      this.recentRegularStarts.set(lease.triggerRunId, sentAt);
    }
    const pending =
      kind === "create" ? provider.create(ref, body, signal) : provider.edit(ref, body, signal);
    (this.options.lateWrites ?? lateWrites).observe(pending, this.options.clock, {
      signal,
      repair: () => this.requestCompensation(lease),
      report: () => this.options.report("late_repair_request_failed", lease),
    });
    return pending;
  }

  private requestCompensation({ organizationId, triggerRunId }: MessageScope, notBefore?: Date) {
    return this.options.database.requestCompensation(organizationId, triggerRunId, notBefore);
  }

  private async requestUncertainRepair(
    operation: Operation,
    current: RunProgressMessage,
    outcome: MutationOutcome,
  ) {
    if (!uncertain(outcome)) return;
    const { kind, run } = operation;
    // A running message observes regular pacing. Finalization can still proceed after its own wait.
    const notBefore = kind === "regular" ? new Date(this.regularDue(current, run)) : undefined;
    await this.requestCompensation(current, notBefore);
  }

  private regularDue(row: RunProgressMessage, run: AcceptedTriggerRunRecord): number {
    return regularEditAt(
      row,
      this.options.clock.now(),
      run.createdAt.getTime(),
      this.options.settings.minEditSeconds,
      this.recentRegularStarts.get(row.triggerRunId),
    );
  }

  private pruneRegularStarts(now: number): void {
    const cutoff = now - Math.max(60_000, this.options.settings.minEditSeconds * 1000);
    for (const [runId, startedAt] of this.recentRegularStarts) {
      if (startedAt > cutoff) break;
      this.recentRegularStarts.delete(runId);
    }
  }

  private credentialRejected(lease: RunProgressMessage): Promise<WriteResult> {
    return this.release(lease, {
      state: "unavailable",
      failure: "credential_rejected",
      settleAt: null,
    });
  }

  private async record(
    operation: Operation,
    current: RunProgressMessage,
    observedGen: number,
    outcome: MutationOutcome,
    secrets: readonly string[],
  ): Promise<WriteResult> {
    const { lease, kind } = operation;
    const { database, clock } = this.options;
    const now = clock.now();
    await this.requestUncertainRepair(operation, current, outcome);
    if (this.options.signal.aborted) return {};
    if (outcome === "timeout" && kind === "regular") {
      return this.transientFailure(operation, now + REGULAR_TIMEOUT_WAIT_MS, true, true);
    }
    const retryAt = await this.recordBackoff(
      operation,
      typeof outcome === "string" ? "transient" : outcome,
    );
    if (typeof outcome === "string" || outcome.status === "retry") {
      const safeCreate = typeof outcome !== "string" && outcome.notCreated && !outcome.transient;
      if (kind === "create" && !safeCreate)
        return this.afterSend(lease, { state: "abandoned", failure: "create_unknown" });
      return this.transientFailure(operation, retryAt, false, true);
    }
    if (outcome.status !== "ok") return this.recordRefusal(operation, outcome);
    if (kind === "create") return this.recordCreated(operation, now, outcome.ref, secrets);
    if (kind === "final") return this.finish(operation, now);
    const result = await this.afterSend(lease, {
      ...this.successPatch(operation, now),
      ...(kind === "repair" && current.settleAt !== null && current.settleAt.getTime() <= now
        ? { settleAt: null }
        : {}),
    });
    if (result.row !== undefined && kind === "repair") {
      await database.completeCompensation(lease.organizationId, lease.triggerRunId, observedGen);
      return {
        row: await database.findRunProgressMessage(lease.organizationId, lease.triggerRunId),
      };
    }
    return result;
  }

  private async recordBackoff(
    operation: Operation,
    outcome: ProgressCall | "transient",
  ): Promise<number> {
    const { lease, ref } = operation;
    const { database, clock, backoff, report } = this.options;
    const now = clock.now();
    const retryAt = backoff.result(ref.credential, now, outcome, () =>
      report("credential_rejected", lease),
    );
    const rejected =
      outcome !== "transient" &&
      outcome.status === "unavailable" &&
      outcome.code === "credential_rejected";
    if (retryAt > now || rejected) {
      await database.recordProgressCredentialCooldown({
        triggerRunId: lease.triggerRunId,
        organizationId: lease.organizationId,
        key: credentialKey(operation),
        retryAt: retryAt > now ? new Date(retryAt) : null,
        rejectedUntil: rejected ? new Date(now + CREDENTIAL_CIRCUIT_MS) : null,
      });
    }
    return retryAt;
  }

  private async recordRefusal(
    { lease, kind }: Operation,
    outcome: Extract<ProgressCall, { status: "gone" | "refused" | "unavailable" }>,
  ): Promise<WriteResult> {
    const targetGone = outcome.status === "gone" && kind === "create";
    const state = targetGone ? "unavailable" : outcome.status;
    const goneCode = targetGone ? "target_not_found" : "gone";
    const failure =
      outcome.status === "gone" ? goneCode : failureCode(outcome.code, outcome.status);
    const result = await this.afterSend(lease, { state, failure, settleAt: null });
    if (result.row !== undefined && failure !== "credential_rejected")
      this.options.report(failure, lease);
    return result;
  }

  private recordCreated(
    operation: Operation,
    now: number,
    reference: StoredRef | undefined,
    secrets: readonly string[],
  ): Promise<WriteResult> {
    const { lease, ref, run } = operation;
    const stored = parseStoredRef(reference);
    if (
      stored === undefined ||
      JSON.stringify(stored.credential) !== JSON.stringify(ref.credential) ||
      secrets.some((secret) => secret !== "" && JSON.stringify(stored).includes(secret))
    ) {
      return this.afterSend(lease, { state: "abandoned", failure: "invalid_reference" });
    }
    return this.afterSend(lease, {
      ...this.successPatch(operation, now),
      state: run.status === "running" ? "active" : "finished",
      externalRef: stored,
    });
  }

  private async finish(operation: Operation, now: number): Promise<WriteResult> {
    const { lease } = operation;
    const { database } = this.options;
    // An urgent compensation must not consume the scheduled settle.
    const settleAt = new Date(now + SETTLE_MS);
    const result = await this.afterSend(lease, {
      ...this.successPatch(operation, now),
      state: "finished",
      settleAt,
      repeatFinal: false,
    });
    if (result.row === undefined) return result;
    await database.requestCompensation(lease.organizationId, lease.triggerRunId, settleAt);
    if (lease.repeatFinal)
      await database.requestCompensation(
        lease.organizationId,
        lease.triggerRunId,
        new Date(now + REGULAR_TIMEOUT_WAIT_MS),
      );
    return { row: await database.findRunProgressMessage(lease.organizationId, lease.triggerRunId) };
  }

  private successPatch(operation: Operation, now: number): Patch {
    const { lease, kind, hash } = operation;
    return {
      lastRenderedHash: hash,
      lastEditAt: new Date(now),
      failedEdits: kind === "repair" ? lease.failedEdits : 0,
      retryAt: null,
      failure: null,
    };
  }

  private transientFailure(
    operation: Operation,
    retryAt: number,
    timeout: boolean,
    sent: boolean,
  ): Promise<WriteResult> {
    const { lease, kind, run } = operation;
    const now = this.options.clock.now();
    const finalFailures = lease.finalFailures + Number(kind === "final");
    const nextAt =
      kind === "final"
        ? Math.min(
            Math.max(retryAt, now + (FINAL_RETRY_MS[finalFailures - 1] ?? SWEEP_MS * 10)),
            (run.completedAt?.getTime() ?? now) + FINAL_WINDOW_MS,
          )
        : Math.max(retryAt, now + 1);
    const patch: Patch = {
      ...(kind === "create" ? { state: "pending" } : {}),
      failedEdits: lease.failedEdits + Number(kind === "regular"),
      finalFailures,
      repeatFinal: lease.repeatFinal || timeout,
      retryAt: new Date(nextAt),
      failure: "transient_failure",
    };
    if (sent) return this.afterSend(lease, patch, nextAt);
    return this.release(lease, patch, nextAt);
  }

  private async afterSend(
    lease: RunProgressMessage,
    patch: Patch,
    wakeAt?: number,
  ): Promise<WriteResult> {
    const { database, signal } = this.options;
    if (signal.aborted) return {};
    let recorded = false;
    try {
      const result = await this.release(lease, patch, wakeAt);
      recorded = result.row !== undefined;
      return result;
    } finally {
      if (!recorded && !signal.aborted)
        await database.requestCompensation(lease.organizationId, lease.triggerRunId);
    }
  }

  private stopMessage(
    lease: RunProgressMessage,
    state: "abandoned" | "refused" | "unavailable",
    failure: string,
  ): Promise<WriteResult> {
    return this.release(lease, { state, failure, settleAt: null }).then((result) => {
      if (result.row !== undefined) this.options.report(failure, lease);
      return result;
    });
  }

  private async release(
    lease: RunProgressMessage,
    patch: Patch = {},
    wakeAt?: number,
  ): Promise<WriteResult> {
    if (this.options.signal.aborted) return {};
    const row = await this.update(lease, patch);
    return { row, ...(wakeAt === undefined ? {} : { wakeAt }) };
  }

  private update(lease: RunProgressMessage, patch: Patch, releaseLease = true) {
    return this.options.database.updateRunProgressMessage({
      organizationId: lease.organizationId,
      triggerRunId: lease.triggerRunId,
      owner: this.owner,
      version: lease.version,
      now: new Date(this.options.clock.now()),
      patch,
      releaseLease,
    });
  }
}
