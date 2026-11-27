import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import type { DaemonAgentStreamEvent } from "../daemons/protocol.js";
import { HubExecutionAgentStreamEventSchema } from "../hub/protocol.js";
import { CAPTURED_TOOL_CALLS } from "../daemons/test-utils/tool-call-fixtures.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import { RunTimelineBus } from "./bus.js";
import { timelineStepId } from "./data.js";
import { RunTimeline } from "./index.js";
import { RunTimelineReconciler } from "./reconcile.js";
import { createTimelineScrubber } from "./scrub.js";
import {
  USERINFO_SCHEMES,
  USERINFO_WHITESPACE,
  userinfoWhitespaceCase,
} from "./test-utils/userinfo-fixtures.js";
import {
  BENIGN_URL_CASES,
  URL_USERINFO_STORAGE_CASES,
} from "./test-utils/url-userinfo-fixtures.js";

const ORGANIZATION = "capture-organization";
const PAGE = { afterSeq: 0, limit: 5110 };
const captures = new Set<RunTimeline>();

function urlPrivacyGroups() {
  const groups: {
    name: string;
    useful: string | null;
    samples: { name: string; value: string; secret: string }[];
  }[] = [];
  for (const [index, variant] of USERINFO_WHITESPACE.entries()) {
    const samples = [];
    for (let field = 0; field < 4; field++)
      samples.push(
        userinfoWhitespaceCase(
          USERINFO_SCHEMES[(index + field) % USERINFO_SCHEMES.length]!,
          variant,
        ),
      );
    groups.push({ name: variant.name, useful: null, samples });
  }
  for (const sample of URL_USERINFO_STORAGE_CASES)
    groups.push({
      name: sample.name,
      useful: null,
      samples: [sample, sample, sample, sample],
    });
  for (const benign of BENIGN_URL_CASES) {
    const sample = { ...benign, secret: "" };
    groups.push({
      name: sample.name,
      useful: sample.useful,
      samples: [sample, sample, sample, sample],
    });
  }
  return groups;
}

function assertStoredUrlFields(
  rows: Awaited<ReturnType<Database["listRunTimelineEvents"]>>,
  name: string,
  useful: string | null,
): void {
  for (const [kind, field] of [
    ["run_started", "trigger"],
    ["turn_failed", "error"],
    ["turn_canceled", "reason"],
    ["step_finished", "failure"],
    ["run_finished", "failure"],
  ]) {
    const value = rows.find((row) => row.kind === kind)?.data[field!];
    if (useful === null) {
      assert.ok(value === "[redacted]", `whole-field marker for ${name} ${kind}`);
    } else {
      assert.ok(
        typeof value === "string" && value.includes(useful),
        `useful URL for ${name} ${kind}`,
      );
    }
  }
}

function assertNoStoredFragments(
  stored: string,
  samples: readonly { name: string; secret: string }[],
): void {
  for (const sample of samples) {
    for (let offset = 0; offset <= sample.secret.length - 8; offset += 1) {
      assert.equal(
        stored.includes(sample.secret.slice(offset, offset + 8)),
        false,
        `credential fragment retained for ${sample.name}`,
      );
    }
  }
}

async function fixture(
  stepIds = ["work"],
  database: Database = createMemoryDatabase({ organizationIds: [ORGANIZATION] }),
) {
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Capture",
    slug: "capture",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "capture-configuration",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  async function createRun(ids: string[], configuredTriggerName = "timeline") {
    const receipt = await database.persistManualEvent({
      organizationId: ORGANIZATION,
      projectId: project.id,
      deliveryId: randomUUID(),
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") throw new Error("Manual receipt was not accepted");
    return (
      await database.createAcceptedTriggerRun({
        organizationId: ORGANIZATION,
        projectId: project.id,
        configurationRevisionId: revision.id,
        providerEventReceiptId: receipt.event.providerEventReceiptId,
        configuredTriggerName,
        conversation: { key: "shared-conversation", label: "Shared conversation" },
        prompt: "",
        inputs: {},
        triggerContext: {},
        outputContext: {},
        deadlineAt: new Date(Date.now() + 3_600_000),
        stepIds: ids,
      })
    ).run;
  }
  async function link(run: AcceptedTriggerRunRecord) {
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    return Promise.all(
      steps.map(async (step) => {
        const execution = await database.insertAgentExecution({
          organizationId: ORGANIZATION,
          projectId: project.id,
          machineId: null,
          configurationRevisionId: revision.id,
          workflowStepRunId: step.id,
          triggerContext: {},
          outputContext: {},
        });
        await database.linkWorkflowStepRunExecution(step.id, execution.id);
        return execution;
      }),
    );
  }
  const run = await createRun(stepIds);
  const executions = await link(run);
  const scope = { organizationId: ORGANIZATION, triggerRunId: run.id };
  return { database, run, executions, scope, createRun, link };
}

async function embeddedPrivacyDatabase() {
  const root = await mkdtemp(join(tmpdir(), "hub-timeline-privacy-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
  try {
    await runtime.migrate();
    await runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Capture', 'capture')",
      [ORGANIZATION],
    );
    return {
      database: createDatabase(runtime, locks),
      close: async () => {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function capture(database: Database, reportFailure = vi.fn()) {
  const timeline = new RunTimeline(database, {
    bus: new RunTimelineBus(),
    scrub: createTimelineScrubber(),
    maxEvents: 500,
    retentionDays: 30,
    reportFailure,
  });
  captures.add(timeline);
  return { timeline, reportFailure };
}

function tool(status: string, callId?: string): DaemonAgentStreamEvent {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "tool_call", name: "Bash", status, ...(callId === undefined ? {} : { callId }) },
  };
}

function observe(timeline: RunTimeline, executionId: string, event: DaemonAgentStreamEvent) {
  timeline.observeAgentEvent(executionId, event, new Date());
}

afterEach(async () => {
  await Promise.all([...captures].map((timeline) => timeline.stop()));
  captures.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RunTimeline capture", () => {
  it("opens only at begin and ignores snapshots, unknown items, and unrelated executions", async () => {
    const { database, run, executions } = await fixture();
    const executionId = executions[0]!.id;
    const { timeline } = capture(database);
    observe(timeline, executionId, tool("completed", "before-prompt"));
    await timeline.flush();
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
    timeline.begin(executionId);
    timeline.observeAgentEvent(
      executionId,
      tool("completed", "snapshot-argument"),
      new Date(),
      "snapshot",
    );
    observe(timeline, executionId, {
      ...tool("completed", "snapshot-field"),
      source: "snapshot",
    } as DaemonAgentStreamEvent);
    observe(
      timeline,
      executionId,
      HubExecutionAgentStreamEventSchema.parse({
        type: "timeline",
        provider: "claude",
        item: { type: "future_item", text: "not stored" },
      }),
    );
    assert.equal(
      HubExecutionAgentStreamEventSchema.safeParse({ type: "future_event", text: "not stored" })
        .success,
      false,
    );
    timeline.begin("unknown-execution");
    observe(timeline, "unknown-execution", tool("completed", "unknown"));
    await timeline.flush();
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
    observe(timeline, executionId, tool("completed", "after-prompt"));
    await timeline.flush();
    assert.deepEqual(
      (await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).map(
        (row) => row.data["callId"],
      ),
      ["after-prompt"],
    );
    timeline.release(executionId);
    timeline.release("unknown-execution");
    assert.equal(timeline.activeExecutionCount(), 0);
  });

  it.each(CAPTURED_TOOL_CALLS)(
    "projects the real $provider tool flow in arrival order without payload fields",
    async ({ provider, items }) => {
      const { database, run, executions, scope } = await fixture();
      const executionId = executions[0]!.id;
      const { timeline } = capture(database);
      timeline.recordRunStart(scope);
      timeline.recordStepStart(scope, "work");
      timeline.begin(executionId);
      observe(timeline, executionId, { type: "thread_started", provider, sessionId: "not-stored" });
      observe(timeline, executionId, { type: "turn_started", provider });
      const observedAt = new Date("2026-11-16T10:00:00.000Z");
      for (const item of items) {
        timeline.observeAgentEvent(
          executionId,
          { type: "timeline", provider, item: { ...item, status: "running" } },
          observedAt,
        );
        timeline.observeAgentEvent(
          executionId,
          { type: "timeline", provider, item: { ...item } },
          observedAt,
        );
      }
      observe(timeline, executionId, { type: "turn_completed", provider });
      await timeline.flush();
      const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
      assert.deepEqual(
        rows.map((row) => row.kind),
        [
          "run_started",
          "step_started",
          "agent_started",
          "turn_started",
          ...items.flatMap(() => ["tool_started", "tool_finished"]),
          "turn_ended",
        ],
      );
      const categories =
        provider === "claude"
          ? ["read", "command", "edit", "read"]
          : ["command", "command", "edit", "command"];
      assert.deepEqual(
        rows
          .filter((row) => row.kind.startsWith("tool_"))
          .map((row) => ({ kind: row.kind, data: row.data, stepId: row.stepId, at: row.at })),
        items.flatMap((item, index) => [
          {
            kind: "tool_started",
            data: { callId: item.callId, tool: item.name, category: categories[index] },
            stepId: "work",
            at: observedAt,
          },
          {
            kind: "tool_finished",
            data: {
              callId: item.callId,
              tool: item.name,
              category: categories[index],
              status: "completed",
            },
            stepId: "work",
            at: observedAt,
          },
        ]),
      );
      assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq, null);
      assert.equal((await database.findTriggerRunById(run.id))?.status, "running");
    },
  );

  it("captures permission waits, resolution, failure and cancellation without completing persisted workflow state", async () => {
    const { database, run, executions } = await fixture();
    const executionId = executions[0]!.id;
    const { timeline } = capture(database);
    timeline.begin(executionId);
    observe(timeline, executionId, {
      type: "permission_requested",
      provider: "claude",
      request: { toolName: "Read", path: "not-stored" },
    });
    observe(timeline, executionId, {
      type: "permission_resolved",
      provider: "claude",
      requestId: "not-stored",
      resolution: { approved: true },
    });
    observe(timeline, executionId, {
      type: "turn_failed",
      provider: "claude",
      error: "connection closed",
    });
    observe(timeline, executionId, {
      type: "turn_canceled",
      provider: "claude",
      reason: "interrupted",
    });
    await timeline.flush();
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(
      rows.map((row) => ({ kind: row.kind, data: row.data })),
      [
        { kind: "permission_requested", data: { tool: "Read" } },
        { kind: "permission_resolved", data: {} },
        { kind: "turn_failed", data: { error: "connection closed" } },
        { kind: "turn_canceled", data: { reason: "interrupted" } },
      ],
    );
    assert.equal((await database.findTriggerRunById(run.id))?.status, "running");
    assert.equal((await database.listWorkflowStepRunsForTriggerRun(run.id))[0]?.status, "running");
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq, null);
  });

  it.each([
    {
      name: "memory",
      open: async () => ({
        database: createMemoryDatabase({ organizationIds: [ORGANIZATION] }),
        close: async () => undefined,
      }),
    },
    { name: "embedded PostgreSQL", open: embeddedPrivacyDatabase },
  ])(
    "stores whole-field URL userinfo markers and useful credential-free paths on $name",
    async ({ open }) => {
      const harness = await open();
      const { database } = harness;
      const { timeline, reportFailure } = capture(database);
      try {
        const { createRun, link } = await fixture(["work"], database);
        const reconciler = new RunTimelineReconciler(database, {
          queue: timeline,
          maxEvents: 500,
          retentionDays: 30,
          scrub: createTimelineScrubber(),
          bus: new RunTimelineBus(),
          reportFailure,
        });
        const groups = urlPrivacyGroups();
        for (const { name, useful, samples } of groups) {
          const run = await createRun(["work"], samples[0]!.value);
          const [execution] = await link(run);
          assert.ok(execution);
          const scope = { organizationId: ORGANIZATION, triggerRunId: run.id };
          timeline.recordRunStart(scope);
          timeline.begin(execution.id, scope);
          observe(timeline, execution.id, {
            type: "turn_failed",
            provider: "claude",
            error: samples[1]!.value,
          });
          observe(timeline, execution.id, {
            type: "turn_canceled",
            provider: "claude",
            reason: samples[2]!.value,
          });
          await timeline.flush();
          await database.completeWorkflowAgentExecution({
            executionId: execution.id,
            executionStatus: "failed",
            stepStatus: "failed",
            result: {},
            failureReason: samples[3]!.value,
          });
          await reconciler.reconcile(ORGANIZATION, run.id);
          const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
          assertStoredUrlFields(rows, name, useful);
          const stored = JSON.stringify({
            rows,
            state: await database.readRunTimelineState(ORGANIZATION, run.id),
          });
          assertNoStoredFragments(stored, samples);
          timeline.release(execution.id);
        }
        assert.equal(reportFailure.mock.calls.length, 0);
      } finally {
        await timeline.stop();
        captures.delete(timeline);
        await harness.close();
      }
    },
    30_000,
  );

  it("deduplicates starts and finals separately, accepts completed-first, and deliberately cannot deduplicate no-id finals", async () => {
    const { database, run, executions } = await fixture();
    const executionId = executions[0]!.id;
    const { timeline } = capture(database);
    timeline.begin(executionId);
    for (let index = 0; index < 3; index++) observe(timeline, executionId, tool("running", "pair"));
    await timeline.flush();
    for (let index = 0; index < 3; index++) observe(timeline, executionId, tool("running", "pair"));
    for (let index = 0; index < 3; index++)
      observe(timeline, executionId, tool("completed", "pair"));
    observe(timeline, executionId, tool("completed", "final-first"));
    observe(timeline, executionId, tool("completed", "final-first"));
    observe(timeline, executionId, tool("running"));
    observe(timeline, executionId, tool("completed"));
    observe(timeline, executionId, tool("completed"));
    await timeline.flush();
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.data["callId"]]),
      [
        ["tool_started", "pair"],
        ["tool_finished", "pair"],
        ["tool_finished", "final-first"],
        ["tool_finished", undefined],
        ["tool_finished", undefined],
      ],
    );
  });

  it("durably deduplicates a sensitive call id across two events without storing it raw or collapsing distinct ids", async () => {
    const stepId = "password_step";
    const { database, run, executions } = await fixture([stepId]);
    const executionId = executions[0]!.id;
    const callIds = ["password_first", "password_second"];
    const first = capture(database).timeline;
    first.begin(executionId);
    for (const callId of callIds) observe(first, executionId, tool("completed", callId));
    await first.flush();
    await first.stop();
    captures.delete(first);
    const resumed = capture(database).timeline;
    resumed.begin(executionId);
    for (const callId of callIds) observe(resumed, executionId, tool("completed", callId));
    await resumed.flush();
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.stepId, row.data["callId"]]),
      callIds.map((callId) => [
        "tool_finished",
        stepId,
        createHash("sha256").update(callId).digest("hex").slice(0, 16),
      ]),
    );
    for (const callId of callIds) assert.equal(JSON.stringify(rows).includes(callId), false);
    assert.notEqual(rows[0]!.data["callId"], rows[1]!.data["callId"]);
  });

  it("keeps a reused call id distinct in two steps, including UTF-8 step ids shortened by the shared hash helper", async () => {
    const stepIds = ["\u4e2d".repeat(40) + "first", "\u4e2d".repeat(40) + "second"];
    const { database, run, executions } = await fixture(stepIds);
    const { timeline } = capture(database);
    for (const execution of executions) {
      timeline.begin(execution.id);
      observe(timeline, execution.id, tool("running", "reused"));
      observe(timeline, execution.id, tool("completed", "reused"));
    }
    await timeline.flush();
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.equal(rows.length, 4);
    const shortened = stepIds.map(timelineStepId);
    assert.notEqual(shortened[0], shortened[1]);
    for (const stepId of shortened) {
      assert.ok(Buffer.byteLength(stepId) <= 64);
      assert.equal(stepId.includes("\ufffd"), false);
      assert.deepEqual(
        rows.filter((row) => row.stepId === stepId).map((row) => row.kind),
        ["tool_started", "tool_finished"],
      );
    }
  });

  it("resumes on the same database without duplicating older calls or agent start after more than 200 later rows", async () => {
    const { database, run, executions } = await fixture();
    const executionId = executions[0]!.id;
    const first = capture(database).timeline;
    first.begin(executionId);
    const started: DaemonAgentStreamEvent = {
      type: "thread_started",
      provider: "claude",
      sessionId: "shared",
    };
    observe(first, executionId, started);
    observe(first, executionId, tool("running", "old"));
    observe(first, executionId, tool("completed", "old"));
    await first.flush();
    for (let batch = 0; batch < 3; batch++) {
      for (let index = 0; index < 80; index++)
        observe(first, executionId, { type: "turn_started", provider: "claude" });
      await first.flush();
    }
    const before = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.equal(before.length, 243);
    await first.stop();
    const second = capture(database).timeline;
    second.begin(executionId);
    observe(second, executionId, started);
    observe(second, executionId, tool("running", "old"));
    observe(second, executionId, tool("completed", "old"));
    observe(second, executionId, tool("completed", "new"));
    await second.flush();
    const after = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.length, 244);
    assert.equal(after.at(-1)?.data["callId"], "new");
    assert.equal(after.at(-1)?.seq, 244);
  });

  it("records shared-conversation events independently for both execution associations, accepting cross-attribution", async () => {
    const { database, run, executions, createRun, link } = await fixture();
    const other = await createRun(["other-work"]);
    const otherExecutions = await link(other);
    assert.deepEqual(run.conversation, other.conversation);
    const { timeline } = capture(database);
    for (const execution of [...executions, ...otherExecutions]) {
      timeline.begin(execution.id);
      observe(timeline, execution.id, tool("completed", "conversation-call"));
      observe(timeline, execution.id, tool("completed", "conversation-call"));
    }
    await timeline.flush();
    for (const target of [run, other]) {
      const rows = await database.listRunTimelineEvents(ORGANIZATION, target.id, PAGE);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.triggerRunId, target.id);
      assert.equal(rows[0]?.data["callId"], "conversation-call");
    }
  });

  it("resolves ownership once per execution, caches unrelated ownership, and resolves again only after release", async () => {
    const { database, run, executions } = await fixture();
    const executionId = executions[0]!.id;
    const resolve = vi.spyOn(database, "resolveRunForExecution");
    const { timeline } = capture(database);
    timeline.begin(executionId);
    timeline.begin(executionId);
    for (let index = 0; index < 10; index++)
      observe(timeline, executionId, tool("completed", `call-${index}`));
    await timeline.flush();
    assert.equal(resolve.mock.calls.length, 1);
    timeline.release(executionId);
    assert.equal(timeline.activeExecutionCount(), 0);
    observe(timeline, executionId, tool("completed", "after-release"));
    timeline.begin(executionId);
    observe(timeline, executionId, tool("completed", "after-rebegin"));
    await timeline.flush();
    assert.equal(resolve.mock.calls.length, 2);
    timeline.begin("unrelated");
    await timeline.flush();
    timeline.begin("unrelated");
    observe(timeline, "unrelated", tool("completed", "unrelated"));
    await timeline.flush();
    assert.equal(resolve.mock.calls.length, 3);
    assert.equal((await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).length, 11);
  });

  it("bounds projected pending events at 200 before ownership resolves and durably accounts for the rest", async () => {
    const { database, run, executions } = await fixture();
    const executionId = executions[0]!.id;
    const release = Promise.withResolvers<void>();
    const resolve = database.resolveRunForExecution.bind(database);
    vi.spyOn(database, "resolveRunForExecution").mockImplementation(async (id) => {
      await release.promise;
      return resolve(id);
    });
    const { timeline } = capture(database);
    timeline.begin(executionId);
    const mutable = tool("completed", "projected-before-binding");
    observe(timeline, executionId, mutable);
    if (mutable.type === "timeline") mutable.item.name = "Mutated";
    for (let index = 1; index < 1_000; index++)
      observe(timeline, executionId, { type: "turn_started", provider: "claude" });
    try {
      assert.equal(timeline.depth(), 200);
      assert.equal(await database.readRunTimelineState(ORGANIZATION, run.id), undefined);
      release.resolve();
      await timeline.flush();
      const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
      assert.equal(rows.length, 201);
      assert.equal(rows[0]?.data["tool"], "Bash");
      assert.deepEqual(rows.at(-1)?.data, { dropped: 800 });
      assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount, 800);
      assert.equal(timeline.depth(), 0);
    } finally {
      release.resolve();
    }
  });

  it("shares the hinted per-run 200 cap across executions even while authoritative binding is delayed", async () => {
    const { database, run, executions, scope } = await fixture(["one", "two"]);
    const release = Promise.withResolvers<void>();
    const resolve = database.resolveRunForExecution.bind(database);
    vi.spyOn(database, "resolveRunForExecution").mockImplementation(async (id) => {
      await release.promise;
      return resolve(id);
    });
    const { timeline } = capture(database);
    for (const execution of executions) timeline.begin(execution.id, scope);
    for (let index = 0; index < 300; index++)
      observe(timeline, executions[index % 2]!.id, { type: "turn_started", provider: "claude" });
    try {
      assert.equal(timeline.depth(), 200);
      release.resolve();
      await timeline.flush();
      assert.equal((await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).length, 201);
      assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount, 100);
      assert.equal(timeline.depth(), 0);
    } finally {
      release.resolve();
    }
  });

  it("validates scope hints against persisted ownership and never writes events into the hinted foreign run", async () => {
    const { database, run, executions, scope, createRun } = await fixture();
    const other = await createRun(["other"]);
    const { timeline } = capture(database);
    timeline.begin(executions[0]!.id, { ...scope, triggerRunId: other.id });
    observe(timeline, executions[0]!.id, tool("completed", "wrong-hint"));
    await timeline.flush();
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, other.id, PAGE), []);
    assert.equal(timeline.depth(), 0);
  });

  it("never throws append failures into the tap and lets a retransmitted call and future events recover", async () => {
    const { database, run, executions } = await fixture();
    const executionId = executions[0]!.id;
    const append = database.appendRunTimelineEvent.bind(database);
    const failure = new Error("Backend unavailable");
    const writes = vi.spyOn(database, "appendRunTimelineEvent").mockRejectedValue(failure);
    const { timeline, reportFailure } = capture(database);
    timeline.begin(executionId);
    assert.doesNotThrow(() => observe(timeline, executionId, tool("completed", "retry")));
    await timeline.flush();
    assert.equal(reportFailure.mock.calls.length, 1);
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
    writes.mockImplementation(append);
    assert.doesNotThrow(() => observe(timeline, executionId, tool("completed", "retry")));
    observe(timeline, executionId, tool("completed", "future"));
    await timeline.flush();
    assert.deepEqual(
      (await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).map(
        (row) => row.data["callId"],
      ),
      ["retry", "future"],
    );
    assert.equal(timeline.depth(), 0);
  });

  it("drains on stop, releases execution maps, refuses new capture and leaves no deadline timers", async () => {
    const { database, run, executions, scope } = await fixture();
    const executionId = executions[0]!.id;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { timeline } = capture(database);
    timeline.begin(executionId, scope);
    observe(timeline, executionId, tool("completed", "before-stop"));
    const stopping = timeline.stop();
    timeline.begin("after-stop", scope);
    observe(timeline, executionId, tool("completed", "during-stop"));
    await stopping;
    assert.equal(timeline.activeExecutionCount(), 0);
    assert.equal(timeline.depth(), 0);
    timeline.begin(executionId, scope);
    observe(timeline, executionId, tool("completed", "after-stop"));
    await assert.rejects(
      timeline.run(scope, async () => undefined),
      /closed/,
    );
    await timeline.flush();
    assert.deepEqual(
      (await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).map(
        (row) => row.data["callId"],
      ),
      ["before-stop"],
    );
    assert.equal(vi.getTimerCount(), 0);
  });

  it("bounds flush while ownership hangs and never starts a late write after the deadline", async () => {
    const { database, run, executions } = await fixture();
    const release = Promise.withResolvers<void>();
    const resolve = database.resolveRunForExecution.bind(database);
    vi.spyOn(database, "resolveRunForExecution").mockImplementation(async (id) => {
      await release.promise;
      return resolve(id);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { timeline } = capture(database);
    timeline.begin(executions[0]!.id);
    observe(timeline, executions[0]!.id, tool("completed", "late"));
    try {
      const completed = vi.fn();
      const flushing = timeline.flush().then(completed);
      await vi.advanceTimersByTimeAsync(1_999);
      assert.equal(completed.mock.calls.length, 0);
      await vi.advanceTimersByTimeAsync(1);
      await flushing;
      assert.equal(timeline.depth(), 0);
      release.resolve();
      await timeline.flush();
      await timeline.stop();
      assert.equal(timeline.activeExecutionCount(), 0);
      assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      release.resolve();
    }
  });
});
