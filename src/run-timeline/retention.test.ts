import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { isRunTimelineExpired, retentionCutoff, TimelineRetention } from "./retention.js";
import { assertBackgroundSweepExits } from "./test-utils/background-exit.js";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const HOUR_MS = 60 * 60_000;

describe("timeline retention eligibility", () => {
  it("subtracts fixed days without changing the supplied date", () => {
    const now = new Date("2026-03-09T00:30:00-04:00");
    assert.equal(retentionCutoff(now, 2).toISOString(), "2026-03-07T04:30:00.000Z");
    assert.equal(now.toISOString(), "2026-03-09T04:30:00.000Z");
    assert.equal(retentionCutoff(NOW, 30).toISOString(), "2026-10-17T12:00:00.000Z");
  });

  it("uses a strict completion cutoff and preserves live runs", () => {
    const cutoff = retentionCutoff(NOW, 30);
    assert.equal(isRunTimelineExpired({ completedAt: null }, cutoff), false);
    assert.equal(isRunTimelineExpired({ completedAt: cutoff }, cutoff), false);
    assert.equal(
      isRunTimelineExpired({ completedAt: new Date(cutoff.getTime() + 1) }, cutoff),
      false,
    );
    assert.equal(
      isRunTimelineExpired({ completedAt: new Date(cutoff.getTime() - 1) }, cutoff),
      true,
    );
  });

  it("keeps a tombstone expired even when the retention window grows", () => {
    const run = { completedAt: new Date("2026-10-01"), expiredAt: new Date("2026-11-01") };
    assert.equal(isRunTimelineExpired(run, retentionCutoff(NOW, 365)), true);
    assert.equal(
      isRunTimelineExpired({ completedAt: null, expiredAt: NOW }, retentionCutoff(NOW, 365)),
      true,
    );
  });
});

describe("TimelineRetention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sweeps in batches of 500 with cancellable 250ms pauses and one cutoff", async () => {
    let now = NOW;
    const expireRunTimelines = vi
      .fn<(cutoff: Date, batch: number) => Promise<number>>()
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(12)
      .mockResolvedValue(0);
    const retention = new TimelineRetention(
      { expireRunTimelines },
      { retentionDays: 30, now: () => now },
    );
    retention.start();
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(expireRunTimelines.mock.calls.length, 1);
    now = new Date(NOW.getTime() + HOUR_MS);
    await vi.advanceTimersByTimeAsync(249);
    assert.equal(expireRunTimelines.mock.calls.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(expireRunTimelines.mock.calls.length, 2);
    await vi.advanceTimersByTimeAsync(250);
    assert.deepEqual(expireRunTimelines.mock.calls, [
      [retentionCutoff(NOW, 30), 500],
      [retentionCutoff(NOW, 30), 500],
      [retentionCutoff(NOW, 30), 500],
    ]);
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    assert.equal(expireRunTimelines.mock.calls.length, 3);
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(expireRunTimelines.mock.calls[3], [retentionCutoff(now, 30), 500]);
    await retention.stop();
    assert.equal(vi.getTimerCount(), 0);
  });

  it("delegates expiration to the completion predicate and leaves live rows untouched", async () => {
    const cutoff = retentionCutoff(NOW, 30);
    const rows = [
      {
        completedAt: new Date(cutoff.getTime() - 1),
        expiredAt: null as Date | null,
        events: 2,
        messages: 1,
      },
      { completedAt: null, expiredAt: null as Date | null, events: 2, messages: 1 },
      { completedAt: cutoff, expiredAt: null as Date | null, events: 2, messages: 1 },
      { completedAt: NOW, expiredAt: null as Date | null, events: 2, messages: 1 },
      { completedAt: new Date(0), expiredAt: NOW, events: 0, messages: 0 },
    ];
    const expireRunTimelines = vi.fn(async (completionCutoff: Date, batchSize: number) => {
      const expired = [];
      for (const row of rows) {
        if (
          row.expiredAt === null &&
          row.completedAt !== null &&
          row.completedAt < completionCutoff
        )
          expired.push(row);
        if (expired.length >= batchSize) break;
      }
      for (const row of expired) {
        row.events = 0;
        row.messages = 0;
        row.expiredAt = NOW;
      }
      return expired.length;
    });
    const retention = new TimelineRetention({ expireRunTimelines }, { retentionDays: 30 });
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(expireRunTimelines.mock.calls, [[cutoff, 500]]);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map(({ events, messages, expiredAt }) => ({ events, messages, expiredAt })),
      [
        { events: 0, messages: 0, expiredAt: NOW },
        { events: 2, messages: 1, expiredAt: null },
        { events: 2, messages: 1, expiredAt: null },
        { events: 2, messages: 1, expiredAt: null },
        { events: 0, messages: 0, expiredAt: NOW },
      ],
    );
    await retention.stop();
  });

  it("stops immediately during a batch pause without advancing timers", async () => {
    const expireRunTimelines = vi.fn(async () => 500);
    const retention = new TimelineRetention({ expireRunTimelines }, { retentionDays: 30 });
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(vi.getTimerCount(), 1);
    await retention.stop();
    assert.equal(vi.getTimerCount(), 0);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    assert.equal(expireRunTimelines.mock.calls.length, 1);
  });

  it("waits for in-flight work and never starts a following full batch after stop", async () => {
    const batch = Promise.withResolvers<number>();
    const expireRunTimelines = vi.fn(() => batch.promise);
    const retention = new TimelineRetention({ expireRunTimelines }, { retentionDays: 30 });
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    const markStopped = vi.fn();
    const stopping = retention.stop().then(markStopped);
    retention.start();
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    assert.equal(markStopped.mock.calls.length, 0);
    assert.equal(expireRunTimelines.mock.calls.length, 1);
    batch.resolve(500);
    await stopping;
    assert.equal(markStopped.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("retries failures after a minute without overlapping an active sweep", async () => {
    const batch = Promise.withResolvers<number>();
    const failure = new Error("database unavailable");
    const expireRunTimelines = vi.fn(() => batch.promise).mockResolvedValueOnce(500);
    const reportFailure = vi.fn();
    const retention = new TimelineRetention(
      { expireRunTimelines },
      { retentionDays: 30, reportFailure },
    );
    retention.start();
    await vi.advanceTimersByTimeAsync(250);
    assert.equal(expireRunTimelines.mock.calls.length, 2);
    retention.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    assert.equal(expireRunTimelines.mock.calls.length, 2);
    batch.reject(failure);
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(reportFailure.mock.calls, [[failure]]);
    expireRunTimelines.mockResolvedValue(0);
    await vi.advanceTimersByTimeAsync(59_999);
    assert.equal(expireRunTimelines.mock.calls.length, 2);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(expireRunTimelines.mock.calls.length, 3);
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    assert.equal(expireRunTimelines.mock.calls.length, 3);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(expireRunTimelines.mock.calls.length, 4);
    await retention.stop();
  });

  it("isolates reporter failures and cleanly stops an in-flight database failure", async () => {
    const batch = Promise.withResolvers<number>();
    const failure = new Error("database unavailable");
    const expireRunTimelines = vi.fn(() => batch.promise);
    const reportFailure = vi.fn(() => {
      throw new Error("reporter unavailable");
    });
    const retention = new TimelineRetention(
      { expireRunTimelines },
      { retentionDays: 30, reportFailure },
    );
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = retention.stop();
    batch.reject(failure);
    await assert.doesNotReject(stopping);
    assert.equal(reportFailure.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("can stop before its first sweep and restart after a completed stop", async () => {
    const expireRunTimelines = vi.fn(async () => 0);
    const retention = new TimelineRetention({ expireRunTimelines }, { retentionDays: 30 });
    await retention.stop();
    retention.start();
    await retention.stop();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(expireRunTimelines.mock.calls.length, 0);
    retention.start();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(expireRunTimelines.mock.calls.length, 1);
    await retention.stop();
    await retention.stop();
    assert.equal(vi.getTimerCount(), 0);
  });
});

describe("native retention timer liveness", () => {
  it.each(["retention", "retention_pause"] as const)(
    "lets the native process exit without waiting for %s timers",
    async (mode) => {
      await assertBackgroundSweepExits(mode);
    },
  );
});
