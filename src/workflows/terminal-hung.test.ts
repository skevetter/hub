import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  seedTerminalNotification,
  TERMINAL_TEST_ORG,
} from "../db/test-utils/terminal-notification.js";
import type { TriggerRunRecord } from "../db/types.js";
import type { JsonValue } from "../config/compiler.js";
import { RunTimelineBus } from "../run-timeline/bus.js";
import { RunTimeline } from "../run-timeline/index.js";
import { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { DurableWorkflowEngine } from "./engine.js";

const HOLD_MS = 55_000;
const GRACE_MS = 10_000;

async function fixture(hungRuns: number, options: { reconcile?: boolean } = {}) {
  const now = () => new Date();
  const database = createMemoryDatabase({ organizationIds: [TERMINAL_TEST_ORG], now });
  const runIds: string[] = [];
  for (let i = 0; i < hungRuns + 1; i += 1) {
    runIds.push(await seedTerminalNotification(database, now(), { provider: "slack" }));
    await vi.advanceTimersByTimeAsync(1);
  }
  const hung = new Set(runIds.slice(0, hungRuns));
  const calls: string[] = [];
  const gates: PromiseWithResolvers<JsonValue>[] = [];
  const logger = {
    error: vi.fn<(record: unknown, message?: unknown) => void>(),
    warn: vi.fn<(record: unknown, message?: unknown) => void>(),
  };
  const engine = new DurableWorkflowEngine({
    database,
    entitlements: null,
    now,
    logger,
    terminalNotificationHoldMs: HOLD_MS,
    terminalNotificationStopGraceMs: GRACE_MS,
    onWorkflowRunTerminal: (run: TriggerRunRecord) => {
      calls.push(run.id);
      if (!hung.has(run.id)) return Promise.resolve();
      const gate = Promise.withResolvers<JsonValue>();
      gates.push(gate);
      return gate.promise;
    },
    ...(options.reconcile ? { timelineReconciler: hangingReconciler(database) } : {}),
  });
  return { engine, database, runIds, calls, gates, logger };
}

function hangingReconciler(database: ReturnType<typeof createMemoryDatabase>) {
  vi.spyOn(RunTimelineReconciler.prototype, "reconcileBeforeTerminal").mockImplementation(
    () => new Promise<void>(() => undefined),
  );
  const options = {
    bus: new RunTimelineBus(),
    scrub: createTimelineScrubber(),
    maxEvents: 500,
    retentionDays: 30,
  };
  return new RunTimelineReconciler(database, {
    ...options,
    queue: new RunTimeline(database, options),
  });
}

async function stopEngine(work: Awaited<ReturnType<typeof fixture>>) {
  const stopping = work.engine.stop();
  await vi.advanceTimersByTimeAsync(GRACE_MS);
  await stopping;
}

interface Report {
  operation: string;
  diagnostic: Record<string, unknown>;
}

function isReport(record: unknown): record is Report {
  return typeof record === "object" && record !== null && "operation" in record;
}

function reports(work: Awaited<ReturnType<typeof fixture>>, operation: string): Report[] {
  return [...work.logger.error.mock.calls, ...work.logger.warn.mock.calls]
    .map(([record]) => record)
    .filter(isReport)
    .filter((record) => record.operation === operation);
}

async function delivered(work: Awaited<ReturnType<typeof fixture>>) {
  const runs = await Promise.all(work.runIds.map((id) => work.database.findTriggerRunById(id)));
  return runs.map(
    (run) => run?.outcome === "accepted" && run.terminalNotificationDeliveredAt !== null,
  );
}

describe("hung terminal notification handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("gives up on a hung handler at the bound and logs the run, provider and elapsed time", async () => {
    const work = await fixture(1);
    const pass = work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(reports(work, "workflow.notification.terminal.timeout")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await pass;
    const [timeout] = reports(work, "workflow.notification.terminal.timeout");
    expect(timeout?.diagnostic).toEqual({
      triggerRunId: work.runIds[0],
      provider: "slack",
      elapsedMs: HOLD_MS,
      abandonedPending: 1,
    });
    expect(await delivered(work)).toEqual([false, true]);
    await stopEngine(work);
  });

  it("costs each of two hung runs one bound and still delivers the healthy run behind them", async () => {
    const work = await fixture(2);
    void work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(work.calls).toEqual([work.runIds[0]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.calls).toEqual([work.runIds[0], work.runIds[1]]);
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(await delivered(work)).toEqual([false, false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.calls).toEqual(work.runIds);
    expect(await delivered(work)).toEqual([false, false, true]);
    expect(
      reports(work, "workflow.notification.terminal.timeout").map(
        (record) => record.diagnostic["abandonedPending"],
      ),
    ).toEqual([1, 2]);
    await stopEngine(work);
  });

  it("claims an abandoned run again on a later pass with a higher generation", async () => {
    const work = await fixture(1);
    const pass = work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await pass;
    await work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.calls).toEqual([work.runIds[0], work.runIds[1], work.runIds[0]]);
    await stopEngine(work);
  });

  it("stops within the grace period while a handler hangs", async () => {
    const work = await fixture(1);
    void work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(5_000);
    let stopped = false;
    const stopping = (async () => {
      await work.engine.stop();
      stopped = true;
    })();
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
    expect(reports(work, "workflow.notification.terminal.stop_grace")).toHaveLength(1);
  });

  it("abandons a reconcile that never returns without calling the handler", async () => {
    const work = await fixture(0, { reconcile: true });
    void work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(work.calls).toEqual([]);
    expect(reports(work, "workflow.notification.terminal.timeout")).toHaveLength(1);
    await stopEngine(work);
  });
  it("fences a hook that finishes after a re-claim so the run is delivered once", async () => {
    const work = await fixture(1);
    const pass = work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await pass;
    await work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.gates).toHaveLength(2);
    const read = () => work.database.findTriggerRunById(work.runIds[0] ?? "");
    const before = await read();
    work.gates[0]?.resolve({ by: "first claim" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await read()).toEqual(before);
    expect(before).toMatchObject({ terminalNotificationDeliveredAt: null });
    work.gates[1]?.resolve({ by: "second claim" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await read()).toMatchObject({
      reactionState: { by: "second claim" },
      terminalNotificationDeliveredAt: new Date(),
    });
    expect(work.calls).toEqual([work.runIds[0], work.runIds[1], work.runIds[0]]);
    await stopEngine(work);
  });

  it("warns once three abandoned handlers are pending", async () => {
    const work = await fixture(3);
    const backlog = () =>
      work.logger.warn.mock.calls.filter(
        ([record]) =>
          typeof record === "object" &&
          record !== null &&
          "operation" in record &&
          record.operation === "workflow.notification.terminal.abandoned_backlog",
      );
    void work.engine.processAvailable();
    await vi.advanceTimersByTimeAsync(2 * HOLD_MS);
    expect(backlog()).toEqual([]);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(backlog()).toEqual([
      [expect.objectContaining({ abandonedPending: 3 }), expect.any(String)],
    ]);
    await stopEngine(work);
  });
});
