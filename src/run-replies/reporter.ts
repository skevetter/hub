import type { OnRunReplyAnswer } from "../daemons/reply-capture.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import type { FinalReplyAnswer } from "./format.js";
import type { LinearRunReplyWriter } from "./linear.js";
import type { RunReplyRecord, RunReplyScope } from "./store.js";

const POLL_MS = 2_000;
// Recovery only handles rows older than the grace period, so idle checks can be rare.
const IDLE_POLL_MS = 30_000;
const RECOVERY_GRACE_MS = 120_000;
const MISSING_PROVIDER_GRACE_MS = 600_000;
const PROVIDER_TIMEOUT_MS = 15_000;

interface ReporterOptions {
  database: Database;
  writer: () => LinearRunReplyWriter | undefined;
  perHour: number;
  onFailure?: () => void;
}

interface CapturedRun {
  scope: RunReplyScope;
  answers: Map<string, FinalReplyAnswer | null>;
}

export class RunReplyReporter {
  private readonly captured = new Map<string, CapturedRun>();
  private readonly shutdown = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private processing: Promise<void> | undefined;

  constructor(private readonly options: ReporterOptions) {}

  capture: OnRunReplyAnswer = (scope, executionId, answer) => {
    if (this.shutdown.signal.aborted) return;
    let captured = this.captured.get(scope.runId);
    if (captured === undefined) {
      captured = { scope, answers: new Map() };
      this.captured.set(scope.runId, captured);
    }
    captured.answers.set(executionId, answer);
    this.schedule(POLL_MS);
  };

  start(): void {
    if (this.started || this.shutdown.signal.aborted) return;
    this.started = true;
    this.schedule(IDLE_POLL_MS);
  }

  // A captured answer needs the fast cadence; with none waiting a slow check is enough.
  private schedule(delay: number): void {
    if (!this.started || this.shutdown.signal.aborted) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.processAvailable()
        .catch(() => {
          if (!this.shutdown.signal.aborted) this.options.onFailure?.();
        })
        .finally(() => this.schedule(this.captured.size > 0 ? POLL_MS : IDLE_POLL_MS));
    }, delay).unref();
  }

  processAvailable(): Promise<void> {
    this.processing ??= this.process().finally(() => {
      this.processing = undefined;
    });
    return this.processing;
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.shutdown.abort();
    this.captured.clear();
    await this.processing?.catch(() => undefined);
  }

  private async process(): Promise<void> {
    // Snapshot the work so a dispatch finishing while we await cannot lengthen this cycle.
    const captured = Array.from(this.captured.values());
    for (const entry of captured) {
      if (this.shutdown.signal.aborted) return;
      if (await this.deliverCaptured(entry)) this.captured.delete(entry.scope.runId);
    }
    if (!this.shutdown.signal.aborted) await this.recover();
  }

  /** Keeps the capture available while the workflow can still fail. */
  private async deliverCaptured({ scope, answers }: CapturedRun): Promise<boolean> {
    const { database, perHour } = this.options;
    const run = await database.findTriggerRunForOrganization(scope.organizationId, scope.runId);
    if (run?.outcome !== "accepted") return true;
    if (run.status === "running") return false;
    if (run.status !== "succeeded") {
      await database.runReplies.finish({ ...scope, from: "pending", failure: "run_unsuccessful" });
      return true;
    }
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    const last = steps.findLast((step) => step.agentExecutionId !== null);
    const answer = last?.agentExecutionId == null ? undefined : answers.get(last.agentExecutionId);
    if (answer === undefined) return true;
    const writer = this.options.writer();
    if (answer === null || writer === undefined) {
      await database.runReplies.finish({
        ...scope,
        from: "pending",
        failure: answer === null ? "empty_answer" : "connection_unavailable",
      });
      return true;
    }
    const signal = this.providerSignal();
    try {
      await writer.post(run, answer, perHour, signal);
      return true;
    } catch (error) {
      if (!signal.aborted) throw error;
      if (!this.shutdown.signal.aborted) {
        await database.runReplies.finish({
          ...scope,
          from: "pending",
          failure: "connection_unavailable",
        });
      }
      return true;
    }
  }

  private async recover(): Promise<void> {
    const { database } = this.options;
    const now = Date.now();
    const due = await database.runReplies.recoverable(new Date(now - RECOVERY_GRACE_MS));
    for (const delivery of due.slice(0, 4)) {
      if (this.shutdown.signal.aborted) return;
      const { organizationId, runId } = delivery;
      const run = await database.findTriggerRunForOrganization(organizationId, runId);
      if (run?.outcome !== "accepted") continue;
      if (delivery.state === "pending") {
        await database.runReplies.finish({
          organizationId,
          runId,
          from: "pending",
          failure: run.status === "succeeded" ? "answer_unavailable" : "run_unsuccessful",
        });
      } else if (delivery.state === "sending") {
        await this.repair(run, delivery, now);
      }
    }
  }

  private async repair(run: AcceptedTriggerRunRecord, delivery: RunReplyRecord, now: number) {
    const writer = this.options.writer();
    if (writer !== undefined) {
      const signal = this.providerSignal();
      try {
        await writer.repair(run, delivery, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        if (!this.shutdown.signal.aborted) await this.declineUnconfirmed(delivery);
      }
    } else if (
      delivery.attemptedAt !== null &&
      delivery.attemptedAt.getTime() <= now - MISSING_PROVIDER_GRACE_MS
    ) {
      await this.declineUnconfirmed(delivery);
    }
  }

  private declineUnconfirmed({ organizationId, runId }: RunReplyScope) {
    return this.options.database.runReplies.finish({
      organizationId,
      runId,
      from: "sending",
      failure: "delivery_unconfirmed",
    });
  }

  private providerSignal(): AbortSignal {
    return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)]);
  }
}
