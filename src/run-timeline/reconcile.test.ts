import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { Database, WorkflowStepRunRecord } from "../db/types.js";
import { buildLaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { RunTimelineBus } from "./bus.js";
import { jsonbBytes } from "./data.js";
import { RunTimeline } from "./index.js";
import { RunTimelineReconciler } from "./reconcile.js";
import { retentionCutoff } from "./retention.js";
import { createTimelineScrubber } from "./scrub.js";
import type { RunTimelineEvent } from "./store.js";
import type { TimelineRunScope } from "./capture-types.js";
import { assertBackgroundSweepExits } from "./test-utils/background-exit.js";

const ORGANIZATION = "reconciliation-organization";
const PAGE = { afterSeq: 0, limit: 5110 };
const DAY = 86_400_000;

interface Harness {
  database: Database;
  projectId: string;
  close(): Promise<void>;
}

async function memoryHarness(): Promise<Harness> {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION] });
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Reconciliation",
    slug: "reconciliation",
    createdByUserId: null,
  });
  return { database, projectId: project.id, close: async () => undefined };
}

async function embeddedHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "hub-timeline-reconciliation-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
  try {
    await runtime.migrate();
    await runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Reconciliation', 'reconciliation')",
      [ORGANIZATION],
    );
    const database = createDatabase(runtime, locks);
    const project = await database.createProject({
      organizationId: ORGANIZATION,
      name: "Reconciliation",
      slug: "reconciliation",
      createdByUserId: null,
    });
    return {
      database,
      projectId: project.id,
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
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "reconciliation-configuration",
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
  if (receipt.status !== "accepted") throw new Error("Manual receipt was not accepted");
  return (
    await database.createAcceptedTriggerRun({
      organizationId: ORGANIZATION,
      projectId,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "timeline",
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date(Date.now() + DAY),
      stepIds,
    })
  ).run;
}

async function capture(database: Database, runId: string) {
  await database.appendRunTimelineEvent({
    organizationId: ORGANIZATION,
    triggerRunId: runId,
    origin: "captured",
    kind: "turn_started",
    at: new Date(),
    data: {},
  });
}

function components(
  database: Database,
  now = new Date(Date.now() + 60_000),
  retentionDays = 30,
  maxEvents = 500,
) {
  const bus = new RunTimelineBus();
  const scrub = createTimelineScrubber();
  const queue = new RunTimeline(database, { maxEvents, retentionDays, scrub, bus, now: () => now });
  const reportFailure =
    vi.fn<(error: unknown, operation: string, scope?: TimelineRunScope) => void>();
  const reconciler = new RunTimelineReconciler(database, {
    queue,
    maxEvents,
    retentionDays,
    scrub,
    bus,
    now: () => now,
    reportFailure,
  });
  return { reconciler, queue, bus, reportFailure };
}

async function finishScript(
  database: Database,
  step: WorkflowStepRunRecord,
  status: "succeeded" | "failed" | "timed_out",
  { exitCode = 0, failureReason }: { exitCode?: number | null; failureReason?: string } = {},
) {
  const startedAt = new Date(Date.now() - 2_000);
  await database.startWorkflowScriptStep({
    stepRunId: step.id,
    startedAt,
    deadlineAt: new Date(Date.now() + DAY),
  });
  await database.updateWorkflowScriptStep(step.id, {
    status,
    output: { exit_code: exitCode, output_tail: "private script output", truncated: false },
    at: new Date(startedAt.getTime() + 1_000),
    ...(failureReason === undefined ? {} : { failureReason }),
  });
}

function finishRow(rows: RunTimelineEvent[]) {
  const row = rows.find((event) => event.kind === "run_finished");
  assert.ok(row);
  return row;
}

const backends = [
  ["memory", memoryHarness],
  ["embedded PostgreSQL", embeddedHarness],
] as const;

describe.each(backends)("timeline reconciliation (%s)", (_name, open) => {
  let harness: Harness;
  let database: Database;
  beforeAll(async () => {
    harness = await open();
    database = harness.database;
  }, 120_000);
  afterAll(async () => {
    await harness?.close();
  }, 120_000);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a running uncaptured run empty and refuses an unknown or foreign organization", async () => {
    const run = await acceptedRun(harness);
    const { reconciler } = components(database);
    const append = vi.spyOn(database, "appendRunTimelineEvent");
    await reconciler.reconcile(ORGANIZATION, run.id);
    await reconciler.reconcile("another-organization", run.id);
    await reconciler.reconcile(ORGANIZATION, randomUUID());
    assert.equal(append.mock.calls.length, 0);
    assert.equal(await database.readRunTimelineState(ORGANIZATION, run.id), undefined);
  });

  it("never creates timeline state for a rejected run", async () => {
    const evidence = await acceptedRun(harness);
    const { run } = await database.createRejectedTriggerRun({
      organizationId: ORGANIZATION,
      projectId: harness.projectId,
      configurationRevisionId: evidence.configurationRevisionId,
      providerEventReceiptId: evidence.providerEventReceiptId,
      configuredTriggerName: "rejected",
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      rejection: { code: "missing_required", inputName: "required" },
    });
    const append = vi.spyOn(database, "appendRunTimelineEvent");
    await components(database).reconciler.reconcile(ORGANIZATION, run.id);
    assert.equal(append.mock.calls.length, 0);
    assert.equal(await database.readRunTimelineState(ORGANIZATION, run.id), undefined);
  });

  it.each(["succeeded", "failed", "timed_out"] as const)(
    "writes an agent %s step end from persisted state without interpreting agent output as script output",
    async (status) => {
      const run = await acceptedRun(harness, ["agent", "later"]);
      const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const execution = await database.insertAgentExecution({
        organizationId: ORGANIZATION,
        projectId: harness.projectId,
        machineId: null,
        configurationRevisionId: run.configurationRevisionId,
        workflowStepRunId: step.id,
        triggerContext: {},
        outputContext: {},
      });
      await database.linkWorkflowStepRunExecution(step.id, execution.id);
      await capture(database, run.id);
      await database.completeWorkflowAgentExecution({
        executionId: execution.id,
        executionStatus: status === "succeeded" ? "succeeded" : "failed",
        stepStatus: status,
        result: {},
        ...(status === "succeeded" ? {} : { failureReason: "agent_execution_failed" }),
        stepOutput: {
          completion: "inferred_from_turn_end",
          exit_code: 99,
          output_tail: "must not copy",
          truncated: false,
        },
      });
      const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
      const { reconciler } = components(database);
      await reconciler.reconcile(ORGANIZATION, run.id);
      const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
      const end = rows.find((row) => row.kind === "step_finished");
      assert.ok(end);
      assert.equal(end.data["status"], status);
      assert.equal(end.data["completion"], "inferred_from_turn_end");
      assert.equal("exitCode" in end.data, false);
      assert.equal(typeof end.data["durationMs"], "number");
      assert.deepEqual(rows.find((row) => row.kind === "step_started")?.data, { type: "agent" });
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq === null,
        status === "succeeded",
      );
      assert.equal(
        (await database.findTriggerRunForOrganization(ORGANIZATION, run.id))?.status,
        status === "succeeded" ? "running" : status,
      );
      await reconciler.reconcile(ORGANIZATION, run.id);
      assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), rows);
      assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
    },
  );

  it.each([0, 23, null])(
    "writes a script end with exit code %s before the run ends and never stores output",
    async (exitCode) => {
      const run = await acceptedRun(harness, ["script", "later"]);
      const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      await capture(database, run.id);
      let status: "succeeded" | "timed_out" | "failed" = "failed";
      if (exitCode === 0) status = "succeeded";
      else if (exitCode === null) status = "timed_out";
      await finishScript(database, step, status, { exitCode, failureReason: "script failure" });
      const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
      const { reconciler } = components(database);
      await reconciler.reconcile(ORGANIZATION, run.id);
      const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
      const end = rows.find((row) => row.kind === "step_finished");
      assert.ok(end);
      assert.equal(end.data["exitCode"], exitCode);
      assert.equal(end.data["durationMs"], 1_000);
      assert.deepEqual(rows.find((row) => row.kind === "step_started")?.data, { type: "script" });
      assert.equal(JSON.stringify(rows).includes("private script output"), false);
      assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq, null);
      assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
    },
  );

  it("writes skipped steps without inventing a start timestamp", async () => {
    const run = await acceptedRun(harness, ["skip", "later"]);
    await capture(database, run.id);
    await database.markWorkflowStepSkipped(run.id, "skip", "condition false");
    const { reconciler } = components(database);
    await reconciler.reconcile(ORGANIZATION, run.id);
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.equal(
      rows.some((row) => row.kind === "step_started"),
      false,
    );
    assert.deepEqual(rows.find((row) => row.kind === "step_finished")?.data, {
      status: "skipped",
      durationMs: 0,
      exitCode: null,
      failure: "condition false",
    });
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq, null);
  });

  it.each(["dispatch", "execution"] as const)(
    "derives known provider metadata from the persisted %s intent only",
    async (source) => {
      const run = await acceptedRun(harness);
      const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const intent = buildLaunchMachineIntent({
        organizationId: ORGANIZATION,
        projectId: harness.projectId,
        triggerRunId: run.id,
        configurationRevisionId: run.configurationRevisionId,
        triggerName: "timeline",
        environmentName: "test",
        environment: { kind: "daemon", daemonId: "daemon", authoredSlug: "test", cwd: "/private" },
        prompt: "private prompt",
        agent: { provider: "codex", mode: "code" },
        allowOutputs: [],
        autoArchive: false,
        background: true,
        triggerContext: {},
        outputContext: {},
        hubConfig: {},
      });
      const execution = await database.insertAgentExecution({
        organizationId: ORGANIZATION,
        projectId: harness.projectId,
        machineId: null,
        configurationRevisionId: run.configurationRevisionId,
        workflowStepRunId: step.id,
        triggerContext: {},
        outputContext: {},
        ...(source === "execution" ? { launchIntent: intent } : {}),
      });
      await database.linkWorkflowStepRunExecution(
        step.id,
        execution.id,
        source === "dispatch" ? intent : undefined,
      );
      await capture(database, run.id);
      const { reconciler } = components(database);
      await reconciler.reconcile(ORGANIZATION, run.id);
      const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
      assert.deepEqual(rows.find((row) => row.kind === "step_started")?.data, {
        type: "agent",
        agent: { provider: "codex", mode: "code" },
      });
      assert.equal(JSON.stringify(rows).includes("private prompt"), false);
    },
  );

  it.each(["failed", "timed_out"] as const)(
    "counts pending and still-running steps as not_run after a %s run without changing workflow records",
    async (status) => {
      const run = await acceptedRun(harness, ["done", "failed", "pending", "in-flight"]);
      const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
      await finishScript(database, steps[0]!, "succeeded");
      if (status === "timed_out") {
        await database.startWorkflowScriptStep({
          stepRunId: steps[3]!.id,
          startedAt: new Date(),
          deadlineAt: new Date(Date.now() + DAY),
        });
      }
      await database.failWorkflowRun(
        run.id,
        status,
        status === "timed_out" ? "workflow_timed_out" : "failed",
        "failed",
      );
      const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
      const persistedRun = await database.findTriggerRunForOrganization(ORGANIZATION, run.id);
      const { reconciler } = components(database);
      await reconciler.reconcile(ORGANIZATION, run.id);
      const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
      assert.deepEqual(finishRow(rows).data["steps"], {
        succeeded: 1,
        failed: status === "failed" ? 1 : 0,
        timed_out: status === "timed_out" ? 1 : 0,
        skipped: 0,
        not_run: 2,
        total: 4,
      });
      assert.deepEqual(
        rows.filter((row) => row.kind === "step_finished").map((row) => row.stepId),
        ["done", "failed"],
      );
      assert.ok((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq);
      assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
      assert.deepEqual(
        await database.findTriggerRunForOrganization(ORGANIZATION, run.id),
        persistedRun,
      );
      assert.equal(
        rows.find((row) => row.kind === "run_started")?.at.getTime(),
        before[0]!.startedAt!.getTime(),
      );
    },
  );

  it("uses run creation as the start only when no step ever started and seals before terminal notifications", async () => {
    const run = await acceptedRun(harness);
    await database.failWorkflowRun(run.id, "failed", "launch_failed");
    const { reconciler, bus } = components(database);
    const notifications: number[] = [];
    bus.subscribe(run.id, ({ seq }) => {
      notifications.push(seq);
    });
    await reconciler.reconcile(ORGANIZATION, run.id);
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["run_started", "step_finished", "run_finished"],
    );
    assert.deepEqual(rows[0]!.at, run.createdAt);
    assert.deepEqual(
      notifications,
      rows.map((row) => row.seq),
    );
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.origin, "derived");
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    await reconciler.reconcile(ORGANIZATION, run.id);
    assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), state);
    assert.deepEqual(
      notifications,
      rows.map((row) => row.seq),
    );
    const terminal = await database.findTriggerRunForOrganization(ORGANIZATION, run.id);
    assert.ok(terminal?.outcome === "accepted" && terminal.terminalNotificationPendingAt);
    assert.equal(terminal.terminalNotificationDeliveredAt, null);
  });

  it("does not reconstruct expired state after raising retention but derives never-captured history in the wider window", async () => {
    const captured = await acceptedRun(harness);
    const uncaptured = await acceptedRun(harness);
    await capture(database, captured.id);
    await database.succeedTriggerRun(captured.id);
    await database.succeedTriggerRun(uncaptured.id);
    const later = new Date(Date.now() + 2 * DAY);
    const narrow = components(database, later, 1).reconciler;
    const append = vi.spyOn(database, "appendRunTimelineEvent");
    await narrow.reconcile(ORGANIZATION, captured.id);
    await narrow.reconcile(ORGANIZATION, uncaptured.id);
    await narrow.sweep();
    assert.equal(append.mock.calls.length, 0);
    assert.equal(await database.readRunTimelineState(ORGANIZATION, uncaptured.id), undefined);
    await database.expireRunTimelines(retentionCutoff(later, 1), 500);
    const expired = await database.readRunTimelineState(ORGANIZATION, captured.id);
    assert.ok(expired?.expiredAt);
    const wider = components(database, later, 30).reconciler;
    await wider.reconcile(ORGANIZATION, captured.id);
    assert.equal(append.mock.calls.length, 0);
    await wider.reconcile(ORGANIZATION, uncaptured.id);
    assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, captured.id), expired);
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, captured.id, PAGE), []);
    const derived = await database.readRunTimelineState(ORGANIZATION, uncaptured.id);
    assert.equal(derived?.origin, "derived");
    assert.ok(derived?.sealedSeq);
  });

  it("preserves captured origin when repairing an open timeline", async () => {
    const run = await acceptedRun(harness);
    await capture(database, run.id);
    await database.succeedTriggerRun(run.id);
    await components(database).reconciler.reconcile(ORGANIZATION, run.id);
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.equal(state?.origin, "captured");
    assert.ok(state?.sealedSeq);
  });

  it("counts every terminal kind from persisted steps in the sealed summary", async () => {
    const run = await acceptedRun(harness, ["ok", "bad", "timeout", "skip", "pending"]);
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    await finishScript(database, steps[0]!, "succeeded");
    await finishScript(database, steps[1]!, "failed", { exitCode: 7 });
    await finishScript(database, steps[2]!, "timed_out", { exitCode: null });
    await database.markWorkflowStepSkipped(run.id, "skip", "condition false");
    await database.failWorkflowRun(run.id, "failed", "script exited 7", "bad");
    const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
    await components(database).reconciler.reconcile(ORGANIZATION, run.id);
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(finishRow(rows).data["steps"], {
      succeeded: 1,
      failed: 1,
      timed_out: 1,
      skipped: 1,
      not_run: 1,
      total: 5,
    });
    assert.deepEqual(
      rows.filter((row) => row.kind === "step_finished").map((row) => row.data["status"]),
      ["succeeded", "failed", "timed_out", "skipped"],
    );
    assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
  });

  it("refreshes the live omission count when the 101st terminal step completes without ordinary overflow", async () => {
    const run = await acceptedRun(
      harness,
      Array.from({ length: 101 }, (_, index) => `live-${index}`),
    );
    await capture(database, run.id);
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    for (const step of steps.slice(0, 100))
      await database.markWorkflowStepSkipped(run.id, step.stepId, "condition false");
    const { reconciler } = components(database);
    await reconciler.reconcile(ORGANIZATION, run.id);
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.stepRowsOmitted, 0);
    assert.equal(
      (await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).some(
        (row) => row.kind === "truncated",
      ),
      false,
    );
    await database.markWorkflowStepSkipped(run.id, steps[100]!.stepId, "condition false");
    const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
    await reconciler.reconcile(ORGANIZATION, run.id);
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.equal(state?.stepRowsOmitted, 1);
    assert.equal(state?.stepEndCount, 100);
    assert.equal(state?.droppedCount, 0);
    assert.equal(state?.sealedSeq, null);
    assert.equal(rows.filter((row) => row.kind === "truncated").length, 1);
    assert.equal(
      rows.some((row) => row.kind === "run_finished"),
      false,
    );
    assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
  });

  it("stores one omission notice for 150 terminal steps without any ordinary overflow", async () => {
    const run = await acceptedRun(
      harness,
      Array.from({ length: 150 }, (_, index) => `notice-${index}`),
    );
    await capture(database, run.id);
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    for (const step of steps)
      await database.markWorkflowStepSkipped(run.id, step.stepId, "condition false");
    await database.succeedTriggerRun(run.id);
    const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
    await components(database).reconciler.reconcile(ORGANIZATION, run.id);
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.equal(rows.filter((row) => row.kind === "step_finished").length, 100);
    assert.equal(rows.filter((row) => row.kind === "truncated").length, 1);
    assert.equal(state?.droppedCount, 0);
    assert.equal(state?.stepRowsOmitted, 50);
    assert.equal(finishRow(rows).data["stepRowsOmitted"], 50);
    assert.deepEqual(finishRow(rows).data["steps"], {
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      skipped: 150,
      not_run: 0,
      total: 150,
    });
    assert.equal(state?.sealedSeq, finishRow(rows).seq);
    assert.ok(rows.reduce((sum, row) => sum + jsonbBytes(row.data), 0) <= 248448);
    assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
  });

  it("keeps 100 ordinal step ends and all 150 counts after ordinary bytes are exhausted by large rows", async () => {
    const run = await acceptedRun(
      harness,
      Array.from({ length: 150 }, (_, index) => `step-${index}`),
    );
    await capture(database, run.id);
    for (let index = 0; index < 300; index += 1) {
      const result = await database.appendRunTimelineEvent({
        organizationId: ORGANIZATION,
        triggerRunId: run.id,
        origin: "captured",
        kind: "turn_failed",
        at: new Date(),
        maxEvents: 5000,
        data: { error: "x".repeat(1000) },
      });
      if (result && "reason" in result) {
        assert.equal(result.reason, "cap");
        break;
      }
    }
    const failure = '\u{1f600}"'.repeat(120);
    const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
    for (const step of steps)
      await finishScript(database, step, "failed", { exitCode: 1, failureReason: failure });
    await database.failWorkflowRun(run.id, "failed", failure);
    const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
    await components(database, new Date(Date.now() + 60_000), 30, 5000).reconciler.reconcile(
      ORGANIZATION,
      run.id,
    );
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    const ends = rows.filter((row) => row.kind === "step_finished");
    assert.equal(ends.length, 100);
    assert.deepEqual(
      ends.map((row) => row.stepId),
      steps.slice(0, 100).map((step) => step.stepId),
    );
    assert.deepEqual(finishRow(rows).data["steps"], {
      succeeded: 0,
      failed: 150,
      timed_out: 0,
      skipped: 0,
      not_run: 0,
      total: 150,
    });
    assert.equal(finishRow(rows).data["stepRowsOmitted"], 50);
    assert.equal(rows.filter((row) => row.kind === "truncated").length, 1);
    assert.ok(rows.reduce((sum, row) => sum + jsonbBytes(row.data), 0) <= 248448);
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.equal(state?.stepRowsOmitted, 50);
    assert.equal(state?.sealedSeq, finishRow(rows).seq);
    assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
  }, 60_000);

  it("propagates a failed end append and retries to one seal without publishing uncommitted rows", async () => {
    const run = await acceptedRun(harness);
    await database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
    const before = await database.listWorkflowStepRunsForTriggerRun(run.id);
    const { reconciler, bus } = components(database);
    const published: number[] = [];
    bus.subscribe(run.id, ({ seq }) => {
      published.push(seq);
    });
    const append = database.appendRunTimelineEvent.bind(database);
    let failed = false;
    vi.spyOn(database, "appendRunTimelineEvent").mockImplementation(async (input) => {
      if (input.kind === "run_finished" && !failed) {
        failed = true;
        throw new Error("injected end append failure");
      }
      return append(input);
    });
    await assert.rejects(
      reconciler.reconcile(ORGANIZATION, run.id),
      /injected end append failure/u,
    );
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq, null);
    const partial = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.deepEqual(
      published,
      partial.map((row) => row.seq),
    );
    await reconciler.sweep();
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.equal(rows.filter((row) => row.kind === "run_finished").length, 1);
    assert.deepEqual(
      published,
      rows.map((row) => row.seq),
    );
    assert.equal(
      (await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq,
      finishRow(rows).seq,
    );
    assert.deepEqual(await database.listWorkflowStepRunsForTriggerRun(run.id), before);
  });

  it("coalesces requests but reruns when persistence changes during an in-flight reconciliation", async () => {
    const run = await acceptedRun(harness);
    await capture(database, run.id);
    const { reconciler } = components(database);
    const read = database.listWorkflowStepRunsForTriggerRun.bind(database);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    vi.spyOn(database, "listWorkflowStepRunsForTriggerRun").mockImplementation(async (runId) => {
      const steps = await read(runId);
      if (runId === run.id && calls++ === 0) {
        reached.resolve();
        await release.promise;
      }
      return steps;
    });
    const first = reconciler.reconcile(ORGANIZATION, run.id);
    try {
      await reached.promise;
      await database.succeedTriggerRun(run.id);
      const second = reconciler.reconcile(ORGANIZATION, run.id);
      assert.equal(first, second);
      let stopped = false;
      const stop = reconciler.stop().then(() => {
        stopped = true;
        return true;
      });
      await Promise.resolve();
      assert.equal(stopped, false);
      release.resolve();
      await Promise.all([first, second, stop]);
      assert.equal(stopped, true);
      assert.ok((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq);
      assert.ok(calls >= 2);
    } finally {
      release.resolve();
      await Promise.allSettled([first]);
    }
  });

  it("continues sweeping other runs after a per-run failure and does not overlap sweeps", async () => {
    const first = await acceptedRun(harness);
    const second = await acceptedRun(harness);
    await database.succeedTriggerRun(first.id);
    await database.succeedTriggerRun(second.id);
    const { reconciler, reportFailure } = components(database);
    const append = database.appendRunTimelineEvent.bind(database);
    vi.spyOn(database, "appendRunTimelineEvent").mockImplementation(async (input) => {
      if (input.triggerRunId === first.id) throw new Error("one run failed");
      return append(input);
    });
    const list = vi.spyOn(database, "listUnsealedTerminalRuns");
    const sweep = reconciler.sweep();
    assert.equal(reconciler.sweep(), sweep);
    await sweep;
    assert.equal(list.mock.calls.length, 1);
    const [olderThan, cutoff, limit] = list.mock.calls[0]!;
    assert.equal(olderThan.getTime() - cutoff.getTime(), 30 * DAY - 5_000);
    assert.equal(limit, 500);
    assert.ok(reportFailure.mock.calls.some((call) => call[2]?.triggerRunId === first.id));
    assert.ok((await database.readRunTimelineState(ORGANIZATION, second.id))?.sealedSeq);
  });
});

describe("timeline reconciler lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("bounds stopping an active reconciliation and rejects later admission without late database work", async () => {
    const harness = await memoryHarness();
    const { database } = harness;
    const run = await acceptedRun(harness);
    await capture(database, run.id);
    const { reconciler, reportFailure } = components(database);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = database.findTriggerRunForOrganization.bind(database);
    const find = vi
      .spyOn(database, "findTriggerRunForOrganization")
      .mockImplementation(async (...args) => {
        const result = await read(...args);
        reached.resolve();
        await release.promise;
        return result;
      });
    const stateRead = vi.spyOn(database, "readRunTimelineState");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = reconciler.reconcile(ORGANIZATION, run.id);
    try {
      await reached.promise;
      let stopped = false;
      const stopping = reconciler.stop().then(() => {
        stopped = true;
        return true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      assert.equal(stopped, false);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(stopped, true);
      await stopping;
      await reconciler.reconcile(ORGANIZATION, run.id);
      await reconciler.sweep();
      assert.equal(find.mock.calls.length, 1);
      release.resolve();
      await pending;
      assert.equal(stateRead.mock.calls.length, 0);
      assert.equal(reportFailure.mock.calls[0]?.[1], "run.timeline.stop");
      assert.deepEqual(
        (await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).map((row) => row.kind),
        ["turn_started"],
      );
    } finally {
      release.resolve();
      await pending;
      await harness.close();
    }
  });

  it("lets the native process exit without waiting for its reconciliation timer", async () => {
    await assertBackgroundSweepExits("reconciliation");
  });

  it("schedules one timer every 60 seconds and stop waits for active work", async () => {
    const harness = await memoryHarness();
    const { database } = harness;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const list = database.listUnsealedTerminalRuns.bind(database);
    const spy = vi
      .spyOn(database, "listUnsealedTerminalRuns")
      .mockImplementation(async (...args) => {
        reached.resolve();
        await release.promise;
        return list(...args);
      });
    vi.useFakeTimers();
    const { reconciler } = components(database);
    try {
      reconciler.start();
      reconciler.start();
      assert.equal(vi.getTimerCount(), 1);
      await vi.advanceTimersByTimeAsync(60_000);
      await reached.promise;
      await vi.advanceTimersByTimeAsync(120_000);
      assert.equal(spy.mock.calls.length, 1);
      let stopped = false;
      const stop = reconciler.stop().then(() => {
        stopped = true;
        return true;
      });
      await Promise.resolve();
      assert.equal(stopped, false);
      release.resolve();
      await stop;
      assert.equal(vi.getTimerCount(), 0);
      assert.equal(stopped, true);
    } finally {
      release.resolve();
      await reconciler.stop();
      await harness.close();
    }
  });
});
