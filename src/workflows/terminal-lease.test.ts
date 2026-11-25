import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  seedTerminalNotification,
  TERMINAL_LEASE_MS,
  TERMINAL_TEST_ORG,
} from "../db/test-utils/terminal-notification.js";
import { RunTimelineBus } from "../run-timeline/bus.js";
import { RunTimeline } from "../run-timeline/index.js";
import { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { DurableWorkflowEngine } from "./engine.js";
import type { DurableWorkflowEngineOptions } from "./engine.js";

const HOLD_CAP_MS = 55_000;

type FixtureOptions = Pick<DurableWorkflowEngineOptions, "terminalNotificationHoldMs"> & {
  reconcile?: boolean;
};

async function fixture({ reconcile = false, ...options }: FixtureOptions = {}) {
  const now = () => new Date();
  const database = createMemoryDatabase({ organizationIds: [TERMINAL_TEST_ORG], now });
  const runId = await seedTerminalNotification(database, now());
  const logger = {
    error: vi.fn<(record: unknown, message?: unknown) => void>(),
    warn: vi.fn<(record: unknown, message?: unknown) => void>(),
  };
  const started = Promise.withResolvers<void>();
  const handler = Promise.withResolvers<void>();
  const onWorkflowRunTerminal = vi.fn(() => {
    started.resolve();
    return handler.promise;
  });
  const engine = new DurableWorkflowEngine({
    database,
    entitlements: null,
    now,
    logger,
    onWorkflowRunTerminal,
    ...options,
    ...(reconcile ? { timelineReconciler: createReconciler(database) } : {}),
  });
  return {
    engine,
    handler,
    logger,
    started: started.promise,
    onWorkflowRunTerminal,
    runId,
    renew: vi.spyOn(database, "renewWorkflowRunTerminalNotification"),
    mark: vi.spyOn(database, "markWorkflowRunTerminalNotificationDelivered"),
    claim: () => database.claimPendingWorkflowRunTerminalNotification(now(), TERMINAL_LEASE_MS),
    readRun: () => database.findTriggerRunById(runId),
  };
}

function createReconciler(database: ReturnType<typeof createMemoryDatabase>) {
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

async function start(work: Awaited<ReturnType<typeof fixture>>) {
  await work.engine.processAvailable();
  await work.started;
}

function expectReport(work: Awaited<ReturnType<typeof fixture>>, operation: string) {
  const calls = [...work.logger.error.mock.calls, ...work.logger.warn.mock.calls];
  const reports = calls.filter(
    ([record]) =>
      typeof record === "object" &&
      record !== null &&
      "operation" in record &&
      record.operation === operation,
  );
  expect(reports).toEqual([
    [
      expect.objectContaining({ operation, diagnostic: { triggerRunId: work.runId } }),
      expect.any(String),
    ],
  ]);
}

describe("terminal notification lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the claim through a 70 second handler and marks it once", async () => {
    const work = await fixture();
    await start(work);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(work.renew).toHaveBeenCalledTimes(7);
    expect(await work.claim()).toBeUndefined();
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(work.mark).toHaveBeenCalledExactlyOnceWith(work.runId, 1, new Date(), null);
    expect(await work.readRun()).toMatchObject({ terminalNotificationDeliveredAt: new Date() });
    expect(work.onWorkflowRunTerminal).toHaveBeenCalledTimes(1);
    await work.engine.stop();
  });

  it("renews while reconciling before the provider handler can run", async () => {
    const reconciliation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    vi.spyOn(RunTimelineReconciler.prototype, "reconcileBeforeTerminal").mockImplementation(() => {
      entered.resolve();
      return reconciliation.promise;
    });
    const work = await fixture({ reconcile: true });
    await work.engine.processAvailable();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await work.claim()).toBeUndefined();
    expect(work.onWorkflowRunTerminal).not.toHaveBeenCalled();
    reconciliation.resolve();
    await work.started;
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mark).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await work.engine.stop();
  });

  it("stops after a refused renewal and drops the result after another claimer takes over", async () => {
    const work = await fixture();
    work.renew.mockResolvedValueOnce(false);
    await start(work);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await work.claim()).toMatchObject({ id: work.runId, terminalNotificationGeneration: 2 });
    expect(work.renew).toHaveBeenCalledTimes(1);
    expectReport(work, "workflow.notification.terminal.lease_lost");
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mark).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await work.engine.stop();
  });

  it("waits for an in-flight renewal result before deciding whether to mark", async () => {
    const work = await fixture();
    const renewal = Promise.withResolvers<boolean>();
    work.renew.mockReturnValueOnce(renewal.promise);
    await start(work);
    await vi.advanceTimersByTimeAsync(10_000);
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mark).not.toHaveBeenCalled();
    renewal.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mark).not.toHaveBeenCalled();
    expectReport(work, "workflow.notification.terminal.lease_lost");
    expect(vi.getTimerCount()).toBe(0);
    await work.engine.stop();
  });

  it.each([true, false])("releases the lease at the hold cap (replay: %s)", async (replay) => {
    const work = await fixture({ terminalNotificationHoldMs: HOLD_CAP_MS });
    await start(work);
    await vi.advanceTimersByTimeAsync(HOLD_CAP_MS - 1);
    expect(await work.claim()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expectReport(work, "workflow.notification.terminal.hold_cap");
    expect(vi.getTimerCount()).toBe(0);
    if (replay) {
      expect(await work.claim()).toMatchObject({
        id: work.runId,
        terminalNotificationGeneration: 2,
      });
    }
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mark).toHaveBeenCalledExactlyOnceWith(work.runId, 1, new Date(), null);
    expect(await work.readRun()).toMatchObject({
      terminalNotificationDeliveredAt: replay ? null : new Date(),
    });
    await work.engine.stop();
  });

  it("reports the hold cap even while a renewal is in flight", async () => {
    const work = await fixture({ terminalNotificationHoldMs: HOLD_CAP_MS });
    const renewal = Promise.withResolvers<boolean>();
    work.renew.mockReturnValueOnce(renewal.promise);
    await start(work);
    await vi.advanceTimersByTimeAsync(HOLD_CAP_MS);
    expectReport(work, "workflow.notification.terminal.hold_cap");
    expect(vi.getTimerCount()).toBe(0);
    renewal.resolve(true);
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.renew).toHaveBeenCalledTimes(1);
    expect(work.mark).toHaveBeenCalledTimes(1);
    await work.engine.stop();
  });

  it("lets another claimer recover after renewals stop mid-handler", async () => {
    const work = await fixture();
    await start(work);
    await vi.advanceTimersByTimeAsync(10_000);
    const stopping = work.engine.stop();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(TERMINAL_LEASE_MS - 1);
    expect(await work.claim()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await work.claim()).toMatchObject({ id: work.runId, terminalNotificationGeneration: 2 });
    expect(work.renew).toHaveBeenCalledTimes(1);
    expect(work.mark).not.toHaveBeenCalled();
    work.handler.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a thrown renewal and still marks the successful handler result", async () => {
    const work = await fixture();
    work.renew.mockRejectedValueOnce(new Error("temporary renew failure"));
    await start(work);
    await vi.advanceTimersByTimeAsync(35_000);
    expectReport(work, "workflow.notification.terminal.renew");
    expect(work.renew).toHaveBeenCalledTimes(3);
    expect(await work.claim()).toBeUndefined();
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mark).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await work.engine.stop();
  });

  it("keeps the claim and marks once when renewals throw past the lease expiry", async () => {
    const work = await fixture();
    for (let i = 0; i < 3; i += 1) work.renew.mockRejectedValueOnce(new Error("database blip"));
    await start(work);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(work.renew).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(work.renew).toHaveBeenCalledTimes(4);
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.mark).toHaveBeenCalledExactlyOnceWith(work.runId, 1, new Date(), null);
    expect(await work.readRun()).toMatchObject({ terminalNotificationDeliveredAt: new Date() });
    expect(await work.claim()).toBeUndefined();
    expect(work.onWorkflowRunTerminal).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await work.engine.stop();
  });

  it("still runs the handler when slow reconciling outlasts the lease with every renewal failing", async () => {
    const reconciliation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    vi.spyOn(RunTimelineReconciler.prototype, "reconcileBeforeTerminal").mockImplementation(() => {
      entered.resolve();
      return reconciliation.promise;
    });
    const work = await fixture({ reconcile: true });
    for (let i = 0; i < 3; i += 1) work.renew.mockRejectedValueOnce(new Error("database blip"));
    await work.engine.processAvailable();
    await entered.promise;
    await vi.advanceTimersByTimeAsync(35_000);
    expect(work.renew).toHaveBeenCalledTimes(3);
    reconciliation.resolve();
    await work.started;
    work.handler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(work.onWorkflowRunTerminal).toHaveBeenCalledTimes(1);
    expect(work.mark).toHaveBeenCalledExactlyOnceWith(work.runId, 1, new Date(), null);
    expect(await work.claim()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await work.engine.stop();
  });

  it("clears renewal when the handler rejects", async () => {
    const work = await fixture();
    await start(work);
    work.handler.reject(new Error("provider hook failed"));
    await vi.advanceTimersByTimeAsync(0);
    expectReport(work, "workflow.notification.terminal.deliver");
    expect(work.mark).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await work.engine.stop();
  });
});
