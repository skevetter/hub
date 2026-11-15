import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { LastTriggered } from "./last-triggered.js";
import { recentRunsLabel, summarizeRecentRuns, type RecentRuns } from "./recent-runs.js";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const runs = (...statuses: [string, number][]) =>
  statuses.map(([status, hours]) => ({ status, receivedAt: hoursAgo(hours) }));

describe("recent run summary", () => {
  it("counts only the runs from the last 24 hours", () => {
    assert.deepEqual(
      summarizeRecentRuns(
        runs(["succeeded", 1], ["failed", 23], ["failed", 25], ["succeeded", 100]),
        NOW,
      ),
      { total: 2, succeeded: 1, failed: 1 },
    );
  });

  it("counts a timed out run as failed and a running one as neither", () => {
    assert.deepEqual(
      summarizeRecentRuns(runs(["timed_out", 1], ["running", 1], ["succeeded", 2]), NOW),
      { total: 3, succeeded: 1, failed: 1 },
    );
  });

  it("labels all succeeded, all failed, and a mix", () => {
    const label = (recent: RecentRuns) => recentRunsLabel(recent, "Running");
    assert.equal(label({ total: 12, succeeded: 12, failed: 0 }), "Succeeded");
    assert.equal(label({ total: 12, succeeded: 0, failed: 12 }), "Failed");
    assert.equal(label({ total: 12, succeeded: 10, failed: 2 }), "2 of 12 failed");
    assert.equal(label({ total: 12, succeeded: 0, failed: 1 }), "1 of 12 failed");
  });

  it("has no label without runs, and falls back to the latest status while runs are unfinished", () => {
    assert.equal(recentRunsLabel({ total: 0, succeeded: 0, failed: 0 }, "Succeeded"), undefined);
    assert.equal(recentRunsLabel({ total: 3, succeeded: 1, failed: 0 }, "Running"), "Running");
  });
});

describe("last triggered cell", () => {
  const render = (
    lastTriggered: { status: string; receivedAt: string } | null,
    recentRuns: RecentRuns,
  ) =>
    renderToStaticMarkup(<LastTriggered lastTriggered={lastTriggered} recentRuns={recentRuns} />);
  const latest = { status: "failed", receivedAt: hoursAgo(1) };

  it("keeps the empty state for a trigger that never ran", () => {
    const markup = render(null, { total: 0, succeeded: 0, failed: 0 });
    assert.match(markup, />Never</u);
  });

  it("shows one failed run among twelve as a count, not as the trigger failing", () => {
    const markup = render(latest, { total: 12, succeeded: 10, failed: 2 });
    assert.match(markup, />2 of 12 failed</u);
    assert.doesNotMatch(markup, />Failed</u);
  });

  it("shows Succeeded when every run succeeded, even if the latest status is a different word", () => {
    assert.match(
      render({ ...latest, status: "succeeded" }, { total: 4, succeeded: 4, failed: 0 }),
      />Succeeded</u,
    );
  });

  it("shows Failed when every run failed", () => {
    assert.match(render(latest, { total: 3, succeeded: 0, failed: 3 }), />Failed</u);
  });

  it("shows the time alone when the latest run is older than 24 hours", () => {
    const markup = render(
      { status: "failed", receivedAt: hoursAgo(72) },
      {
        total: 0,
        succeeded: 0,
        failed: 0,
      },
    );
    assert.doesNotMatch(markup, /Failed|Succeeded|failed/u);
  });
});
