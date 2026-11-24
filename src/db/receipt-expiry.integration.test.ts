import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { createAttachmentCapabilityRegistry } from "../attachments/capabilities.js";
import { activityRunDetailView } from "../projects/activity-run-view.js";
import { ReceiptRetention } from "../receipt-retention/index.js";
import { createManualTriggerSource, dispatchManualTrigger } from "../triggers/manual/source.js";
import { DurableWorkflowEngine } from "../workflows/engine.js";
import { createMemoryDatabase } from "./memory.js";
import { markTestReceipt } from "./test-utils/receipt-expiry.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organizationId,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";
import type {
  CreateAcceptedTriggerRunInput,
  Database,
  DurableProviderEvent,
  ReceiptPayloadExpiryState,
  WorkflowStepExecutionInput,
} from "./types.js";

const deadlineAt = new Date("2099-01-01T00:00:00Z");

async function intake(database: Database) {
  const project = await database.createProject({
    organizationId,
    name: "Receipt replay",
    slug: randomUUID(),
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { triggers: [], environments: [] },
    contentHash: randomUUID(),
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  const input = {
    projectId: project.id,
    organizationId,
    source: "webhook.received",
    payload: { actor: "receipt-sentinel", input: "receipt-body" },
    deliveryId: randomUUID(),
    receivedAt: new Date("2026-01-01T00:00:00Z"),
  };
  const claimed = await database.persistManualEvent(input);
  assert.equal(claimed.status, "accepted");
  const event = claimed.event;
  const run = {
    projectId: project.id,
    organizationId,
    configurationRevisionId: revision.id,
    providerEventReceiptId: event.providerEventReceiptId,
    configuredTriggerName: "receipt-test",
    prompt: "original",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    stepIds: ["first"],
    deadlineAt,
  } satisfies CreateAcceptedTriggerRunInput;
  return { input, event, run };
}

function engine(database: Database, match: () => Promise<"trigger_filters_rejected">) {
  return new DurableWorkflowEngine({
    database,
    entitlements: null,
    providers: [{ name: "receipt-test", eventNames: ["webhook.received"], match }],
  });
}

const branches = ["accepted", "rejected", "attachment", "drop"] as const;
type Branch = (typeof branches)[number];

async function write(database: Database, branch: Branch, run: CreateAcceptedTriggerRunInput) {
  if (branch === "accepted") return database.createAcceptedTriggerRun(run, "acknowledge");
  if (branch === "rejected") {
    return database.createRejectedTriggerRun(
      {
        ...run,
        rejection: { code: "missing_required", inputName: "field" },
      },
      "acknowledge",
    );
  }
  if (branch === "drop") {
    return database.markProviderEventDropped(
      run.providerEventReceiptId,
      "trigger_filters_rejected",
      organizationId,
    );
  }
  return createAttachmentCapabilityRegistry({
    database,
    publicBaseUrl: "http://hub.test",
    authoritySecret: "test-key",
    resolvers: {},
  }).register({
    providerEventReceiptId: run.providerEventReceiptId,
    organizationId,
    connectionId: randomUUID(),
    provider: "slack",
    sourceId: "same-file",
    locator: { fileId: "same-file" },
    filename: "first.txt",
  });
}

async function counts(harness: TimelinePostgresHarness, id: string) {
  const rows = await harness.runtime.query<{
    runs: number;
    steps: number;
    wakeups: number;
    attachments: number;
    dropped_reason: string | null;
  }>(
    `select dropped_reason,
       (select count(*)::int from trigger_runs where provider_event_receipt_id = $1) as runs,
       (select count(*)::int from workflow_step_runs step
          join trigger_runs run on run.id = step.trigger_run_id where run.provider_event_receipt_id = $1) as steps,
       (select count(*)::int from workflow_wakeups wakeup
          join trigger_runs run on run.id = wakeup.trigger_run_id where run.provider_event_receipt_id = $1) as wakeups,
       (select count(*)::int from attachment_capabilities where provider_event_receipt_id = $1) as attachments
      from provider_event_receipts where id = $1`,
    [id],
  );
  return rows.rows[0];
}

describe("native receipt writer fences", () => {
  let harness: TimelinePostgresHarness;
  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
  }, 120_000);
  afterAll(async () => {
    await harness?.close();
  });

  it.each(branches)("%s rechecks a marker committed while its write is blocked", async (branch) => {
    const { run } = await intake(harness.database);
    const id = run.providerEventReceiptId;
    const expiry = await harness.connect();
    const writer = await harness.connect();
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const marking = expiry.runtime.transaction(async (tx) => {
      await markTestReceipt(tx, id, "expiring");
      staged.resolve();
      await release.promise;
    });
    await staged.promise;
    const writing = write(writer.database, branch, run);
    const result =
      branch === "attachment"
        ? assert.rejects(writing, /attachment receipt unavailable/u)
        : writing;
    try {
      assert.equal(await harness.waitForLockOrRead(writer.pid), "blocked");
      release.resolve();
      await marking;
      const observed = await result;
      if (branch === "accepted" || branch === "rejected") {
        assert.deepEqual(observed, { created: false, receiptReplay: true, runId: undefined });
      }
      assert.deepEqual(await counts(harness, id), {
        runs: 0,
        steps: 0,
        wakeups: 0,
        attachments: 0,
        dropped_reason: null,
      });
    } finally {
      release.resolve();
      await Promise.allSettled([result, marking]);
    }
  });

  it.each(branches)("%s commits ahead of the marker and replay adds no work", async (branch) => {
    const { run } = await intake(harness.database);
    const id = run.providerEventReceiptId;
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = await harness.connect({
      async afterQuery(sql) {
        if (branch === "drop" || !sql.includes("from provider_event_receipts")) return;
        if (!sql.includes("for share")) return;
        locked.resolve();
        await release.promise;
      },
    });
    const expiry = await harness.connect();
    if (branch === "drop") {
      await writer.runtime.query("begin");
      let marking: Promise<void> | undefined;
      try {
        assert.equal(await write(writer.database, branch, run), true);
        marking = markTestReceipt(expiry.runtime, id, "expired");
        assert.equal(await harness.waitForLockOrRead(expiry.pid), "blocked");
      } finally {
        await writer.runtime.query("commit");
        await marking;
      }
    } else {
      const writing = write(writer.database, branch, run);
      await Promise.race([locked.promise, writing.then(() => assert.fail("missing receipt lock"))]);
      const marking = markTestReceipt(expiry.runtime, id, "expired");
      try {
        assert.equal(await harness.waitForLockOrRead(expiry.pid), "blocked");
      } finally {
        release.resolve();
        await Promise.all([writing, marking]);
      }
    }

    const before = await counts(harness, id);
    switch (branch) {
      case "accepted":
      case "rejected": {
        const result = await write(harness.database, branch, run);
        const [original] = await harness.database.findTriggerRunsByProviderEventReceiptId(id);
        assert.ok(original);
        assert.deepEqual(result, { created: false, receiptReplay: true, runId: original.id });
        break;
      }
      case "attachment":
        assert.equal(before?.attachments, 1);
        assert.equal(
          await harness.database.findAttachmentBySource(id, "slack", "same-file"),
          undefined,
        );
        await assert.rejects(
          write(harness.database, branch, run),
          /attachment receipt unavailable/u,
        );
        break;
      case "drop":
        assert.equal(before?.dropped_reason, "trigger_filters_rejected");
        await harness.database.markProviderEventDropped(id, "no_project_route", organizationId);
        break;
    }
    assert.deepEqual(await counts(harness, id), before);
  });

  it("does not repair missing step or wakeup rows on a stale accepted replay", async () => {
    const { run, event } = await intake(harness.database);
    const original = await harness.database.createAcceptedTriggerRun(run);
    await harness.runtime.query("delete from workflow_step_runs where trigger_run_id = $1", [
      original.run.id,
    ]);
    await harness.runtime.query("delete from workflow_wakeups where trigger_run_id = $1", [
      original.run.id,
    ]);
    await markTestReceipt(harness.runtime, event.providerEventReceiptId, "expiring", {
      retainContent: true,
    });
    assert.deepEqual(await harness.database.createAcceptedTriggerRun(run, "acknowledge"), {
      created: false,
      receiptReplay: true,
      runId: original.run.id,
    });
    assert.deepEqual(await counts(harness, event.providerEventReceiptId), {
      runs: 1,
      steps: 0,
      wakeups: 0,
      attachments: 0,
      dropped_reason: null,
    });
    const activity = await harness.database.findProjectActivityRun(run.projectId, original.run.id);
    assert.ok(activity);
    assert.equal(activity.receipt.payload, null);
    assert.equal(activity.receipt.acceptedRoutes, null);
    assert.equal(activityRunDetailView(activity, []).run.webhookSummary, undefined);
    const [listing] = await harness.database.listProjectActivityRuns(run.projectId, 10);
    assert.equal(listing?.webhookActor, undefined);
  });

  it("reuses a live attachment, denies its signed URL after marking, and scopes fresh registrations", async () => {
    const database = harness.database;
    const { run } = await intake(database);
    const accepted = await database.createAcceptedTriggerRun(run);
    const [step] = await database.listWorkflowStepRunsForTriggerRun(accepted.run.id);
    assert.ok(step);
    const executionId = randomUUID();
    await database.createWorkflowStepExecution({
      triggerRunId: accepted.run.id,
      stepId: step.stepId,
      ordinal: step.ordinal,
      executionId,
      execution: {
        id: executionId,
        organizationId,
        projectId: run.projectId,
        machineId: null,
        configurationRevisionId: run.configurationRevisionId,
        workflowStepRunId: step.id,
        triggerContext: {},
        outputContext: {},
        deadlineAt,
        idleDeadlineAt: deadlineAt,
        startedAt: new Date(),
      },
    });
    let reads = 0;
    const registry = createAttachmentCapabilityRegistry({
      database,
      publicBaseUrl: "http://hub.test",
      authoritySecret: "fixture-key",
      resolvers: {
        slack: async () => {
          reads++;
          return new Response("fixture file");
        },
      },
    });
    const registration = {
      providerEventReceiptId: run.providerEventReceiptId,
      organizationId,
      connectionId: randomUUID(),
      provider: "slack",
      sourceId: "file-id",
      locator: { fileId: "file-id" },
      filename: "file.txt",
    } as const;
    const attachment = await registry.register(registration);
    assert.equal((await registry.register(registration)).id, attachment.id);
    const download = () =>
      registry.handle(
        new Request(registry.urlFor(attachment.id, executionId)),
        executionId,
        attachment.id,
      );
    assert.equal((await download()).status, 200);
    for (const state of ["expiring", "expired"] as const) {
      await markTestReceipt(harness.runtime, registration.providerEventReceiptId, state);
      assert.equal((await download()).status, 404);
      await assert.rejects(registry.register(registration), /attachment receipt unavailable/u);
    }
    assert.equal(reads, 1);
    assert.equal((await counts(harness, registration.providerEventReceiptId))?.attachments, 1);
    const fresh = await intake(database);
    assert.notEqual(
      (
        await registry.register({
          ...registration,
          providerEventReceiptId: fresh.event.providerEventReceiptId,
        })
      ).id,
      attachment.id,
    );
  });

  it("keeps a seven-day drop when its marker commits while the delete waits", async () => {
    const id = randomUUID();
    await harness.runtime.query(
      `insert into provider_event_receipts
         (id, organization_id, provider, delivery_id, source, received_at, dropped_reason, payload)
       values ($1, $2, 'github', $3, 'github.issues', '2026-01-01', 'no_project_route', '{}')`,
      [id, organizationId, randomUUID()],
    );
    const expiry = await harness.connect();
    const deleting = await harness.connect();
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const marking = expiry.runtime.transaction(async (tx) => {
      await markTestReceipt(tx, id, "expiring");
      staged.resolve();
      await release.promise;
    });
    await staged.promise;
    const sweep = new ReceiptRetention(deleting.runtime);
    const running = sweep.runBatch(new Date("2026-02-01"));
    try {
      assert.equal(await harness.waitForLockOrRead(deleting.pid), "blocked");
    } finally {
      release.resolve();
      await Promise.all([marking, running]);
    }
    assert.equal((await running).deleted, 0);
    assert.equal((await sweep.runBatch(new Date("2026-02-01"))).deleted, 0);
    assert.equal(
      (await harness.database.findProviderEventReceiptById(id))?.payloadExpiryState,
      "expiring",
    );
  });
});

describe.each(["expiring", "expired"] as const)("memory receipt replay in %s", (state) => {
  it("acknowledges manual handoff, hides content and stops before match and all writes", async () => {
    const database = createMemoryDatabase({ organizationIds: [organizationId] });
    const { input, event, run } = await intake(database);
    const receipt = await database.findProviderEventReceiptById(event.providerEventReceiptId);
    assert.ok(receipt);
    Object.assign(receipt, {
      payloadExpiryState: state satisfies ReceiptPayloadExpiryState,
      payloadExpiredAt: new Date(),
    });
    const source = createManualTriggerSource(database);
    await source.start(async () => assert.fail("manual replay reached its handler"));
    assert.deepEqual(await dispatchManualTrigger(source, { ...input, payload: {} }), {
      providerEventReceiptId: receipt.id,
      replayed: true,
    });
    assert.deepEqual(
      await engine(database, async () =>
        assert.fail("marked receipt reached provider matching"),
      ).enqueue(event),
      {
        providerEventReceiptId: receipt.id,
        replayed: true,
      },
    );
    assert.equal((await database.findProviderEventReceiptById(receipt.id))?.payload, null);
    assert.deepEqual(await write(database, "accepted", run), {
      created: false,
      receiptReplay: true,
      runId: undefined,
    });
    assert.deepEqual(await write(database, "rejected", run), {
      created: false,
      receiptReplay: true,
      runId: undefined,
    });
    await assert.rejects(write(database, "attachment", run), /attachment receipt unavailable/u);
    await write(database, "drop", run);
    assert.equal((await database.findProviderEventReceiptById(receipt.id))?.droppedReason, null);
  });
});

async function memoryStepExecutionFixture() {
  const database = createMemoryDatabase({ organizationIds: [organizationId] });
  const { run } = await intake(database);
  const accepted = await database.createAcceptedTriggerRun(run);
  const [step] = await database.listWorkflowStepRunsForTriggerRun(accepted.run.id);
  assert.ok(step);
  const steps: unknown = Object.getOwnPropertyDescriptor(database, "workflowStepRuns")?.value;
  assert.ok(steps instanceof Map);
  const input: WorkflowStepExecutionInput = {
    triggerRunId: accepted.run.id,
    stepId: step.stepId,
    ordinal: step.ordinal,
    executionId: randomUUID(),
    execution: {
      organizationId,
      projectId: run.projectId,
      machineId: null,
      configurationRevisionId: run.configurationRevisionId,
      workflowStepRunId: step.id,
      triggerContext: {},
      outputContext: {},
      deadlineAt,
      idleDeadlineAt: deadlineAt,
      startedAt: new Date(),
    },
  };
  return { database, step, steps, input };
}

it("keeps the original memory-store step when usage reservation cancels the run and removes the step", async () => {
  const { database, step, steps, input } = await memoryStepExecutionFixture();
  const consume = database.consumeOrganizationUsage.bind(database);
  const hook = vi.spyOn(database, "consumeOrganizationUsage").mockImplementation(async (usage) => {
    const reserved = await consume(usage);
    await database.cancelTriggerRun(organizationId, input.triggerRunId);
    assert.equal(steps.delete(step.id), true);
    return reserved;
  });
  try {
    const result = await database.createWorkflowStepExecution({
      ...input,
      reservation: { meter: "executions.monthly", periodStart: new Date("2026-01-01"), limit: 1 },
    });
    assert.deepEqual(result, { stepRun: step, execution: undefined, created: false });
  } finally {
    hook.mockRestore();
  }
});

it.each(["canceled", "running"] as const)(
  "handles a memory-store step removed after execution insertion while the run is %s",
  async (status) => {
    const { database, step, steps, input } = await memoryStepExecutionFixture();
    const insert = database.insertAgentExecution.bind(database);
    const hook = vi
      .spyOn(database, "insertAgentExecution")
      .mockImplementation(async (execution) => {
        const inserted = await insert(execution);
        if (status === "canceled")
          await database.cancelTriggerRun(organizationId, input.triggerRunId);
        assert.equal(steps.delete(step.id), true);
        return inserted;
      });
    try {
      const result = await database.createWorkflowStepExecution(input);
      if (status === "canceled") {
        assert.deepEqual(result, { stepRun: step, execution: undefined, created: false });
        return;
      }
      assert.equal(result.created, true);
      assert.equal(result.execution?.id, input.executionId);
      assert.deepEqual(result.stepRun, {
        ...step,
        status: "running",
        agentExecutionId: input.executionId,
        deadlineAt: input.execution.deadlineAt,
        idleDeadlineAt: input.execution.idleDeadlineAt,
        startedAt: input.execution.startedAt,
      });
      assert.deepEqual(
        await database.findWorkflowStepRunByTriggerRun(input.triggerRunId),
        result.stepRun,
      );
    } finally {
      hook.mockRestore();
    }
  },
);

it("drops an engine callback that already loaded its event before the receipt was marked", async () => {
  const database = createMemoryDatabase({ organizationIds: [organizationId] });
  const { event } = await intake(database);
  const receipt = await database.findProviderEventReceiptById(event.providerEventReceiptId);
  assert.ok(receipt);
  const matching = Promise.withResolvers<"trigger_filters_rejected">();
  const began = Promise.withResolvers<DurableProviderEvent>();
  const workflow = engine(database, () => {
    began.resolve(event);
    return matching.promise;
  });
  const processing = workflow.enqueue(event);
  await began.promise;
  Object.assign(receipt, { payloadExpiryState: "expired", payloadExpiredAt: new Date() });
  matching.resolve("trigger_filters_rejected");
  await processing;
  assert.equal((await database.findProviderEventReceiptById(receipt.id))?.droppedReason, null);
});
