import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { AcceptedTriggerRunRecord, Database, WorkflowStepRunRecord } from "../db/types.js";
import { RunTimelineBus } from "./bus.js";
import { RunTimeline } from "./index.js";
import { createObservedDatabase } from "./observed-database.js";
import { RunTimelineQueue } from "./queue.js";
import { RunTimelineReconciler } from "./reconcile.js";
import type { AppendRunTimelineEventInput } from "./store.js";
import {
  URL_USERINFO_CANDIDATES,
  URL_USERINFO_SCHEMES,
} from "./test-utils/url-userinfo-fixtures.js";

const SCOPE = { organizationId: "org", triggerRunId: "run" };
const NOW = new Date("2026-01-01T00:00:00Z");
const RUN = {
  id: SCOPE.triggerRunId,
  organizationId: SCOPE.organizationId,
  configuredTriggerName: "fixture",
  outcome: "accepted",
  status: "running",
  createdAt: NOW,
  completedAt: null,
  payloadExpiredAt: null,
} satisfies Partial<AcceptedTriggerRunRecord>;

function captureOptions() {
  return {
    bus: new RunTimelineBus(),
    now: () => NOW,
    scrub: (value: string) => value,
    maxEvents: 500,
    retentionDays: 30,
  };
}

test("keeps ordinary, drop, and control ordering and preserves shutdown errors", async () => {
  const trace: (string | number)[] = [];
  const queue = new RunTimelineQueue(
    {
      recordRunTimelineDrops: async (_org, _id, count) => {
        trace.push(count);
        return { seq: 1, inserted: false, noticeSeq: 2 };
      },
    },
    { bus: new RunTimelineBus(), now: () => NOW, reportFailure: () => trace.push("reported") },
  );
  const work = Promise.withResolvers<void>();
  assert.equal(
    queue.enqueue(SCOPE, () => work.promise),
    true,
  );
  queue.recordDrops(SCOPE, 3);
  const control = queue.run(SCOPE, async () => {
    trace.push("control");
    throw new Error("control rejected");
  });
  const rejected = assert.rejects(control, { message: "control rejected" });
  work.resolve();
  await rejected;
  assert.equal(await queue.flush(), true);
  assert.deepEqual(trace, [3, "control"]);
  const active = Promise.withResolvers<void>();
  queue.enqueue(SCOPE, () => active.promise);
  const discarded = assert.rejects(
    queue.run(SCOPE, async () => undefined),
    {
      message: "Timeline capture flush exceeded its deadline",
    },
  );
  assert.equal(await queue.stop(0), false);
  await discarded;
  active.resolve();
  assert.equal(await queue.flush(), true);
  await assert.rejects(
    queue.run(SCOPE, async () => undefined),
    {
      message: "Timeline capture queue is closed",
    },
  );
});

function captureDatabase(rows: AppendRunTimelineEventInput[]): Database {
  const scripts = [
    { stepId: "later", status: "pending", startedAt: null, agentExecutionId: null },
    { stepId: "work", status: "running", startedAt: NOW, agentExecutionId: null },
  ] satisfies Partial<WorkflowStepRunRecord>[];
  return Object.assign(createMemoryDatabase(), {
    findTriggerRunForOrganization: async () => RUN,
    resolveRunForExecution: async () => ({ ...SCOPE, stepId: "work" }),
    readRunTimelineState: async () => ({ origin: "captured", sealedSeq: null }),
    listWorkflowStepRunsForTriggerRun: async () => scripts,
    appendRunTimelineEvent: async (event: AppendRunTimelineEventInput) => {
      rows.push(event);
      return { seq: rows.length, inserted: true };
    },
  });
}

test("captures script starts and ignores snapshot agent events", async () => {
  const rows: AppendRunTimelineEventInput[] = [];
  const timeline = new RunTimeline(captureDatabase(rows), captureOptions());
  timeline.recordStepStart(SCOPE, "missing");
  timeline.recordStepStart(SCOPE, "work");
  timeline.begin("execution", SCOPE);
  timeline.observeAgentEvent(
    "execution",
    { type: "turn_failed", provider: "claude", error: "one" },
    NOW,
    "snapshot",
  );
  timeline.observeAgentEvent(
    "execution",
    { type: "turn_failed", provider: "claude", error: "two" },
    NOW,
  );
  await timeline.flush();
  assert.deepEqual(
    rows.map((row) => [row.kind, row.stepId]),
    [
      ["run_started", ""],
      ["step_started", "work"],
      ["turn_failed", "work"],
    ],
  );
});

test("reconciles a running timeline without finishing unstarted steps", async () => {
  const rows: AppendRunTimelineEventInput[] = [];
  const reconciler = new RunTimelineReconciler(captureDatabase(rows), {
    ...captureOptions(),
    queue: { run: (_scope, work) => work() },
  });
  await reconciler.reconcile(SCOPE.organizationId, SCOPE.triggerRunId);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.stepId, row.origin]),
    [
      ["run_started", undefined, "captured"],
      ["step_started", "work", "captured"],
    ],
  );
});

test("observes recovery after persistence and leaves other methods bound", async () => {
  const trace: string[] = [];
  const original = Object.assign(createMemoryDatabase(), {
    findTriggerRunById: async () => RUN,
    recoverWorkflowDeadlines: () => persisted.promise,
    identifiesReceiver() {
      return this === original;
    },
  });
  const persisted = Promise.withResolvers<{ triggerRunId: string }[]>();
  const observed = createObservedDatabase(original, {
    timeline: { recordRunStart: () => undefined, recordStepStart: () => undefined },
    reconciler: {
      reconcile: async (organizationId, id) => {
        trace.push(organizationId, id);
      },
    },
  });
  assert.equal(observed.recoverWorkflowDeadlines(NOW), persisted.promise);
  assert.deepEqual(trace, []);
  const bound: unknown = Reflect.get(observed, "identifiesReceiver");
  assert.equal(typeof bound === "function" && Reflect.apply(bound, undefined, []), true);
  assert.equal(Reflect.get(observed, "identifiesReceiver"), bound);
  persisted.resolve([{ triggerRunId: RUN.id }]);
  await setImmediate();
  assert.deepEqual(trace, [SCOPE.organizationId, RUN.id]);
});

test("enumerates zero to four URL separators in scheme and mask order", () => {
  const raw = URL_USERINFO_CANDIDATES.filter(
    (row) => row.variant === "raw" && row.credential === "password",
  );
  for (const [index, scheme] of URL_USERINFO_SCHEMES.entries()) {
    const rows = raw.slice(index * 31, (index + 1) * 31);
    assert.deepEqual(
      rows.map((row) => row.scheme),
      Array<string>(31).fill(scheme),
    );
    assert.deepEqual(
      rows.slice(0, 7).map((row) => row.separators),
      ["", "/", "\\", "//", "\\/", "/\\", "\\\\"],
    );
    assert.equal(rows.at(-1)?.separators, "\\".repeat(4));
  }
});
