import assert from "node:assert/strict";
import { it } from "vitest";
import { createDatabase } from "../db/pg.js";
import { embeddedLocks } from "../db/runtime/locks/index.js";
import { createTimelinePostgresHarness } from "../db/test-utils/run-timeline-postgres.js";
import { matchTriggers } from "../triggers/github/match.js";

const NOW = new Date("2026-11-18T00:00:00Z");
const CUTOFF = new Date("2026-10-19T00:00:00Z");
const OLD = new Date(CUTOFF.getTime() - 1);

it.each(["recovery", "expiry"])(
  "serializes PostgreSQL bulk wakeup recovery when %s locks the run first",
  async (first) => {
    const harness = await createTimelinePostgresHarness();
    const pending: Promise<unknown>[] = [];
    try {
      const run = await harness.createRun();
      const { database, runtime } = harness;
      await database.deleteWorkflowWakeup(run.id);
      const recovery = await harness.connect();
      if (first === "recovery") {
        await runtime.query(`create function pause_recovered_wakeup() returns trigger
          language plpgsql as $$ begin perform pg_advisory_xact_lock(7801);
          return new; end $$`);
        await runtime.query(`create trigger pause_recovered_wakeup before insert on workflow_wakeups
          for each row execute function pause_recovered_wakeup()`);
        const settlement = await harness.connect();
        await runtime.transaction(async (barrier) => {
          await barrier.query("select pg_advisory_xact_lock(7801)");
          pending.push(recovery.database.recoverWorkflowWakeups(NOW));
          assert.equal(await harness.waitForLockOrRead(recovery.pid), "blocked");
          pending.push(settlement.database.failWorkflowRun(run.id, "failed", "settled"));
          assert.equal(await harness.waitForLockOrRead(settlement.pid), "blocked");
          assert.equal(await database.expireRunPayloadChunk(run.id, CUTOFF, NOW), "skipped");
        });
        await Promise.all(pending);
        await runtime.query(
          "update trigger_runs set completed_at = $2, terminal_notification_delivered_at = $2 where id = $1",
          [run.id, OLD],
        );
        assert.equal(await database.expireRunPayloadChunk(run.id, CUTOFF, NOW), "expiring");
      } else {
        await runtime.transaction(async (transaction) => {
          await transaction.query("select id from trigger_runs where id = $1 for update", [run.id]);
          pending.push(recovery.database.recoverWorkflowWakeups(NOW));
          assert.equal(await harness.waitForLockOrRead(recovery.pid), "blocked");
          await transaction.query(
            "update trigger_runs set status = 'failed', completed_at = $2 where id = $1",
            [run.id, OLD],
          );
          const expiry = createDatabase(
            {
              query: transaction.query.bind(transaction),
              transaction: (operation) => operation(transaction),
              drizzle: transaction.drizzle.bind(transaction),
              migrate: runtime.migrate.bind(runtime),
              close: runtime.close.bind(runtime),
            },
            embeddedLocks(),
          );
          assert.equal(await expiry.expireRunPayloadChunk(run.id, CUTOFF, NOW), "expiring");
        });
        await Promise.all(pending);
      }
      const wakes = await runtime.query(
        "select id from trigger_runs where id = $1 and exists (select 1 from workflow_wakeups where trigger_run_id = $1)",
        [run.id],
      );
      assert.equal(wakes.rowCount, 0);
      assert.equal(await database.expireRunPayloadChunk(run.id, CUTOFF, NOW), "expiring");
      assert.equal(await database.expireRunPayloadChunk(run.id, CUTOFF, NOW), "expired");
    } finally {
      await Promise.allSettled(pending);
      await harness.close();
    }
  },
  120_000,
);

it("requires both matching workflow names in the pinned PostgreSQL fan-out", async () => {
  const harness = await createTimelinePostgresHarness();
  try {
    const first = await harness.createRun();
    const { database, runtime } = harness;
    const event = {
      id: "delivery",
      type: "issues",
      repo: "owner/repo",
      repositoryId: 1,
      installationId: 1,
      createdAt: OLD.toISOString(),
      payload: {
        action: "opened",
        sender: { login: "owner" },
        issue: { number: 1, title: "Title", body: "Body", user: { login: "owner" } },
      },
    };
    const workflows = [first.configuredTriggerName, "second"].map((name) => ({
      name,
      on: "github.issue_created",
      filters: { from_users: ["owner"] },
      steps: [],
      inputs: {},
      values: {},
      maxRuntimeMs: 1000,
    }));
    assert.deepEqual(
      matchTriggers({ triggers: workflows }, event).map(({ trigger }) => trigger.name),
      workflows.map(({ name }) => name),
    );
    await runtime.query(
      "update project_configuration_revisions set normalized_configuration = $2 where id = $1",
      [first.configurationRevisionId, { triggers: workflows }],
    );
    await runtime.query(
      `update provider_event_receipts set provider = 'github', source = 'github.issues',
        payload = $2, accepted_routes = $3::jsonb where id = $1`,
      [
        first.providerEventReceiptId,
        event,
        JSON.stringify([
          {
            projectId: first.projectId,
            configurationRevisionId: first.configurationRevisionId,
          },
        ]),
      ],
    );
    const current = await database.insertProjectConfigurationRevision({
      projectId: first.projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [workflows[0]] },
      contentHash: "current",
    });
    await database.activateProjectConfigurationRevision(first.projectId, current.id, []);
    await database.deleteWorkflowWakeup(first.id);
    await runtime.query(
      "update trigger_runs set status = 'succeeded', completed_at = $2 where id = $1",
      [first.id, OLD],
    );

    assert.deepEqual(await database.scanRunPayloads(null, CUTOFF, 10, true), [
      { id: first.id, disposition: "fan_out_unresolved", ageFrom: OLD },
    ]);
    assert.equal(await database.expireRunPayloadChunk(first.id, CUTOFF, NOW), "skipped");
    assert.equal((await database.findTriggerRunById(first.id))?.payloadExpiredAt, null);

    const { run: other } = await database.createAcceptedTriggerRun({
      organizationId: first.organizationId,
      projectId: first.projectId,
      configurationRevisionId: first.configurationRevisionId,
      providerEventReceiptId: first.providerEventReceiptId,
      prompt: first.prompt,
      deadlineAt: first.deadlineAt,
      configuredTriggerName: "second",
      stepIds: ["work"],
      inputs: {},
      triggerContext: {},
      outputContext: {},
    });
    const settled = await database.scanRunPayloads(null, CUTOFF, 10, true);
    assert.equal(settled.find(({ id }) => id === first.id)?.disposition, "eligible");
    assert.equal(settled.find(({ id }) => id === other.id)?.disposition, "live");
    assert.equal(await database.expireRunPayloadChunk(first.id, CUTOFF, NOW), "expiring");
  } finally {
    await harness.close();
  }
}, 120_000);
