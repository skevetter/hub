import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, it, vi } from "vitest";
import { Duration, formatDuration, observeElapsedTime } from "./duration.js";

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  change(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

afterEach(() => vi.useRealTimers());

describe("human run duration", () => {
  it("formats seconds, minutes and hours without unbounded seconds", () => {
    for (const [milliseconds, expected] of [
      [0, "0s"],
      [999, "0s"],
      [1000, "1s"],
      [61_000, "1m 1s"],
      [252_000, "4m 12s"],
      [70_535_000, "19h 35m"],
      [86_400_000, "24h 0m"],
      [-1000, "0s"],
      [NaN, "0s"],
    ] as const)
      assert.equal(formatDuration(milliseconds), expected);
  });

  it("ticks a short run, pauses while hidden and catches up when visible", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T12:00:00.000Z") });
    const visibility = new Visibility();
    const started = Date.now();
    let label = "";
    const stop = observeElapsedTime(
      started,
      (now) => {
        label = formatDuration(now - started);
      },
      visibility,
    );
    try {
      await vi.advanceTimersByTimeAsync(2000);
      assert.equal(label, "2s");
      visibility.change("hidden");
      await vi.advanceTimersByTimeAsync(10000);
      assert.equal(label, "2s");
      visibility.change("visible");
      assert.equal(label, "12s");
      stop();
      await vi.advanceTimersByTimeAsync(30000);
      assert.equal(label, "12s");
    } finally {
      stop();
    }
  });

  it("uses five-second ticks for minutes and thirty-second ticks for hours", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T12:00:00.000Z") });
    const visibility = new Visibility();
    let label = "";
    const minuteStart = Date.now() - 61_000;
    const stopMinute = observeElapsedTime(
      minuteStart,
      (now) => {
        label = formatDuration(now - minuteStart);
      },
      visibility,
    );
    try {
      await vi.advanceTimersByTimeAsync(4999);
      assert.equal(label, "1m 1s");
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(label, "1m 6s");
    } finally {
      stopMinute();
    }
    const hourStart = Date.now() - 3_600_000;
    const ticks: number[] = [];
    const stopHour = observeElapsedTime(
      hourStart,
      (now) => {
        ticks.push(now - hourStart);
      },
      visibility,
    );
    try {
      await vi.advanceTimersByTimeAsync(60000);
      assert.deepEqual(ticks, [3_600_000, 3_630_000, 3_660_000]);
    } finally {
      stopHour();
    }
  });

  it("renders a terminal duration from persisted completion without a browser clock", () => {
    const markup = renderToStaticMarkup(
      <Duration
        startedAt="2026-11-16T12:00:00.000Z"
        completedAt="2026-11-16T12:04:12.000Z"
        durationMs={null}
        running={false}
      />,
    );
    assert.match(markup, />4m 12s</u);
  });
});
