import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { runState } from "../components/app/state-label.js";
import { FAILED_RUN_STATUSES } from "../triggers/run-status.js";
import type { HomeSnapshot } from "./dashboard.js";
import { triggerHealth } from "./trigger-health.js";

type Status = NonNullable<HomeSnapshot["triggerRuns"][number]["latest"]>["status"];

const trigger = (id: string, enabled = true, name = id): HomeSnapshot["triggers"][number] => ({
  id,
  name,
  event: "manual.run",
  enabled,
});
const runs = (triggerId: string, status: Status | null, at = "2026-11-24T10:00:00.000Z") => ({
  triggerId,
  total: status === null ? 0 : 1,
  failed: status === "failed" ? 1 : 0,
  latest: status === null ? null : { id: `${triggerId}-run`, status, startedAt: at },
});

// A new run status will not compile until it is listed here, and then it is checked below.
const EVERY_STATUS = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
  "rejected",
] as const satisfies readonly Status[];
const EVERY_STATUS_LISTED: [Exclude<Status, (typeof EVERY_STATUS)[number]>] extends [never]
  ? true
  : false = true;

describe("trigger health", () => {
  it.each(EVERY_STATUS)(
    "counts, colours and sorts a trigger whose last run is %s by one definition",
    (status) => {
      const health = triggerHealth({
        triggers: [trigger("fine"), trigger("subject")],
        triggerRuns: [
          runs("fine", "succeeded", "2026-11-24T12:00:00.000Z"),
          runs("subject", status),
        ],
      });
      const red = runState(status).tone === "attention";
      const subject = health.rows.findIndex(({ id }) => id === "subject");
      assert.equal(health.failing, red ? 1 : 0);
      assert.equal(health.rows[subject]?.state.tone === "attention", red);
      assert.equal(subject === 0, red || status === "running");
      assert.equal(health.latestFailure !== null, red);
    },
  );

  it("shows the window's failed tally for exactly the statuses that turn a row red", () => {
    assert.ok(EVERY_STATUS_LISTED);
    for (const status of EVERY_STATUS) {
      assert.equal(FAILED_RUN_STATUSES.has(status), runState(status).tone === "attention", status);
    }
  });

  it("orders needs-a-person, running, fine, then off, newest first inside a group", () => {
    const { rows } = triggerHealth({
      triggers: ["ok", "idle", "paused", "old", "live", "new", "tied"].map((id) =>
        trigger(id, id !== "paused"),
      ),
      triggerRuns: [
        runs("ok", "succeeded"),
        runs("idle", null),
        runs("paused", "failed"),
        runs("old", "timed_out", "2026-11-24T08:00:00.000Z"),
        runs("live", "running"),
        runs("new", "failed", "2026-11-24T09:00:00.000Z"),
        runs("tied", "rejected", "2026-11-24T08:00:00.000Z"),
      ],
    });
    assert.deepEqual(
      rows.map(({ id }) => id),
      ["new", "old", "tied", "live", "ok", "idle", "paused"],
    );
  });

  it("names the state of each row from its last run, or from being switched off", () => {
    const { rows } = triggerHealth({
      triggers: [trigger("a"), trigger("b"), trigger("c", false), trigger("d")],
      triggerRuns: [
        runs("a", "failed"),
        runs("b", null),
        runs("c", "failed"),
        runs("d", "canceled"),
      ],
    });
    const labels = Object.fromEntries(rows.map(({ id, state }) => [id, state.label]));
    assert.deepEqual(labels, { a: "Failed", b: "No runs yet", c: "Disabled", d: "Canceled" });
  });

  it("counts failing, running and paused triggers; a paused trigger never fails", () => {
    const health = triggerHealth({
      triggers: [trigger("a"), trigger("b"), trigger("c", false), trigger("d"), trigger("e")],
      triggerRuns: [
        runs("a", "failed"),
        runs("b", "running"),
        runs("c", "failed"),
        runs("d", "succeeded"),
        runs("e", "timed_out"),
      ],
    });
    assert.deepEqual(
      { failing: health.failing, running: health.running, paused: health.paused },
      { failing: 2, running: 1, paused: 1 },
    );
  });

  it("offers the newest failed run of the failing triggers, and none when nothing fails", () => {
    const failing = triggerHealth({
      triggers: [trigger("a", true, "Audit"), trigger("b", true, "Triage"), trigger("c")],
      triggerRuns: [
        runs("a", "failed", "2026-11-24T08:00:00.000Z"),
        runs("b", "timed_out", "2026-11-24T11:00:00.000Z"),
        runs("c", "succeeded", "2026-11-24T12:00:00.000Z"),
      ],
    });
    assert.deepEqual(failing.latestFailure, {
      triggerName: "Triage",
      runId: "b-run",
      status: "timed_out",
      startedAt: "2026-11-24T11:00:00.000Z",
    });
    assert.equal(
      triggerHealth({ triggers: [trigger("c")], triggerRuns: [runs("c", "succeeded")] })
        .latestFailure,
      null,
    );
  });

  it("treats a trigger without a summary as having no runs", () => {
    const health = triggerHealth({ triggers: [trigger("a")], triggerRuns: [] });
    assert.deepEqual(
      health.rows.map(({ state, total, latest }) => [state.label, total, latest]),
      [["No runs yet", 0, null]],
    );
  });
});
