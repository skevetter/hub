import type { RunProgressSettings } from "../run-progress/settings.js";
import type { AcceptedTriggerRunRecord } from "../db/types.js";
import type { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import { isRunTimelineExpired, retentionCutoff } from "../run-timeline/retention.js";
import type {
  RunTimelineEvent,
  RunTimelineState,
  RunTimelineStore,
} from "../run-timeline/store.js";
import type { RunStreamNotifier } from "./notifier.js";

export type StreamCloseReason =
  | "end"
  | "abort"
  | "shutdown"
  | "reauth"
  | "max_age"
  | "slow_consumer"
  | "error";
export interface StreamContext {
  run: AcceptedTriggerRunRecord;
  state: RunTimelineState | undefined;
}

const encoder = new TextEncoder();
const HIGH_WATER_MARK = 16 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024;

export function controlEvent(kind: string, data: unknown): string {
  return `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class RunStreamSubscriber {
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly abort = new AbortController();
  private readonly done = Promise.withResolvers<void>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly startedAt = performance.now();
  private reauthorizationTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private ping = false;
  private page: RunTimelineEvent[] = [];
  private index = 0;
  private eventsSent = 0;
  private readonly onAbort = () => this.finish("abort");

  constructor(
    private readonly options: {
      store: RunTimelineStore;
      reconciler: Pick<RunTimelineReconciler, "reconcileBeforeTerminal">;
      notifier: RunStreamNotifier;
      context: StreamContext;
      firstSeq: number | null;
      after: number;
      settings: RunProgressSettings;
      request: Request;
      reauthorize(): Promise<boolean>;
      reportFailure(error: unknown): void;
      release(reason: StreamCloseReason, durationMs: number, eventsSent: number): void;
    },
  ) {
    let cursor = options.after;
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
          const { run, state } = options.context;
          this.enqueue(
            `retry: 5000\n\n: stream open\n\n${controlEvent("status", {
              runId: run.id,
              status: run.status,
              firstSeq: options.firstSeq,
              lastSeq: state?.eventCount ?? 0,
              sealedSeq: state?.sealedSeq ?? null,
              stepRowsOmitted: state?.stepRowsOmitted ?? 0,
              origin: state?.origin ?? null,
            })}`,
          );
        },
        pull: async () => {
          const produce = async () => {
            while (!this.closed) {
              if (this.index < this.page.length) {
                const row = this.page[this.index++]!;
                if (
                  this.enqueue(
                    `id: ${row.seq}\nevent: ${row.kind}\ndata: ${JSON.stringify({
                      seq: row.seq,
                      kind: row.kind,
                      at: row.at,
                      stepId: row.stepId,
                      data: row.data,
                    })}\n\n`,
                  )
                ) {
                  cursor = row.seq;
                  this.eventsSent += 1;
                }
                return;
              }
              this.page = [];
              this.index = 0;
              if (this.ping) {
                this.ping = false;
                this.enqueue(": ping\n\n");
                return;
              }
              const version = options.notifier.version;
              const context = await this.readContext();
              if (this.closed || context === undefined) return;
              const page = await options.notifier.page(cursor);
              if (this.closed) return;
              if (page.length > 0) {
                this.page = page;
                continue;
              }
              const { run, state } = context;
              if (
                run.status !== "running" &&
                state?.sealedSeq != null &&
                cursor >= state.sealedSeq
              ) {
                this.finish(
                  "end",
                  controlEvent("end", {
                    status: run.status,
                    lastSeq: state.eventCount,
                    sealedSeq: state.sealedSeq,
                    stepRowsOmitted: state.stepRowsOmitted,
                  }),
                );
                return;
              }
              await options.notifier.wait(version, this.abort.signal);
            }
          };
          await Promise.race([
            produce().catch((error: unknown) => {
              options.reportFailure(error);
              this.finish("error", controlEvent("error", { code: "infrastructure_unavailable" }));
            }),
            this.done.promise,
          ]);
        },
        cancel: () => this.finish("abort"),
      },
      { highWaterMark: HIGH_WATER_MARK, size: (chunk) => chunk.byteLength },
    );
    options.request.signal.addEventListener("abort", this.onAbort, { once: true });
    if (options.request.signal.aborted) {
      queueMicrotask(this.onAbort);
      return;
    }
    this.timers.push(
      setInterval(() => {
        this.ping = true;
        options.notifier.wake();
      }, options.settings.streamHeartbeatSeconds * 1000),
    );
    this.timers.push(
      setTimeout(() => {
        this.finish("max_age", controlEvent("reconnect", { reconnectMs: 5000 }));
      }, options.settings.streamMaxSeconds * 1000),
    );
    const reauthorize = async () => {
      try {
        if (!(await options.reauthorize())) {
          this.finish("reauth", controlEvent("error", { code: "unauthorized" }));
        }
      } catch {
        this.finish("reauth", controlEvent("error", { code: "unauthorized" }));
      }
      if (!this.closed)
        this.reauthorizationTimer = setTimeout(() => {
          void reauthorize();
        }, 60_000).unref();
    };
    this.reauthorizationTimer = setTimeout(() => {
      void reauthorize();
    }, 60_000).unref();
    for (const timer of this.timers) timer.unref();
  }

  finish(reason: StreamCloseReason, frame?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    clearTimeout(this.reauthorizationTimer);
    this.options.request.signal.removeEventListener("abort", this.onAbort);
    this.abort.abort();
    this.page = [];
    try {
      if (frame !== undefined) this.controller.enqueue(encoder.encode(frame));
      this.controller.close();
    } catch {}
    this.done.resolve();
    this.options.release(reason, performance.now() - this.startedAt, this.eventsSent);
  }

  private enqueue(frame: string): boolean {
    if (this.closed) return false;
    const bytes = encoder.encode(frame);
    if (HIGH_WATER_MARK - (this.controller.desiredSize ?? 0) + bytes.byteLength > MAX_QUEUE_BYTES) {
      this.finish("slow_consumer", controlEvent("error", { code: "slow_consumer" }));
      return false;
    }
    this.controller.enqueue(bytes);
    return true;
  }

  private async readContext(): Promise<StreamContext | undefined> {
    const {
      store,
      context: { run: original },
      settings,
      reconciler,
    } = this.options;
    const run = await store.findTriggerRunForOrganization(original.organizationId, original.id);
    if (this.closed) return undefined;
    let state = await store.readRunTimelineState(original.organizationId, original.id);
    if (this.closed) return undefined;
    if (run?.outcome !== "accepted") {
      this.finish("error", controlEvent("error", { code: "run_not_found" }));
      return undefined;
    }
    if (
      isRunTimelineExpired(
        { completedAt: run.completedAt, expiredAt: state?.expiredAt ?? null },
        retentionCutoff(new Date(), settings.retentionDays),
      )
    ) {
      this.finish("error", controlEvent("error", { code: "timeline_expired" }));
      return undefined;
    }
    if (run.status !== "running" && state?.sealedSeq == null) {
      await reconciler.reconcileBeforeTerminal(run.organizationId, run.id);
      if (this.closed) return undefined;
      state = await store.readRunTimelineState(run.organizationId, run.id);
    }
    return { run, state };
  }
}
