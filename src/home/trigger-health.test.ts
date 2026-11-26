import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import type * as StateLabel from "../components/app/state-label.js";
import { runState, type StateView } from "../components/app/state-label.js";
import { FAILED_RUN_STATUSES } from "../triggers/run-status.js";
import type { HomeSnapshot } from "./dashboard.js";
import { failingTriggers } from "./trigger-health.js";

const toneOverride = vi.hoisted(() => new Map<string, StateView>());
vi.mock("../components/app/state-label.js", async (importOriginal) => {
  const actual = await importOriginal<typeof StateLabel>();
  return {
    ...actual,
    runListState: (status: string) => toneOverride.get(status) ?? actual.runListState(status),
  };
});
afterEach(() => toneOverride.clear());

type Status = NonNullable<HomeSnapshot["triggerRuns"][number]["latest"]>["status"];

const trigger = (id: string, enabled = true): HomeSnapshot["triggers"][number] => ({
  id,
  name: id,
  event: "manual.run",
  enabled,
});
const runs = (triggerId: string, status: Status | null) => ({
  triggerId,
  total: status === null ? 0 : 1,
  failed: status === "failed" ? 1 : 0,
  latest:
    status === null
      ? null
      : { id: `${triggerId}-run`, status, startedAt: "2026-11-24T10:00:00.000Z" },
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

describe("failing triggers", () => {
  it.each(EVERY_STATUS)("counts a trigger whose last run is %s by the state it shows", (status) => {
    const count = failingTriggers({
      triggers: [trigger("fine"), trigger("subject")],
      triggerRuns: [runs("fine", "succeeded"), runs("subject", status)],
    });
    assert.equal(count, runState(status).tone === "attention" ? 1 : 0);
  });

  it("follows the state a run shows, so a status that turns red is counted", () => {
    toneOverride.set("canceled", { label: "Canceled", tone: "attention" });
    const count = failingTriggers({
      triggers: [trigger("fine"), trigger("odd")],
      triggerRuns: [runs("fine", "succeeded"), runs("odd", "canceled")],
    });
    assert.equal(count, 1);
  });

  it("counts exactly the statuses the unsuccessful Activity filter lists", () => {
    assert.ok(EVERY_STATUS_LISTED);
    for (const status of EVERY_STATUS) {
      assert.equal(FAILED_RUN_STATUSES.has(status), runState(status).tone === "attention", status);
    }
  });

  it("never counts a paused trigger, one without runs, or one without a summary", () => {
    const count = failingTriggers({
      triggers: [trigger("a"), trigger("b", false), trigger("c"), trigger("d"), trigger("e")],
      triggerRuns: [
        runs("a", "failed"),
        runs("b", "failed"),
        runs("c", null),
        runs("e", "timed_out"),
      ],
    });
    assert.equal(count, 2);
  });
});
