import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { JsonValue } from "../config/compiler.js";
import { jsonbBytes, jsonbText } from "../run-timeline/data.js";
import type {
  AppendRunTimelineEventInput,
  RunTimelineEvent,
  RunTimelineStore,
} from "../run-timeline/store.js";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "./runtime/index.js";
import type { Database } from "./types.js";

const ORGANIZATION = "timeline-organization";
const FOREIGN_ORGANIZATION = "other-organization";
const EVENT_AT = new Date("2026-01-01T00:00:00.000Z");
const PAGE = { afterSeq: 0, limit: 5110 };
const CONFIGURATION = { environments: [], triggers: [] };

type Store = Database & RunTimelineStore;

interface Harness {
  database: Store;
  projectId: string;
  runtime?: DatabaseRuntime;
  reopen: () => Store;
  close: () => Promise<void>;
}

async function memoryHarness(): Promise<Harness> {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION, FOREIGN_ORGANIZATION] });
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Timeline contracts",
    slug: "timeline-contracts",
    createdByUserId: null,
  });
  return { database, projectId: project.id, reopen: () => database, close: async () => undefined };
}

async function embeddedHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "hub-timeline-contract-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
  try {
    await runtime.migrate();
    await runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Timeline', 'timeline'), ($2, 'Other', 'other')",
      [ORGANIZATION, FOREIGN_ORGANIZATION],
    );
    const database = createDatabase(runtime, locks);
    const project = await database.createProject({
      organizationId: ORGANIZATION,
      name: "Timeline contracts",
      slug: "timeline-contracts",
      createdByUserId: null,
    });
    return {
      database,
      projectId: project.id,
      runtime,
      reopen: () => createDatabase(runtime, locks),
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

async function acceptedRun(harness: Harness, stepIds = ["work"]) {
  const { database, projectId } = harness;
  const revision = await database.insertProjectConfigurationRevision({
    projectId,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: CONFIGURATION,
    contentHash: "timeline-contract-configuration",
  });
  await database.activateProjectConfigurationRevision(projectId, revision.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: ORGANIZATION,
    projectId,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: new Date(),
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") throw new Error("manual receipt was not accepted");
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: ORGANIZATION,
    projectId,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: "timeline",
    prompt: "",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date(Date.now() + 3_600_000),
    stepIds,
  });
  return run;
}

function event(
  triggerRunId: string,
  patch: Partial<AppendRunTimelineEventInput> = {},
): AppendRunTimelineEventInput {
  return {
    triggerRunId,
    organizationId: ORGANIZATION,
    kind: "turn_started",
    at: EVENT_AT,
    data: {},
    origin: "captured",
    ...patch,
  };
}

function bytes(rows: RunTimelineEvent[]): number {
  return rows.reduce((total, row) => total + jsonbBytes(row.data), 0);
}

function fakeProvider() {
  let body: string | undefined;
  const requests: { body: string; land: () => void }[] = [];
  return {
    get body() {
      return body;
    },
    requests,
    send(value: string) {
      const request = {
        body: value,
        land: () => {
          body = value;
        },
      };
      requests.push(request);
      return request;
    },
  };
}

const backends = [
  ["memory", memoryHarness],
  ["embedded PostgreSQL", embeddedHarness],
] as const;

describe.each(backends)("run timeline contract (%s)", (_name, open) => {
  let harness: Harness;
  let database: Store;

  beforeAll(async () => {
    harness = await open();
    database = harness.database;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it("leaves a normally finished run without a timeline or progress message", async () => {
    const run = await acceptedRun(harness);
    const completed = await database.succeedTriggerRun(run.id);
    assert.equal(completed?.run.status, "succeeded");
    assert.equal(await database.readRunTimelineState(ORGANIZATION, run.id), undefined);
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
    assert.equal(await database.findRunProgressMessage(ORGANIZATION, run.id), undefined);
  });

  it("assigns contiguous concurrent sequences and persists counters across store handles", async () => {
    const run = await acceptedRun(harness);
    const inputs = Array.from({ length: 64 }, (_, index) =>
      event(run.id, {
        kind: "turn_failed",
        data: { error: `failure-${index}` },
      }),
    );
    const results = await Promise.all(
      inputs.map((input, index) =>
        (index % 2 === 0 ? database : harness.reopen()).appendRunTimelineEvent(input),
      ),
    );
    assert.ok(
      results.every((result) => result !== undefined && "seq" in result && result.inserted),
    );
    assert.deepEqual(
      results.map((result) => (result && "seq" in result ? result.seq : -1)).sort((a, b) => a - b),
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
    const reopened = harness.reopen();
    const rows = await reopened.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(
      rows.map((row) => row.seq),
      Array.from({ length: 64 }, (_, index) => index + 1),
    );
    assert.equal(new Set(rows.map((row) => row.data["error"])).size, 64);
    const state = await reopened.readRunTimelineState(ORGANIZATION, run.id);
    assert.equal(state?.eventCount, 64);
    assert.equal(state?.byteCount, bytes(rows));
    assert.equal(state?.stepEndCount, 0);
    assert.equal(state?.droppedCount, 0);
    assert.deepEqual(await reopened.appendRunTimelineEvent(event(run.id)), {
      seq: 65,
      inserted: true,
    });
    assert.deepEqual(
      (await reopened.listRunTimelineEvents(ORGANIZATION, run.id, { afterSeq: 62, limit: 2 })).map(
        (row) => row.seq,
      ),
      [63, 64],
    );
  });

  it("deduplicates every lifecycle key without consuming a sequence or budget", async () => {
    const run = await acceptedRun(harness);
    const inputs = [
      event(run.id, { kind: "run_started", data: { trigger: "timeline", steps: 1 } }),
      event(run.id, { kind: "step_started", stepId: "work", data: { type: "agent" } }),
      event(run.id, { kind: "agent_started", stepId: "work", data: { provider: "claude" } }),
      event(run.id, {
        kind: "step_finished",
        stepId: "work",
        data: { status: "succeeded", durationMs: 1 },
      }),
    ];
    for (const input of inputs) {
      const first = await database.appendRunTimelineEvent(input);
      const before = await database.readRunTimelineState(ORGANIZATION, run.id);
      assert.ok(first && "seq" in first && first.inserted);
      assert.deepEqual(await harness.reopen().appendRunTimelineEvent(input), {
        seq: first.seq,
        inserted: false,
      });
      assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), before);
    }
    const finish = event(run.id, {
      kind: "run_finished",
      data: { status: "succeeded", durationMs: 1 },
    });
    const first = await database.appendRunTimelineEvent(finish);
    assert.ok(first && "seq" in first && first.inserted);
    const sealed = await database.readRunTimelineState(ORGANIZATION, run.id);
    await database.appendRunTimelineEvent(finish);
    assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), sealed);
    assert.equal((await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).length, 5);
  });

  it("deduplicates call ids across more than 200 later writes but not across steps or kinds", async () => {
    const run = await acceptedRun(harness, ["first", "second"]);
    const call = event(run.id, {
      kind: "tool_started",
      stepId: "first",
      data: { callId: "call", tool: "read", category: "read" },
    });
    assert.deepEqual(await database.appendRunTimelineEvent(call), { seq: 1, inserted: true });
    for (let index = 0; index < 230; index++) await database.appendRunTimelineEvent(event(run.id));
    const before = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.deepEqual(await harness.reopen().appendRunTimelineEvent(call), {
      seq: 1,
      inserted: false,
    });
    assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), before);
    assert.deepEqual(await database.appendRunTimelineEvent({ ...call, stepId: "second" }), {
      seq: 232,
      inserted: true,
    });
    assert.deepEqual(
      await database.appendRunTimelineEvent({
        ...call,
        kind: "tool_finished",
        data: { ...call.data, status: "completed" },
      }),
      { seq: 233, inserted: true },
    );
    const withoutId = {
      ...call,
      kind: "tool_finished" as const,
      data: { tool: "read", category: "read", status: "completed" },
    };
    await database.appendRunTimelineEvent(withoutId);
    await database.appendRunTimelineEvent(withoutId);
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.eventCount, 235);
  });

  it("normalizes long multibyte step keys consistently for durable dedupe", async () => {
    const run = await acceptedRun(harness);
    const stepId = "\u754c".repeat(80);
    const input = event(run.id, { kind: "step_started", stepId, data: { type: "agent" } });
    assert.deepEqual(await database.appendRunTimelineEvent(input), { seq: 1, inserted: true });
    assert.deepEqual(await harness.reopen().appendRunTimelineEvent(input), {
      seq: 1,
      inserted: false,
    });
    const [row] = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.ok(row);
    assert.ok(Buffer.byteLength(row.stepId, "utf8") <= 64);
    assert.ok(!row.stepId.includes("\ufffd"));
    const other = await database.appendRunTimelineEvent({ ...input, stepId: `${stepId}x` });
    assert.ok(other && "seq" in other && other.inserted);
  });

  it("reserves notice and terminal classes when the ordinary count cap is reached", async () => {
    const run = await acceptedRun(harness);
    for (let index = 0; index < 50; index++) {
      const result = await database.appendRunTimelineEvent(event(run.id, { maxEvents: 50 }));
      assert.ok(result && "seq" in result && result.inserted);
    }
    for (let index = 0; index < 3; index++) {
      assert.deepEqual(await database.appendRunTimelineEvent(event(run.id, { maxEvents: 50 })), {
        reason: "cap",
      });
    }
    await database.appendRunTimelineEvent(
      event(run.id, {
        kind: "step_finished",
        stepId: "work",
        maxEvents: 50,
        data: { status: "succeeded" },
      }),
    );
    await database.appendRunTimelineEvent(
      event(run.id, { kind: "run_finished", maxEvents: 50, data: { status: "succeeded" } }),
    );
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(
      rows.map((row) => row.kind),
      [
        ...Array.from({ length: 50 }, () => "turn_started"),
        "truncated",
        "step_finished",
        "run_finished",
      ],
    );
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.equal(state?.droppedCount, 3);
    assert.equal(state?.byteCount, 100);
    assert.equal(state?.stepEndCount, 1);
    assert.equal(state?.stepEndBytes, bytes(rows.filter((row) => row.kind === "step_finished")));
    assert.equal(state?.sealedSeq, 53);
    assert.equal(state?.eventCount, 53);
    assert.ok(jsonbBytes(rows[50]!.data) <= 128);
    assert.ok(jsonbBytes(rows[52]!.data) <= 512);
  });

  it("enforces the ordinary row byte bound before storage", async () => {
    const run = await acceptedRun(harness);
    const result = await database.appendRunTimelineEvent(
      event(run.id, {
        kind: "turn_failed",
        data: { error: '"\\\u00e9\u754c'.repeat(2000) },
      }),
    );
    assert.ok(result && "seq" in result && result.inserted);
    const [row] = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.ok(row);
    assert.ok(jsonbBytes(row.data) <= 1024);
    assert.equal(
      (await database.readRunTimelineState(ORGANIZATION, run.id))?.byteCount,
      jsonbBytes(row.data),
    );
  });

  it("bounds all four classes while retaining 100 of 150 persisted terminal steps", async () => {
    const stepIds = Array.from({ length: 150 }, (_, index) => `step-${index}`);
    const run = await acceptedRun(harness, stepIds);
    const failure = '"\\\u00e9\u754c'.repeat(120);
    let capped = false;
    for (let index = 0; index < 1200; index++) {
      const result = await database.appendRunTimelineEvent(
        event(run.id, {
          kind: "turn_failed",
          data: { error: '"'.repeat(240) },
          maxEvents: 5000,
        }),
      );
      if (result && "reason" in result && result.reason === "cap") {
        capped = true;
        break;
      }
    }
    assert.equal(capped, true);
    for (const stepId of stepIds) {
      const persisted = await database.markWorkflowStepSkipped(run.id, stepId, failure);
      assert.equal(persisted?.stepRun.status, "skipped");
    }
    for (const stepId of stepIds) {
      await database.appendRunTimelineEvent(
        event(run.id, {
          kind: "step_finished",
          stepId,
          maxEvents: 5000,
          data: {
            status: "skipped",
            durationMs: Number.MAX_SAFE_INTEGER,
            exitCode: 255,
            completion: "inferred_from_turn_end",
            failure,
          },
        }),
      );
    }
    await database.succeedTriggerRun(run.id);
    await database.appendRunTimelineEvent(
      event(run.id, {
        kind: "run_finished",
        maxEvents: 5000,
        data: {
          status: "succeeded",
          durationMs: Number.MAX_SAFE_INTEGER,
          failure,
          steps: { succeeded: 0, failed: 0, timed_out: 0, skipped: 150, not_run: 0, total: 150 },
          stepRowsOmitted: 50,
        },
      }),
    );
    const rows = await harness.reopen().listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    const ordinary = rows.filter(
      (row) => !["step_finished", "run_finished", "truncated"].includes(row.kind),
    );
    const ends = rows.filter((row) => row.kind === "step_finished");
    const finishes = rows.filter((row) => row.kind === "run_finished");
    const notices = rows.filter((row) => row.kind === "truncated");
    assert.equal(ends.length, 100);
    assert.equal(finishes.length, 1);
    assert.equal(notices.length, 1);
    assert.ok(ordinary.length < 5000);
    assert.ok(bytes(ordinary) <= 196_608);
    assert.ok(196_608 - bytes(ordinary) < jsonbBytes(ordinary[0]!.data));
    assert.ok(bytes(ends) <= 51_200);
    for (const row of rows) {
      let limit = 1024;
      if (row.kind === "truncated") limit = 128;
      else if (row.kind === "step_finished" || row.kind === "run_finished") limit = 512;
      assert.ok(jsonbBytes(row.data) <= limit, `${row.kind} exceeds its row limit`);
    }
    assert.ok(bytes(rows) <= 248_448);
    const state = await harness.reopen().readRunTimelineState(ORGANIZATION, run.id);
    assert.equal(state?.byteCount, bytes(ordinary));
    assert.equal(state?.stepEndBytes, bytes(ends));
    assert.equal(state?.stepEndCount, 100);
    assert.equal(state?.stepRowsOmitted, 50);
    assert.equal(state?.sealedSeq, rows.at(-1)?.seq);
    assert.ok(state?.sealedAt instanceof Date);
    assert.equal(state?.eventCount, rows.length);
    assert.deepEqual(finishes[0]!.data["steps"], {
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      skipped: 150,
      not_run: 0,
      total: 150,
    });
    assert.equal(finishes[0]!.data["stepRowsOmitted"], 50);
    assert.equal(
      (await database.listWorkflowStepRunsForTriggerRun(run.id)).filter(
        (step) => step.status === "skipped",
      ).length,
      150,
    );
  }, 120_000);

  it("keeps the first origin immutable and atomically seals against later appends", async () => {
    for (const origin of ["captured", "derived"] as const) {
      const run = await acceptedRun(harness);
      await database.appendRunTimelineEvent(event(run.id, { origin }));
      await harness
        .reopen()
        .appendRunTimelineEvent(
          event(run.id, { origin: origin === "captured" ? "derived" : "captured" }),
        );
      assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.origin, origin);
      const finish = await database.appendRunTimelineEvent(
        event(run.id, { kind: "run_finished", data: { status: "succeeded" } }),
      );
      assert.ok(finish && "seq" in finish && finish.inserted);
      const state = await database.readRunTimelineState(ORGANIZATION, run.id);
      assert.equal(state?.sealedSeq, finish.seq);
      assert.ok(state?.sealedAt instanceof Date);
      const droppedBefore = state.droppedCount;
      assert.deepEqual(await database.appendRunTimelineEvent(event(run.id)), { reason: "sealed" });
      const afterOrdinary = await database.readRunTimelineState(ORGANIZATION, run.id);
      assert.equal(afterOrdinary?.droppedCount, droppedBefore + 1);
      assert.deepEqual(
        await database.appendRunTimelineEvent(
          event(run.id, { kind: "step_finished", stepId: "late", data: { status: "failed" } }),
        ),
        { reason: "sealed" },
      );
      assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), afterOrdinary);
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, run.id))?.eventCount,
        finish.seq,
      );
      assert.equal(
        (await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).at(-1)?.kind,
        "run_finished",
      );
    }
  });

  it("filters every organization-scoped read and mutation", async () => {
    const run = await acceptedRun(harness);
    await database.appendRunTimelineEvent(event(run.id));
    await database.insertRunProgressMessageIfAbsent({
      triggerRunId: run.id,
      organizationId: ORGANIZATION,
      provider: "github",
      now: EVENT_AT,
    });
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    const message = await database.findRunProgressMessage(ORGANIZATION, run.id);
    assert.ok(await database.findTriggerRunForOrganization(ORGANIZATION, run.id));
    for (const id of [run.id, randomUUID()]) {
      assert.equal(
        await database.findTriggerRunForOrganization(FOREIGN_ORGANIZATION, id),
        undefined,
      );
      assert.equal(await database.readRunTimelineState(FOREIGN_ORGANIZATION, id), undefined);
      assert.deepEqual(await database.listRunTimelineEvents(FOREIGN_ORGANIZATION, id, PAGE), []);
      assert.equal(await database.findRunProgressMessage(FOREIGN_ORGANIZATION, id), undefined);
      assert.equal(
        await database.appendRunTimelineEvent(event(id, { organizationId: FOREIGN_ORGANIZATION })),
        undefined,
      );
      assert.equal(
        await database.insertRunProgressMessageIfAbsent({
          triggerRunId: id,
          organizationId: FOREIGN_ORGANIZATION,
          provider: "slack",
          now: EVENT_AT,
        }),
        undefined,
      );
      assert.equal(
        await database.acquireRunProgressLease({
          triggerRunId: id,
          organizationId: FOREIGN_ORGANIZATION,
          owner: "intruder",
          now: EVENT_AT,
        }),
        undefined,
      );
      assert.equal(
        await database.updateRunProgressMessage({
          triggerRunId: id,
          organizationId: FOREIGN_ORGANIZATION,
          owner: "intruder",
          now: EVENT_AT,
          version: 0,
          patch: { state: "gone" },
        }),
        undefined,
      );
      assert.equal(await database.requestCompensation(FOREIGN_ORGANIZATION, id), undefined);
      await database.completeCompensation(FOREIGN_ORGANIZATION, id, 99);
    }
    assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), state);
    assert.deepEqual(await database.findRunProgressMessage(ORGANIZATION, run.id), message);
  });

  it("resolves persisted execution ownership and excludes unrelated executions", async () => {
    const run = await acceptedRun(harness, ["linked"]);
    const [step] = await database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.ok(step);
    const input = {
      organizationId: ORGANIZATION,
      projectId: harness.projectId,
      machineId: null,
      configurationRevisionId: run.configurationRevisionId,
      triggerContext: {},
      outputContext: {},
    };
    const linked = await database.insertAgentExecution({ ...input, workflowStepRunId: step.id });
    await database.linkWorkflowStepRunExecution(step.id, linked.id);
    const unrelated = await database.insertAgentExecution(input);
    assert.deepEqual(await database.resolveRunForExecution(linked.id), {
      triggerRunId: run.id,
      organizationId: ORGANIZATION,
      stepId: "linked",
    });
    assert.equal(await database.resolveRunForExecution(unrelated.id), undefined);
    assert.equal(await database.resolveRunForExecution(randomUUID()), undefined);
  });

  it("preserves immutable progress identity under duplicate and concurrent insertion", async () => {
    const run = await acceptedRun(harness);
    const input = {
      triggerRunId: run.id,
      organizationId: ORGANIZATION,
      provider: "github" as const,
      now: EVENT_AT,
    };
    const initial = await database.insertRunProgressMessageIfAbsent(input);
    assert.ok(initial);
    assert.equal(initial.state, "pending");
    assert.equal(initial.version, 0);
    assert.equal(initial.compensationRequestedGen, 0);
    assert.equal(initial.compensationDoneGen, 0);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.reopen().insertRunProgressMessageIfAbsent({
          ...input,
          provider: "slack",
          now: new Date(EVENT_AT.getTime() + 1000),
        }),
      ),
    );
    for (const result of results) assert.deepEqual(result, initial);
    assert.deepEqual(await database.findRunProgressMessage(ORGANIZATION, run.id), initial);
    assert.equal(
      await database.insertRunProgressMessageIfAbsent({
        ...input,
        organizationId: FOREIGN_ORGANIZATION,
      }),
      undefined,
    );
    assert.deepEqual(await database.findRunProgressMessage(ORGANIZATION, run.id), initial);
  });

  it("requires a live matching owner and version for updates and permits takeover at expiry", async () => {
    const run = await acceptedRun(harness);
    const input = { triggerRunId: run.id, organizationId: ORGANIZATION, now: EVENT_AT };
    await database.insertRunProgressMessageIfAbsent({ ...input, provider: "github" });
    const lease = await database.acquireRunProgressLease({ ...input, owner: "first" });
    assert.ok(lease);
    assert.equal(lease.version, 1);
    assert.equal(lease.leaseExpiresAt?.getTime(), EVENT_AT.getTime() + 60_000);
    assert.equal(await database.acquireRunProgressLease({ ...input, owner: "second" }), undefined);
    assert.equal(
      await database.updateRunProgressMessage({
        ...input,
        owner: "second",
        version: lease.version,
        patch: { state: "active" },
      }),
      undefined,
    );
    assert.equal(
      await database.updateRunProgressMessage({
        ...input,
        owner: "first",
        version: lease.version - 1,
        patch: { state: "active" },
      }),
      undefined,
    );
    const renewed = await database.acquireRunProgressLease({
      ...input,
      owner: "first",
      now: new Date(EVENT_AT.getTime() + 1000),
    });
    assert.ok(renewed);
    assert.ok(renewed.version > lease.version);
    assert.equal(
      await database.updateRunProgressMessage({
        ...input,
        owner: "first",
        version: lease.version,
        patch: { state: "gone" },
      }),
      undefined,
    );
    const expiredNow = new Date(renewed.leaseExpiresAt!.getTime());
    assert.equal(
      await database.updateRunProgressMessage({
        ...input,
        now: expiredNow,
        owner: "first",
        version: renewed.version,
        patch: { state: "gone" },
      }),
      undefined,
    );
    const takeover = await harness
      .reopen()
      .acquireRunProgressLease({ ...input, now: expiredNow, owner: "second" });
    assert.ok(takeover);
    assert.ok(takeover.version > renewed.version);
    assert.equal(
      await database.updateRunProgressMessage({
        ...input,
        now: expiredNow,
        owner: "first",
        version: renewed.version,
        patch: { state: "gone" },
      }),
      undefined,
    );
    const updated = await database.updateRunProgressMessage({
      ...input,
      now: expiredNow,
      owner: "second",
      version: takeover.version,
      releaseLease: true,
      patch: { state: "active", externalRef: { commentId: "comment" }, editCount: 1 },
    });
    assert.equal(updated?.state, "active");
    assert.equal(updated?.leaseOwner, null);
    assert.equal(updated?.leaseExpiresAt, null);
    assert.equal((await database.findRunProgressMessage(ORGANIZATION, run.id))?.editCount, 1);
  });

  it("retains a newer repair request when a compensator completes an older generation", async () => {
    const run = await acceptedRun(harness);
    const provider = fakeProvider();
    const input = { triggerRunId: run.id, organizationId: ORGANIZATION, now: EVENT_AT };
    await database.insertRunProgressMessageIfAbsent({ ...input, provider: "github" });
    const older = await database.acquireRunProgressLease({ ...input, owner: "older" });
    assert.ok(older);
    const staleRequest = provider.send("running");
    const now = new Date(EVENT_AT.getTime() + 60_001);
    const finalLease = await database.acquireRunProgressLease({ ...input, now, owner: "final" });
    assert.ok(finalLease);
    provider.send("finished").land();
    assert.ok(
      await database.updateRunProgressMessage({
        ...input,
        now,
        owner: "final",
        version: finalLease.version,
        releaseLease: true,
        patch: {
          state: "finished",
          externalRef: { commentId: "comment" },
          lastRenderedHash: "final",
        },
      }),
    );
    await database.succeedTriggerRun(run.id);
    assert.equal(await database.requestCompensation(ORGANIZATION, run.id), 1);
    const compensator = await database.acquireRunProgressLease({
      ...input,
      now,
      owner: "compensator",
    });
    assert.ok(compensator);
    const rechecked = await database.findRunProgressMessage(ORGANIZATION, run.id);
    assert.equal(rechecked?.leaseOwner, "compensator");
    assert.equal(rechecked?.version, compensator.version);
    const observedGen = rechecked.compensationRequestedGen;
    assert.equal(observedGen, 1);
    provider.send("finished").land();
    assert.equal(provider.body, "finished");
    staleRequest.land();
    assert.equal(provider.body, "running");
    assert.equal(
      await database.updateRunProgressMessage({
        ...input,
        now,
        owner: "older",
        version: older.version,
        releaseLease: true,
        patch: { state: "active", lastRenderedHash: "stale" },
      }),
      undefined,
    );
    assert.equal(await database.requestCompensation(ORGANIZATION, run.id), 2);
    const during = await database.findRunProgressMessage(ORGANIZATION, run.id);
    assert.equal(during?.leaseOwner, "compensator");
    assert.equal(during?.version, compensator.version);
    assert.ok(
      await database.updateRunProgressMessage({
        ...input,
        now,
        owner: "compensator",
        version: compensator.version,
        releaseLease: true,
        patch: { state: "finished", lastRenderedHash: "final" },
      }),
    );
    await database.completeCompensation(ORGANIZATION, run.id, observedGen);
    const pending = await database.findRunProgressMessage(ORGANIZATION, run.id);
    assert.equal(pending?.compensationRequestedGen, 2);
    assert.equal(pending?.compensationDoneGen, 1);
    assert.ok(
      (await database.listRunProgressMessagesToFinish(now, 1000)).some(
        (row) => row.triggerRunId === run.id,
      ),
    );
    const repair = await database.acquireRunProgressLease({ ...input, now, owner: "repair" });
    assert.ok(repair);
    const repairObservedGen = (await database.findRunProgressMessage(ORGANIZATION, run.id))!
      .compensationRequestedGen;
    provider.send("finished").land();
    assert.ok(
      await database.updateRunProgressMessage({
        ...input,
        now,
        owner: "repair",
        version: repair.version,
        releaseLease: true,
        patch: { state: "finished", lastRenderedHash: "final" },
      }),
    );
    await database.completeCompensation(ORGANIZATION, run.id, repairObservedGen);
    assert.equal(provider.body, "finished");
    assert.deepEqual(
      provider.requests.map((request) => request.body),
      ["running", "finished", "finished", "finished"],
    );
    assert.equal(
      (await database.findRunProgressMessage(ORGANIZATION, run.id))?.compensationDoneGen,
      2,
    );
    await database.completeCompensation(ORGANIZATION, run.id, 1);
    assert.equal(
      (await database.findRunProgressMessage(ORGANIZATION, run.id))?.compensationDoneGen,
      2,
    );
    const generations = await Promise.all([
      database.requestCompensation(ORGANIZATION, run.id),
      harness.reopen().requestCompensation(ORGANIZATION, run.id),
    ]);
    assert.deepEqual(
      generations.sort((left, right) => left! - right!),
      [3, 4],
    );
    assert.equal(
      (await database.findRunProgressMessage(ORGANIZATION, run.id))?.compensationRequestedGen,
      4,
    );
  });

  it("lists expired creating and active leases without exposing live leases or premature repairs", async () => {
    const ids: string[] = [];
    for (const state of ["creating", "active"] as const) {
      const run = await acceptedRun(harness);
      ids.push(run.id);
      const input = {
        triggerRunId: run.id,
        organizationId: ORGANIZATION,
        now: EVENT_AT,
        owner: `owner-${state}`,
      };
      await database.insertRunProgressMessageIfAbsent({ ...input, provider: "github" });
      const lease = await database.acquireRunProgressLease(input);
      assert.ok(lease);
      assert.ok(
        await database.updateRunProgressMessage({
          ...input,
          version: lease.version,
          releaseLease: false,
          patch: { state, externalRef: state === "active" ? { commentId: "comment" } : null },
        }),
      );
    }
    const beforeExpiry = await database.listRunProgressMessagesToFinish(
      new Date(EVENT_AT.getTime() + 59_999),
      1000,
    );
    for (const id of ids) assert.ok(!beforeExpiry.some((row) => row.triggerRunId === id));
    const afterExpiry = await database.listRunProgressMessagesToFinish(
      new Date(EVENT_AT.getTime() + 60_000),
      1000,
    );
    for (const id of ids) assert.ok(afterExpiry.some((row) => row.triggerRunId === id));
    const run = await acceptedRun(harness);
    const input = {
      triggerRunId: run.id,
      organizationId: ORGANIZATION,
      now: EVENT_AT,
      owner: "settle",
    };
    await database.insertRunProgressMessageIfAbsent({ ...input, provider: "github" });
    const lease = await database.acquireRunProgressLease(input);
    assert.ok(lease);
    await database.updateRunProgressMessage({
      ...input,
      version: lease.version,
      releaseLease: true,
      patch: { state: "finished", externalRef: { commentId: "comment" } },
    });
    const notBefore = new Date(EVENT_AT.getTime() + 120_000);
    await database.requestCompensation(ORGANIZATION, run.id, notBefore);
    assert.ok(
      !(
        await database.listRunProgressMessagesToFinish(new Date(notBefore.getTime() - 1), 1000)
      ).some((row) => row.triggerRunId === run.id),
    );
    assert.ok(
      (await database.listRunProgressMessagesToFinish(notBefore, 1000)).some(
        (row) => row.triggerRunId === run.id,
      ),
    );
  });

  it("expires strictly before the completion cutoff in batches and leaves permanent tombstones", async () => {
    const isolated = await open();
    const store = isolated.database;
    try {
      const oldRuns = [];
      for (let index = 0; index < 2; index++) {
        const run = await acceptedRun(isolated);
        oldRuns.push(run);
        await store.appendRunTimelineEvent(event(run.id));
        await store.insertRunProgressMessageIfAbsent({
          triggerRunId: run.id,
          organizationId: ORGANIZATION,
          provider: "github",
          now: EVENT_AT,
        });
        await store.failWorkflowRun(run.id, "failed", "failed");
      }
      const withoutTimeline = await acceptedRun(isolated);
      await store.failWorkflowRun(withoutTimeline.id, "failed", "failed");
      await delay(5);
      const boundary = await acceptedRun(isolated);
      await store.appendRunTimelineEvent(event(boundary.id, { at: new Date(0) }));
      const completed = await store.failWorkflowRun(boundary.id, "failed", "failed");
      assert.ok(completed?.run.completedAt);
      const cutoff = completed.run.completedAt;
      const running = await acceptedRun(isolated);
      await store.appendRunTimelineEvent(event(running.id, { at: new Date(0) }));
      const sealed = await acceptedRun(isolated);
      await store.failWorkflowRun(sealed.id, "failed", "failed");
      await store.appendRunTimelineEvent(
        event(sealed.id, { kind: "run_finished", data: { status: "failed" } }),
      );
      assert.equal(await store.expireRunTimelines(cutoff, 1), 1);
      assert.equal(await store.expireRunTimelines(cutoff, 1), 1);
      assert.equal(await store.expireRunTimelines(cutoff, 1), 0);
      for (const run of oldRuns) {
        const state = await store.readRunTimelineState(ORGANIZATION, run.id);
        assert.ok(state?.expiredAt instanceof Date);
        assert.equal(state?.origin, "captured");
        assert.deepEqual(await store.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
        assert.equal(await store.findRunProgressMessage(ORGANIZATION, run.id), undefined);
        assert.deepEqual(
          await isolated.reopen().appendRunTimelineEvent(event(run.id, { origin: "derived" })),
          { reason: "expired" },
        );
        assert.deepEqual(await store.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
      }
      assert.equal(await store.readRunTimelineState(ORGANIZATION, withoutTimeline.id), undefined);
      assert.equal((await store.readRunTimelineState(ORGANIZATION, boundary.id))?.expiredAt, null);
      assert.equal((await store.readRunTimelineState(ORGANIZATION, running.id))?.expiredAt, null);
      const eligible = await store.listUnsealedTerminalRuns(
        new Date(cutoff.getTime() + 1000),
        cutoff,
        100,
      );
      assert.ok(eligible.some((run) => run.id === boundary.id));
      assert.ok(!eligible.some((run) => run.id === running.id || run.id === sealed.id));
      const tooRecent = await store.listUnsealedTerminalRuns(cutoff, cutoff, 100);
      assert.ok(!tooRecent.some((run) => run.id === boundary.id));
      for (const old of oldRuns) assert.ok(!eligible.some((run) => run.id === old.id));
      const widerWindow = await store.listUnsealedTerminalRuns(
        new Date(cutoff.getTime() + 1000),
        new Date(0),
        100,
      );
      for (const old of oldRuns) assert.ok(!widerWindow.some((run) => run.id === old.id));
      assert.ok(widerWindow.some((run) => run.id === withoutTimeline.id));
      assert.deepEqual(
        await store.appendRunTimelineEvent(
          event(oldRuns[0]!.id, {
            kind: "run_finished",
            origin: "derived",
            data: { status: "failed" },
          }),
        ),
        { reason: "expired" },
      );
    } finally {
      await isolated.close();
    }
  }, 120_000);

  it("expires progress-only rows without creating tombstones or touching the cutoff and live runs", async () => {
    const isolated = await open();
    const store = isolated.database;
    try {
      const old = await acceptedRun(isolated);
      await store.insertRunProgressMessageIfAbsent({
        triggerRunId: old.id,
        organizationId: ORGANIZATION,
        provider: "github",
        now: EVENT_AT,
      });
      await store.failWorkflowRun(old.id, "failed", "failed");
      await delay(5);
      const boundary = await acceptedRun(isolated);
      await store.insertRunProgressMessageIfAbsent({
        triggerRunId: boundary.id,
        organizationId: ORGANIZATION,
        provider: "github",
        now: EVENT_AT,
      });
      const completed = await store.failWorkflowRun(boundary.id, "failed", "failed");
      assert.ok(completed?.run.completedAt);
      const running = await acceptedRun(isolated);
      await store.insertRunProgressMessageIfAbsent({
        triggerRunId: running.id,
        organizationId: ORGANIZATION,
        provider: "github",
        now: EVENT_AT,
      });
      assert.equal(await store.expireRunTimelines(completed.run.completedAt, 500), 1);
      assert.equal(await store.findRunProgressMessage(ORGANIZATION, old.id), undefined);
      assert.equal(await store.readRunTimelineState(ORGANIZATION, old.id), undefined);
      assert.ok(await store.findRunProgressMessage(ORGANIZATION, boundary.id));
      assert.ok(await store.findRunProgressMessage(ORGANIZATION, running.id));
      assert.equal(await store.expireRunTimelines(completed.run.completedAt, 500), 0);
    } finally {
      await isolated.close();
    }
  }, 120_000);

  it.runIf(_name === "embedded PostgreSQL")(
    "cascades run rows in PostgreSQL; memory archive preserves runs and has no deletion API",
    async () => {
      assert.ok(harness.runtime);
      const run = await acceptedRun(harness);
      await database.appendRunTimelineEvent(event(run.id));
      await database.insertRunProgressMessageIfAbsent({
        triggerRunId: run.id,
        organizationId: ORGANIZATION,
        provider: "github",
        now: EVENT_AT,
      });
      await harness.runtime.query("delete from trigger_runs where id = $1", [run.id]);
      assert.equal(await database.findTriggerRunForOrganization(ORGANIZATION, run.id), undefined);
      assert.equal(await database.readRunTimelineState(ORGANIZATION, run.id), undefined);
      assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
      assert.equal(await database.findRunProgressMessage(ORGANIZATION, run.id), undefined);
    },
  );
});

it("matches PostgreSQL jsonb text and byte accounting for escaped, nested, multibyte and numeric values", async () => {
  const harness = await embeddedHarness();
  const corpus: JsonValue[] = [
    {},
    [],
    null,
    true,
    false,
    0,
    -0,
    1e21,
    1e100,
    1e-7,
    -1.2345678901234567e20,
    Number.MAX_SAFE_INTEGER,
    { quote: '"\\\n\r\t\b\f', text: "\u00e9\u754c\ud83d\ude80", empty: "" },
    { longer: 1, b: 2, aa: 3, a: 4, "\u00e9": 5, z: 6 },
    { nested: [{ z: [null, true, "\ud83d\ude80", { escaped: '"\\' }] }, [1, 2, 3]], number: 1e30 },
    { large: '\u754c"\\'.repeat(300), values: [1e-20, 1e20, 1.25e25] },
  ];
  try {
    for (const value of corpus) {
      const result = await harness.runtime!.query<{ text: string; bytes: number }>(
        "select $1::jsonb::text as text, octet_length($1::jsonb::text) as bytes",
        [JSON.stringify(value)],
      );
      const actual = result.rows[0];
      assert.ok(actual);
      assert.equal(jsonbText(value), actual.text);
      assert.equal(jsonbBytes(value), actual.bytes);
    }
  } finally {
    await harness.close();
  }
}, 120_000);
