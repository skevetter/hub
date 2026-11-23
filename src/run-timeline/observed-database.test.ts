import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database, WorkflowStepExecutionInput } from "../db/types.js";
import { RunTimelineBus } from "./bus.js";
import { RunTimeline } from "./index.js";
import {
  createObservedDatabase,
  OBSERVED_DATABASE_METHODS,
  type ObservedDatabaseOptions,
} from "./observed-database.js";
import { RunTimelineReconciler } from "./reconcile.js";
import { createTimelineScrubber } from "./scrub.js";

const ORGANIZATION = "observed-organization";
const DAY = 86_400_000;

function isStepFinished(row: { kind: string }): boolean {
  return row.kind === "step_finished";
}

async function fixture(stepIds = ["work", "later"], deadlineAt = new Date(Date.now() + DAY)) {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION] });
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Observed",
    slug: "observed",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "observed-configuration",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
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
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: ORGANIZATION,
    projectId: project.id,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: "observed",
    prompt: "",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt,
    stepIds,
  });
  const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
  const step = steps[0];
  assert.ok(step);
  const startedAt = new Date();
  const input: WorkflowStepExecutionInput = {
    triggerRunId: run.id,
    stepId: step.stepId,
    ordinal: step.ordinal,
    executionId: randomUUID(),
    execution: {
      organizationId: ORGANIZATION,
      projectId: project.id,
      machineId: null,
      configurationRevisionId: revision.id,
      triggerContext: {},
      outputContext: {},
      startedAt,
      deadlineAt: new Date(startedAt.getTime() + DAY),
      idleDeadlineAt: new Date(startedAt.getTime() + DAY),
    },
  };
  return { database, run, step, input };
}

function observers(): ObservedDatabaseOptions {
  return {
    timeline: { recordRunStart: vi.fn(), recordStepStart: vi.fn() },
    reconciler: { reconcile: vi.fn(async () => undefined) },
    reportFailure: vi.fn(),
  };
}

function captured(database: Database) {
  const bus = new RunTimelineBus();
  const scrub = createTimelineScrubber();
  const options = { maxEvents: 500, retentionDays: 30, bus, scrub };
  const timeline = new RunTimeline(database, options);
  const reconciler = new RunTimelineReconciler(database, { ...options, queue: timeline });
  const reportFailure = vi.fn();
  const observed = createObservedDatabase(database, { timeline, reconciler, reportFailure });
  async function rows(runId: string) {
    return database.listRunTimelineEvents(ORGANIZATION, runId, { afterSeq: 0, limit: 5110 });
  }
  return { observed, timeline, reconciler, reportFailure, rows };
}

describe("observed workflow database", () => {
  it("keeps original promises, result references, stable methods and non-method properties", async () => {
    const { database, input } = await fixture();
    const options = observers();
    const persisted = database.createWorkflowStepExecution(input);
    database.createWorkflowStepExecution = () => persisted;
    const observed = createObservedDatabase(database, options);
    const result = observed.createWorkflowStepExecution(input);
    assert.equal(result, persisted);
    assert.equal(await result, await persisted);
    assert.equal(observed.executionAuthority, database.executionAuthority);
    assert.equal(
      Reflect.get(observed, "findTriggerRunById"),
      Reflect.get(observed, "findTriggerRunById"),
    );
    for (const method of OBSERVED_DATABASE_METHODS)
      assert.equal(observed[method], observed[method]);
    await vi.waitFor(() =>
      assert.equal(vi.mocked(options.timeline.recordStepStart).mock.calls.length, 1),
    );
    assert.deepEqual(vi.mocked(options.timeline.recordStepStart).mock.calls[0], [
      { organizationId: ORGANIZATION, triggerRunId: input.triggerRunId },
      input.stepId,
    ]);
    assert.deepEqual(vi.mocked(options.timeline.recordRunStart).mock.calls[0], [
      { organizationId: ORGANIZATION, triggerRunId: input.triggerRunId },
    ]);
  });

  it("binds untouched methods to their original private-field receiver", async () => {
    const { database } = await fixture();
    class PrivateDatabase {
      readonly #database = database;
      findTriggerRunById(id: string) {
        return this.#database.findTriggerRunById(id);
      }
      listTriggerRunsForProject(projectId: string, limit: number) {
        return this.#database.listTriggerRunsForProject(projectId, limit);
      }
    }
    const raw = Object.assign(new PrivateDatabase(), database);
    const observed = createObservedDatabase(raw, observers());
    const detached = observed.listTriggerRunsForProject.bind(observed);
    assert.deepEqual(await detached("missing-project", 10), []);
    assert.equal(
      Reflect.get(observed, "listTriggerRunsForProject"),
      Reflect.get(observed, "listTriggerRunsForProject"),
    );
  });

  it("preserves rejection identity and never observes rejected persistence", async () => {
    const { database, input } = await fixture();
    const failure = new Error("persist rejected");
    const rejected = Promise.reject(failure);
    database.createWorkflowStepExecution = () => rejected;
    const options = observers();
    const observed = createObservedDatabase(database, options);
    const result = observed.createWorkflowStepExecution(input);
    assert.equal(result, rejected);
    await assert.rejects(result, (error: unknown) => error === failure);
    assert.equal(vi.mocked(options.reconciler.reconcile).mock.calls.length, 0);
    assert.equal(vi.mocked(options.timeline.recordRunStart).mock.calls.length, 0);
  });

  it("records persisted script and linked agent starts and reconciles each status path", async () => {
    const { database, run, step, input } = await fixture();
    const options = observers();
    const observed = createObservedDatabase(database, options);
    const execution = await database.insertAgentExecution({
      ...input.execution,
      workflowStepRunId: step.id,
    });
    await observed.linkWorkflowStepRunExecution(step.id, execution.id);
    await vi.waitFor(() =>
      assert.equal(vi.mocked(options.timeline.recordStepStart).mock.calls.length, 1),
    );
    await observed.completeWorkflowStep(execution.id, "succeeded", { success: true });
    await vi.waitFor(() =>
      assert.equal(vi.mocked(options.reconciler.reconcile).mock.calls.length, 2),
    );
    const later = (await database.listWorkflowStepRunsForTriggerRun(run.id))[1];
    assert.ok(later);
    await observed.startWorkflowScriptStep({
      stepRunId: later.id,
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + DAY),
    });
    await vi.waitFor(() =>
      assert.equal(vi.mocked(options.timeline.recordStepStart).mock.calls.length, 2),
    );
    await observed.updateWorkflowScriptStep(later.id, {
      status: "succeeded",
      output: {},
      at: new Date(),
    });
    await observed.succeedTriggerRun(run.id);
    await vi.waitFor(() =>
      assert.equal(vi.mocked(options.reconciler.reconcile).mock.calls.length, 5),
    );
    assert.equal((await database.findTriggerRunById(run.id))?.status, "succeeded");
  });

  it("does not invent a start for a script that did not start or an expired execution creation", async () => {
    const { database, run, step, input } = await fixture(["work"], new Date(Date.now() - DAY));
    const options = observers();
    const observed = createObservedDatabase(database, options);
    const result = await observed.createWorkflowStepExecution(input);
    assert.equal(result.created, false);
    assert.equal(result.execution, undefined);
    assert.equal((await database.findTriggerRunById(run.id))?.status, "timed_out");
    await observed.startWorkflowScriptStep({
      stepRunId: step.id,
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + DAY),
    });
    await vi.waitFor(() =>
      assert.equal(vi.mocked(options.reconciler.reconcile).mock.calls.length, 2),
    );
    assert.equal(vi.mocked(options.timeline.recordStepStart).mock.calls.length, 0);
  });

  it("never observes rejected runs or standalone agent executions", async () => {
    const { database, run, input } = await fixture();
    const options = observers();
    const observed = createObservedDatabase(database, options);
    const { run: rejected } = await database.createRejectedTriggerRun({
      organizationId: ORGANIZATION,
      projectId: run.projectId,
      configurationRevisionId: run.configurationRevisionId,
      providerEventReceiptId: run.providerEventReceiptId,
      configuredTriggerName: "rejected",
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      rejection: { code: "missing_required", inputName: "required" },
    });
    await observed.succeedTriggerRun(rejected.id);
    const standalone = await database.insertAgentExecution(input.execution);
    await observed.completeWorkflowAgentExecution({
      executionId: standalone.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: {},
    });
    await setImmediate();
    assert.equal(vi.mocked(options.reconciler.reconcile).mock.calls.length, 0);
    assert.equal(vi.mocked(options.timeline.recordRunStart).mock.calls.length, 0);
  });

  it.each(["succeeded", "failed", "timed_out"] as const)(
    "captures persisted agent %s without changing completion or reaction state",
    async (status) => {
      const { database, run, input } = await fixture();
      const { observed, timeline, reconciler, rows, reportFailure } = captured(database);
      const result = await observed.createWorkflowStepExecution(input);
      assert.ok(result.execution);
      const output = { result: "private execution output" };
      const completed = await observed.completeWorkflowAgentExecution({
        executionId: result.execution.id,
        executionStatus: status === "succeeded" ? "succeeded" : "failed",
        stepStatus: status,
        result: output,
        ...(status === "succeeded" ? {} : { failureReason: "agent_execution_failed" }),
      });
      assert.deepEqual(completed.execution.result, output);
      const before = await database.findTriggerRunById(run.id);
      assert.equal(before?.status, status === "succeeded" ? "running" : status);
      assert.equal(before?.outcome === "accepted" ? before.reactionState : undefined, null);
      await vi.waitFor(async () =>
        assert.equal((await rows(run.id)).find(isStepFinished)?.data["status"], status),
      );
      assert.deepEqual(await database.findTriggerRunById(run.id), before);
      assert.equal(JSON.stringify(await rows(run.id)).includes("private execution output"), false);
      assert.equal(reportFailure.mock.calls.length, 0);
      await reconciler.stop();
      await timeline.stop();
    },
  );

  it("captures script, skipped and failed rows before any terminal notification callback", async () => {
    const { database, run, step } = await fixture(["script", "skipped", "failed", "not-run"]);
    const { observed, timeline, reconciler, rows } = captured(database);
    await observed.startWorkflowScriptStep({
      stepRunId: step.id,
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + DAY),
    });
    await observed.updateWorkflowScriptStep(step.id, {
      status: "succeeded",
      output: { exit_code: 0, output_tail: "private script output", truncated: false },
      at: new Date(),
    });
    await observed.markWorkflowStepSkipped(run.id, "skipped", "condition_false");
    await vi.waitFor(async () =>
      assert.equal((await rows(run.id)).filter(isStepFinished).length, 2),
    );
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq, null);
    await observed.failWorkflowRun(run.id, "failed", "workflow_step_failed", "failed");
    await vi.waitFor(async () =>
      assert.ok((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq),
    );
    const events = await rows(run.id);
    assert.deepEqual(
      events.filter((row) => row.kind === "step_finished").map((row) => row.data["status"]),
      ["succeeded", "skipped", "failed"],
    );
    assert.deepEqual(events.find((row) => row.kind === "run_finished")?.data["steps"], {
      succeeded: 1,
      skipped: 1,
      failed: 1,
      timed_out: 0,
      not_run: 1,
      total: 4,
    });
    assert.equal((await database.listWorkflowStepRunsForTriggerRun(run.id))[3]?.status, "pending");
    assert.equal(JSON.stringify(events).includes("private script output"), false);
    await reconciler.stop();
    await timeline.stop();
  });

  it("reconciles deadline recovery, including script steps with no execution", async () => {
    const { database, run, step } = await fixture();
    const { observed, timeline, reconciler, rows } = captured(database);
    const startedAt = new Date();
    await observed.startWorkflowScriptStep({
      stepRunId: step.id,
      startedAt,
      deadlineAt: new Date(startedAt.getTime() + 1),
    });
    const recovered = await observed.recoverWorkflowDeadlines(new Date(startedAt.getTime() + 2));
    assert.deepEqual(recovered, [{ triggerRunId: run.id, executionIds: [] }]);
    await vi.waitFor(async () =>
      assert.ok((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq),
    );
    assert.equal(
      (await rows(run.id)).find((row) => row.kind === "step_finished")?.data["status"],
      "timed_out",
    );
    assert.equal((await database.findTriggerRunById(run.id))?.status, "failed");
    await reconciler.stop();
    await timeline.stop();
  });

  it("seals a successful run reached through the raw inner completion method", async () => {
    const { database, run, input } = await fixture(["work"]);
    const { observed, timeline, reconciler, rows } = captured(database);
    const created = await observed.createWorkflowStepExecution(input);
    assert.ok(created.execution);
    const completed = await observed.completeWorkflowStep(created.execution.id, "succeeded", {
      private: "completion output",
    });
    assert.equal(completed?.stepRun.status, "succeeded");
    const terminal = await observed.succeedTriggerRun(run.id);
    assert.equal(terminal?.run.status, "succeeded");
    await vi.waitFor(async () =>
      assert.ok((await database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq),
    );
    const events = await rows(run.id);
    assert.equal(events.find((row) => row.kind === "step_finished")?.data["status"], "succeeded");
    assert.equal(events.find((row) => row.kind === "run_finished")?.data["status"], "succeeded");
    assert.equal(JSON.stringify(events).includes("completion output"), false);
    await reconciler.stop();
    await timeline.stop();
  });

  it.each(["throw", "reject", "delay"] as const)(
    "isolates observers that %s from workflow outcomes and provider reactions",
    async (behavior) => {
      const { database, run, input } = await fixture();
      const { promise: delayed, resolve: release } = Promise.withResolvers<void>();
      const failure = new Error("cosmetic observer failure");
      const observer = vi.fn(() => {
        if (behavior === "throw") throw failure;
        if (behavior === "reject") return Promise.reject(failure);
        return delayed;
      });
      const reportFailure = vi.fn(() => {
        throw new Error("reporter failed");
      });
      const timeline = observers().timeline;
      const adversarialObserver: unknown = observer;
      Reflect.set(timeline, "recordRunStart", adversarialObserver);
      Reflect.set(timeline, "recordStepStart", adversarialObserver);
      const observed = createObservedDatabase(database, {
        timeline,
        reconciler: { reconcile: observer },
        reportFailure,
      });
      const created = await observed.createWorkflowStepExecution(input);
      assert.ok(created.execution);
      const providerReaction = { delivered: true };
      const completion = await observed.completeWorkflowAgentExecution({
        executionId: created.execution.id,
        executionStatus: "succeeded",
        stepStatus: "succeeded",
        result: providerReaction,
      });
      await observed.succeedTriggerRun(run.id);
      await database.setWorkflowRunReactionState(run.id, providerReaction);
      const persisted = await database.findTriggerRunById(run.id);
      assert.equal(completion.execution.status, "succeeded");
      assert.deepEqual(completion.execution.result, providerReaction);
      assert.equal(persisted?.status, "succeeded");
      assert.deepEqual(
        persisted?.outcome === "accepted" ? persisted.reactionState : undefined,
        providerReaction,
      );
      if (behavior !== "delay")
        await vi.waitFor(() => assert.ok(reportFailure.mock.calls.length > 0));
      release();
    },
  );

  it("catches post-persistence lookup failures without changing the returned object", async () => {
    const { database, step } = await fixture();
    const options = observers();
    const raw = database.startWorkflowScriptStep.bind(database);
    const persisted = raw({
      stepRunId: step.id,
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + DAY),
    });
    const expected = await persisted;
    database.startWorkflowScriptStep = () => persisted;
    database.findTriggerRunById = async () => {
      throw new Error("scope lookup failed");
    };
    const observed = createObservedDatabase(database, options);
    assert.equal(
      await observed.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt: new Date(),
        deadlineAt: new Date(),
      }),
      expected,
    );
    const reportFailure = options.reportFailure;
    assert.ok(reportFailure);
    await vi.waitFor(() => assert.equal(vi.mocked(reportFailure).mock.calls.length, 1));
  });
});
