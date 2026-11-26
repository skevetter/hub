import assert from "node:assert/strict";
import { test } from "vitest";
import { timelineBudgetExceeded } from "./data.js";
import type { RunTimelineState, TimelineKind } from "./store.js";

const STATE: RunTimelineState = {
  triggerRunId: "run",
  organizationId: "organization",
  eventCount: 0,
  byteCount: 0,
  stepEndCount: 0,
  stepEndBytes: 0,
  stepRowsOmitted: 0,
  droppedCount: 0,
  sealedSeq: null,
  sealedAt: null,
  origin: "captured",
  expiredAt: null,
};

const CASES: readonly [
  name: string,
  kind: TimelineKind,
  counts: Partial<RunTimelineState>,
  bytes: number,
  maxEvents: number,
  notice: boolean,
  expected: boolean,
][] = [
  ["ordinary count below limit", "turn_started", { eventCount: 49 }, 0, 50, false, false],
  ["ordinary count at limit", "turn_started", { eventCount: 50 }, 0, 50, false, true],
  ["notice excludes one event", "turn_started", { eventCount: 50 }, 0, 50, true, false],
  ["count at limit with notice", "turn_started", { eventCount: 51 }, 0, 50, true, true],
  [
    "step endings excluded from count",
    "tool_finished",
    { eventCount: 52, stepEndCount: 3 },
    0,
    50,
    false,
    false,
  ],
  [
    "step endings and notice excluded",
    "tool_finished",
    { eventCount: 53, stepEndCount: 3 },
    0,
    50,
    true,
    false,
  ],
  ["higher event limit", "tool_finished", { eventCount: 500 }, 0, 501, false, false],
  ["higher event limit reached", "tool_finished", { eventCount: 501 }, 0, 501, false, true],
  ["ordinary bytes below limit", "agent_started", { byteCount: 196607 }, 0, 50, false, false],
  ["ordinary bytes at limit", "agent_started", { byteCount: 196607 }, 1, 50, false, false],
  [
    "ordinary bytes over limit with notice",
    "agent_started",
    { byteCount: 196607 },
    2,
    50,
    true,
    true,
  ],
  [
    "state already over ordinary byte limit",
    "agent_started",
    { byteCount: 196609 },
    0,
    50,
    false,
    true,
  ],
  ["step ending count below limit", "step_finished", { stepEndCount: 99 }, 0, 50, false, false],
  ["step ending count at limit", "step_finished", { stepEndCount: 100 }, 0, 50, true, true],
  ["step ending bytes below limit", "step_finished", { stepEndBytes: 51199 }, 0, 50, true, false],
  ["step ending bytes at limit", "step_finished", { stepEndBytes: 51199 }, 1, 50, false, false],
  ["step ending bytes over limit", "step_finished", { stepEndBytes: 51199 }, 2, 50, false, true],
  [
    "step ending ignores ordinary limits",
    "step_finished",
    { eventCount: 500, byteCount: 196609 },
    2,
    50,
    false,
    false,
  ],
  [
    "run ending ignores both limits",
    "run_finished",
    { eventCount: 500, stepEndCount: 100, byteCount: 196609, stepEndBytes: 51201 },
    2,
    50,
    true,
    false,
  ],
  [
    "truncation ignores both limits",
    "truncated",
    { eventCount: 500, stepEndCount: 100, byteCount: 196609, stepEndBytes: 51201 },
    2,
    50,
    false,
    false,
  ],
];

test("matches the frozen timeline budget decisions at event and byte boundaries", () => {
  for (const [name, kind, counts, bytes, maxEvents, notice, expected] of CASES) {
    const state = { ...STATE, ...counts };
    assert.equal(timelineBudgetExceeded({ state, kind, bytes, maxEvents, notice }), expected, name);
  }
});
