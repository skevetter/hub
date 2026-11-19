import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { logger } from "../logger.js";
import { RunPayloadRetention } from "../run-payload-retention/index.js";
import { ReceiptRetention } from "../receipt-retention/index.js";
import { drainReceiptSweep, markTestReceipt } from "./test-utils/receipt-expiry.js";
import {
  CUTOFF,
  MATRIX_ORG,
  NOW,
  OLD,
  createRevision,
  seedProofReceipt,
} from "./test-utils/receipt-proof-fixture.js";
import {
  createTimelinePostgresHarness,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";
import type { Database, ProviderEventRouteSnapshot } from "./types.js";

const callback = {
  trigger: "target",
  actor: "sender",
  input: { message: "old body", required: "skip" },
};

async function fixture(harness: TimelinePostgresHarness, route: ProviderEventRouteSnapshot) {
  return seedProofReceipt(harness.database, harness.runtime, {
    key: randomUUID(),
    provider: "manual",
    source: "manual.run",
    route,
    payload: callback,
    droppedReason: "trigger_filters_rejected",
    disposition: "eligible",
  });
}

const writers = ["accepted", "rejected", "drop", "attachment"] as const;
type Writer = (typeof writers)[number];

async function write(
  database: Database,
  writer: Writer,
  id: string,
  route: ProviderEventRouteSnapshot,
) {
  const input = {
    organizationId: MATRIX_ORG,
    projectId: route.projectId,
    configurationRevisionId: route.configurationRevisionId,
    providerEventReceiptId: id,
    configuredTriggerName: "target",
    prompt: "late content",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    stepIds: ["late-step"],
    deadlineAt: NOW,
  };
  switch (writer) {
    case "accepted":
      return database.createAcceptedTriggerRun(input, "acknowledge");
    case "rejected":
      return database.createRejectedTriggerRun(
        {
          ...input,
          rejection: { code: "missing_required", inputName: "late" },
        },
        "acknowledge",
      );
    case "drop":
      return database.markProviderEventDropped(id, "configuration_unavailable", MATRIX_ORG);
    default:
      return database.insertAttachment({
        providerEventReceiptId: id,
        organizationId: MATRIX_ORG,
        connectionId: randomUUID(),
        provider: "slack",
        sourceId: "late",
        filename: "late.txt",
        locator: {},
      });
  }
}

describe("production receipt expiry lock ordering", () => {
  let harness: TimelinePostgresHarness;
  let route: ProviderEventRouteSnapshot;
  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
    await harness.runtime.query(
      "insert into organization (id,name,slug) values ($1,'Proof','proof')",
      [MATRIX_ORG],
    );
    route = await createRevision(
      harness.database,
      "manual.run",
      {
        from_users: ["sender"],
        inputs: { required: "go" },
      },
      { required: true },
    );
  }, 120_000);
  afterAll(async () => harness?.close(), 120_000);

  it.each(writers)("fences stale %s after the real expiry commits", async (writer) => {
    const receipt = await fixture(harness, route);
    const request = {
      organizationId: MATRIX_ORG,
      projectId: route.projectId,
      deliveryId: receipt.deliveryId,
      source: "manual.run",
      receivedAt: NOW,
      payload: { input: "retry body" },
    };
    const stale = await harness.database.persistManualEvent(request);
    assert.equal(stale.status, "accepted");
    assert.match(JSON.stringify(stale.event.payload), /old body/u);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const expirer = await harness.connect({
      async afterQuery(sql) {
        if (!sql.includes("set payload_expiry_state = 'expiring'")) return;
        held.resolve();
        await release.promise;
      },
    });
    const replay = await harness.connect();
    const expiring = expirer.database.expireReceiptPayload(receipt.id, CUTOFF, NOW);
    await Promise.race([held.promise, expiring.then(() => assert.fail("no staging barrier"))]);
    const writing = write(replay.database, writer, receipt.id, route);
    const result =
      writer === "attachment"
        ? assert.rejects(writing, /attachment receipt unavailable/u)
        : writing;
    try {
      assert.equal(await harness.waitForLockOrRead(replay.pid), "blocked");
      release.resolve();
      assert.deepEqual(await expiring, { status: "expired" });
      const answer = await result;
      if (writer === "accepted" || writer === "rejected") {
        assert.deepEqual(answer, { created: false, receiptReplay: true, runId: undefined });
      } else if (writer === "drop") {
        assert.equal(answer, false);
      }
    } finally {
      release.resolve();
      await Promise.allSettled([expiring, result]);
    }
    const replayed = await harness.database.persistManualEvent(request);
    assert.deepEqual(replayed, {
      status: "duplicate",
      providerEventReceiptId: receipt.id,
      replayed: true,
      payloadExpiryState: "expired",
    });
    assert.deepEqual(
      await harness.database.findTriggerRunsByProviderEventReceiptId(receipt.id),
      [],
    );
    assert.equal(
      (await harness.database.findProviderEventReceiptById(receipt.id))?.droppedReason,
      "trigger_filters_rejected",
    );
  });

  it.each(["accepted", "rejected", "attachment"] as const)(
    "rechecks live %s committed before expiry",
    async (writer) => {
      const receipt = await fixture(harness, route);
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const replay = await harness.connect({
        async afterQuery(sql) {
          if (
            !sql.includes("payload_expiry_state from provider_event_receipts") ||
            !sql.includes("for share")
          )
            return;
          held.resolve();
          await release.promise;
        },
      });
      const expirer = await harness.connect();
      const writing = write(replay.database, writer, receipt.id, route);
      await Promise.race([
        held.promise,
        writing.then(() => assert.fail("no receipt writer barrier")),
      ]);
      try {
        assert.deepEqual(await expirer.database.expireReceiptPayload(receipt.id, CUTOFF, NOW), {
          status: "skipped",
          disposition: "locked",
        });
      } finally {
        release.resolve();
        await writing;
      }
      assert.deepEqual(await expirer.database.expireReceiptPayload(receipt.id, CUTOFF, NOW), {
        status: "skipped",
        disposition: writer === "attachment" ? "live_execution" : "run_payload_pending",
      });
      assert.match(
        JSON.stringify((await harness.database.findProviderEventReceiptById(receipt.id))?.payload),
        /old body/u,
      );
    },
  );

  it("resumes a redacted staged row with the first marker timestamp", async () => {
    const receipt = await fixture(harness, route);
    await markTestReceipt(harness.runtime, receipt.id, "expiring", {
      binding: {
        projectId: route.projectId,
        configurationRevisionId: route.configurationRevisionId,
        triggerName: "target",
        triggerId: null,
      },
    });
    const first = await harness.database.findProviderEventReceiptById(receipt.id);
    assert.ok(first?.payloadExpiredAt);
    assert.deepEqual(await harness.database.scanReceiptPayloads(null, OLD, 5, "expiring"), [
      { id: receipt.id, ageFrom: OLD, disposition: "expiring" },
    ]);
    assert.deepEqual(await harness.database.expireReceiptPayload(receipt.id, OLD, NOW), {
      status: "expired",
    });
    assert.deepEqual(
      (await harness.database.findProviderEventReceiptById(receipt.id))?.payloadExpiredAt,
      first.payloadExpiredAt,
    );
  });
  it("rolls back a first marker, joins the in-flight batch and resumes the durable receipt first", async () => {
    const settings = { mode: "on", retentionDays: 30, maxRunsPerPass: 1 } as const;
    const first = await fixture(harness, route);
    const fresh = await fixture(harness, route);
    const interrupted = await harness.connect({
      async afterQuery(sql) {
        if (sql.includes("set payload_expiry_state = 'expiring'")) throw new Error("interrupted");
      },
    });
    await assert.rejects(drainReceiptSweep(interrupted.database, NOW), /interrupted/u);
    const intact = await harness.database.findProviderEventReceiptById(first.id);
    assert.equal(intact?.payloadExpiryState, null);
    assert.match(JSON.stringify(intact?.payload), /old body/u);

    await markTestReceipt(harness.runtime, first.id, "expiring", {
      binding: {
        projectId: route.projectId,
        configurationRevisionId: route.configurationRevisionId,
        triggerName: "target",
        triggerId: null,
      },
    });
    const durable = await harness.database.findProviderEventReceiptById(first.id);
    assert.ok(durable?.payloadExpiredAt);
    const off = await drainReceiptSweep(harness.database, NOW, "off");
    assert.deepEqual(off.receiptCounts.receipts, {});
    assert.deepEqual(await harness.database.findProviderEventReceiptById(first.id), durable);

    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const worker = await harness.connect({
      async afterQuery(sql) {
        if (!sql.includes("set payload_expiry_state = 'expired'")) return;
        held.resolve();
        await release.promise;
      },
    });
    const sweep = new RunPayloadRetention(worker.database, settings);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    let stopping: Promise<void> | undefined;
    try {
      sweep.start();
      await held.promise;
      let stopped = false;
      const stop = async () => {
        await sweep.stop();
        stopped = true;
      };
      stopping = stop();
      const other = await harness.connect();
      const competing = await new RunPayloadRetention(other.database, settings).runBatch(NOW);
      assert.equal(competing.complete, true);
      assert.equal(competing.receiptCounts.receipts.expiring?.count, 1);
      assert.deepEqual(competing.receiptApply.receipt, {
        applied: 0,
        locked: 1,
        changedOrMissing: 0,
      });
      assert.equal(stopped, false);
      assert.equal(
        (await other.database.findProviderEventReceiptById(first.id))?.payloadExpiryState,
        "expiring",
      );
      assert.equal(
        (await other.database.findProviderEventReceiptById(fresh.id))?.payloadExpiryState,
        null,
      );
      release.resolve();
      await stopping;
      assert.equal(stopped, true);
      const reports = info.mock.calls.filter(([, message]) => message === "run payload retention");
      assert.equal(reports.length, 1);
      const logged = JSON.stringify(reports);
      for (const value of [
        first.id,
        first.deliveryId,
        first.marker,
        fresh.id,
        fresh.marker,
        route.projectId,
      ]) {
        assert.equal(logged.includes(value), false);
      }
      assert.match(logged, /"applied":1/u);
    } finally {
      release.resolve();
      await (stopping ?? sweep.stop());
      info.mockRestore();
    }
    const finished = await harness.database.findProviderEventReceiptById(first.id);
    assert.equal(finished?.payloadExpiryState, "expired");
    assert.deepEqual(finished.payloadExpiredAt, durable.payloadExpiredAt);
    assert.equal(
      (await harness.database.findProviderEventReceiptById(fresh.id))?.payloadExpiryState,
      null,
    );
    const restarted = await harness.connect();
    await drainReceiptSweep(restarted.database, NOW);
    assert.equal(
      (await restarted.database.findProviderEventReceiptById(fresh.id))?.payloadExpiryState,
      "expired",
    );
  });
});

it("preserves the seven-day sweep order before, during and after the real first marker", async () => {
  const harness = await createTimelinePostgresHarness();
  try {
    await harness.runtime.query(
      "insert into organization (id,name,slug) values ($1,'Proof','proof')",
      [MATRIX_ORG],
    );
    const route = await createRevision(
      harness.database,
      "manual.run",
      {
        from_users: ["sender"],
        inputs: { required: "go" },
      },
      { required: true },
    );
    const removed = await fixture(harness, route);
    assert.equal((await new ReceiptRetention(harness.runtime).runBatch(NOW)).deleted, 1);
    assert.deepEqual(await harness.database.expireReceiptPayload(removed.id, CUTOFF, NOW), {
      status: "skipped",
      disposition: "changed_or_missing",
    });

    const kept = await fixture(harness, route);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const marking = await harness.connect({
      async afterQuery(sql) {
        if (!sql.includes("set payload_expiry_state = 'expiring'")) return;
        held.resolve();
        await release.promise;
      },
    });
    const deleting = await harness.connect();
    const expiring = marking.database.expireReceiptPayload(kept.id, CUTOFF, NOW);
    await Promise.race([held.promise, expiring.then(() => assert.fail("no staging barrier"))]);
    const sweep = new ReceiptRetention(deleting.runtime);
    const deletion = sweep.runBatch(NOW);
    try {
      assert.equal(await harness.waitForLockOrRead(deleting.pid), "blocked");
    } finally {
      release.resolve();
      await Promise.all([expiring, deletion]);
    }
    assert.deepEqual(await expiring, { status: "expired" });
    assert.equal((await deletion).deleted, 0);
    assert.equal((await sweep.runBatch(NOW)).deleted, 0);
    assert.equal(
      (await harness.database.findProviderEventReceiptById(kept.id))?.payloadExpiryState,
      "expired",
    );
  } finally {
    await harness.close();
  }
}, 120_000);

it("rechecks recovery, reporter and notification work even behind a final run marker", async () => {
  const harness = await createTimelinePostgresHarness();
  try {
    const { database, runtime } = harness;
    await runtime.query("insert into organization (id,name,slug) values ($1,'Proof','proof')", [
      MATRIX_ORG,
    ]);
    const route = await createRevision(database, "manual.run", { from_users: ["sender"] });
    const receipt = await seedProofReceipt(database, runtime, {
      key: "settled-run-live-work",
      provider: "manual",
      source: "manual.run",
      route,
      payload: { trigger: "target", actor: "sender", input: "body" },
      references: [{}],
      disposition: "eligible",
    });
    const [runId] = receipt.runs;
    assert.ok(runId);
    const check = async (
      disposition: "live_execution" | "reporter_pending" | "notification_pending",
    ) => {
      assert.equal(
        (await database.scanReceiptPayloads(null, CUTOFF, 5))[0]?.disposition,
        disposition,
      );
      assert.deepEqual(await database.expireReceiptPayload(receipt.id, CUTOFF, NOW), {
        status: "skipped",
        disposition,
      });
    };

    await runtime.query(
      "insert into workflow_wakeups (trigger_run_id, available_at) values ($1, $2)",
      [runId, OLD],
    );
    await check("live_execution");
    await runtime.query("delete from workflow_wakeups where trigger_run_id = $1", [runId]);

    await runtime.query(
      `insert into agent_executions (organization_id,project_id,configuration_revision_id,status,launch_run_id)
          values($1,$2,$3,'running',$4)`,
      [MATRIX_ORG, route.projectId, route.configurationRevisionId, runId],
    );
    await check("live_execution");
    await runtime.query("delete from agent_executions where launch_run_id = $1", [runId]);

    await runtime.query(
      `insert into run_progress_messages(trigger_run_id,organization_id,provider,state)
          values($1,$2,'github','pending')`,
      [runId, MATRIX_ORG],
    );
    await check("reporter_pending");
    await runtime.query("delete from run_progress_messages where trigger_run_id = $1", [runId]);

    await runtime.query(
      "update trigger_runs set terminal_notification_pending_at = $2 where id = $1",
      [runId, OLD],
    );
    await check("notification_pending");
    await runtime.query(
      "update trigger_runs set terminal_notification_delivered_at = $2 where id = $1",
      [runId, OLD],
    );
    assert.deepEqual(await database.expireReceiptPayload(receipt.id, CUTOFF, NOW), {
      status: "expired",
    });
  } finally {
    await harness.close();
  }
}, 120_000);
