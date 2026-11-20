import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { scanRunPayloads } from "./run-payload-retention.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION,
} from "./test-utils/run-timeline-postgres.js";

describe("PostgreSQL run cancellation", () => {
  let pg: Awaited<ReturnType<typeof createTimelinePostgresHarness>>;
  beforeAll(async () => {
    pg = await createTimelinePostgresHarness();
    await enrollTestDaemon(pg.database, TIMELINE_ORGANIZATION);
  }, 120_000);
  afterAll(async () => pg?.close(), 120_000);

  it("commits one terminal outcome when stop races normal completion across connections", async () => {
    const run = await pg.createRun();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stop = await pg.connect({
      afterQuery: async (sql) => {
        if (!sql.includes("set status = 'canceled'")) return;
        entered.resolve();
        await release.promise;
      },
    });
    const finish = await pg.connect();
    const stopping = stop.database.cancelTriggerRun(run.organizationId, run.id);
    await Promise.race([entered.promise, stopping]);
    const completing = finish.database.succeedTriggerRun(run.id);
    try {
      assert.equal(await pg.waitForLockOrRead(finish.pid), "blocked");
    } finally {
      release.resolve();
    }
    const [canceled, completed] = await Promise.all([stopping, completing]);
    assert.equal(canceled?.transitioned, true);
    assert.equal(completed?.transitioned, false);
    assert.equal(canceled?.run.status, "canceled");
    assert.equal(completed?.run.status, "canceled");
    assert.equal((await pg.database.findTriggerRunById(run.id))?.status, "canceled");
    const steps = await pg.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.equal(steps[0]?.status, "skipped");
    const repeat = await stop.database.cancelTriggerRun(run.organizationId, run.id);
    assert.equal(repeat?.transitioned, false);
    assert.equal(repeat?.run.status, "canceled");
    assert.equal(await pg.database.claimWorkflowWakeup(new Date(), 1000), undefined);

    const finished = await pg.createRun();
    await finish.database.succeedTriggerRun(finished.id);
    const afterFinish = await stop.database.cancelTriggerRun(finished.organizationId, finished.id);
    assert.equal(afterFinish?.transitioned, false);
    assert.equal(afterFinish?.run.status, "succeeded");
  });

  it("refuses Stop when the confirmed attached run count changed", async () => {
    const run = await pg.createRun();
    const stopped = await pg.database.cancelTriggerRun(run.organizationId, run.id, "stop-user", 1);
    assert.equal(stopped?.conflict, 0);
    assert.equal((await pg.database.findTriggerRunById(run.id))?.status, "running");
    await pg.database.succeedTriggerRun(run.id);
  });

  it("only lets the PostgreSQL lease holder update and settle a pending Stop interrupt", async () => {
    const run = await pg.createRun();
    const [step] = await pg.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.ok(step);
    const id = randomUUID();
    await pg.runtime.query(
      `insert into agent_executions
        (id, organization_id, project_id, configuration_revision_id, workflow_step_run_id, daemon_id, status)
       values ($1, $2, $3, $4, $5, $6, 'running')`,
      [id, run.organizationId, run.projectId, run.configurationRevisionId, step.id, TEST_DAEMON_ID],
    );
    await pg.database.cancelTriggerRun(run.organizationId, run.id);
    const other = await pg.connect();
    const stores = [pg.database.stopInterrupts, other.database.stopInterrupts] as const;
    const granted = await Promise.all(
      stores.map((store, index) => store.claim(id, String(index), null)),
    );
    assert.equal(granted.filter(Boolean).length, 1);
    const winner = granted[0] === undefined ? 1 : 0;
    const state = {
      approvedPeerIds: [],
      target: { agentId: "agent", attachmentFingerprint: "target", peerIds: [] },
    };
    assert.equal(await stores[1 - winner]!.save(id, String(1 - winner), state), false);
    assert.equal(await stores[winner].save(id, String(winner), state), true);
    await pg.runtime.query(
      `update agent_executions set hub_action_acknowledgements =
        jsonb_set(hub_action_acknowledgements, '{stop_interrupt_claim,until}', to_jsonb(clock_timestamp() - interval '1 second'))
       where id = $1`,
      [id],
    );
    assert.deepEqual(await stores[1 - winner]!.claim(id, "takeover", String(winner)), { state });
    await stores[winner].complete(id, String(winner));
    assert.equal((await pg.database.findAgentExecutionById(id))?.hubActionCompletedAt, null);
    await stores[1 - winner]!.release(id, "takeover");
    assert.equal(await stores[winner].claim(id, "stale", "takeover"), undefined);
    const execution = await pg.database.findAgentExecutionById(id);
    const generation = execution?.hubActionAcknowledgements.stopInterruptGeneration;
    assert.equal(generation, "takeover:released");
    assert.deepEqual(await stores[winner].claim(id, "retry", generation), { state });
    await stores[winner].complete(id, "retry");
    assert.equal(await stores[winner].claim(id, "later", "retry"), undefined);
  });

  it("records the stopping actor atomically and attributes only the first stop", async () => {
    const run = await pg.createRun();
    await pg.runtime.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
      "stop-user",
      "Avery",
      "avery@example.test",
    ]);
    const canceled = await pg.database.cancelTriggerRun(run.organizationId, run.id, "stop-user");
    await pg.database.cancelTriggerRun(run.organizationId, run.id, "ignored-user");
    const audit = await pg.runtime.query(
      "select actor_kind, actor_identity, created_at from audit_events where organization_id = $1 and subject_type = 'trigger_run' and subject_id = $2 and action = 'run.canceled'",
      [run.organizationId, run.id],
    );
    assert.deepEqual(audit.rows, [
      { actor_kind: "user", actor_identity: "stop-user", created_at: canceled?.run.completedAt },
    ]);
    assert.equal(
      (await pg.database.readRunStopDetails(run.organizationId, run.id))?.stoppedByName,
      "Avery",
    );
  });

  it("leaves terminal notification fences in place and expires a settled canceled run", async () => {
    const run = await pg.createRun();
    const [step] = await pg.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.ok(step);
    await pg.database.startWorkflowScriptStep({
      stepRunId: step.id,
      startedAt: new Date(),
      deadlineAt: run.deadlineAt,
      output: { daemon_id: "offline", cwd: "/workspace" },
    });
    const result = await pg.database.cancelTriggerRun(run.organizationId, run.id);
    assert.equal(result?.run.status, "canceled");
    assert.ok(result?.run.completedAt);
    const cutoff = new Date(result.run.completedAt.getTime() + 1000);
    const disposition = async () =>
      (await scanRunPayloads(pg.runtime, null, cutoff, 100, false)).find(({ id }) => id === run.id)
        ?.disposition;
    assert.equal(await disposition(), "cleanup_blocked");
    assert.equal(
      (await pg.database.readRunStopDetails(run.organizationId, run.id))?.cleanupPending,
      true,
    );
    assert.equal((await pg.database.listWorkflowScriptStepsPendingCleanup()).length, 1);
    await pg.database.setWorkflowScriptStepOutput(step.id, null);
    assert.equal(
      (await pg.database.readRunStopDetails(run.organizationId, run.id))?.cleanupPending,
      false,
    );
    assert.equal(await disposition(), "notification_pending");
    const now = new Date(cutoff.getTime() + 1000);
    assert.equal(await pg.database.expireRunPayloadChunk(run.id, cutoff, now), "skipped");
    await pg.runtime.query(
      "update trigger_runs set terminal_notification_delivered_at = now() where id = $1",
      [run.id],
    );
    assert.equal(await disposition(), "eligible");
    const steps = await pg.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.deepEqual(
      steps.map(({ status }) => status),
      ["canceled"],
    );
    assert.equal(await pg.database.expireRunPayloadChunk(run.id, cutoff, now), "expiring");
    await pg.database.wakeWorkflowRun(run.id, now);
    assert.equal(await pg.database.claimWorkflowWakeup(now, 1000), undefined);
    assert.equal(await pg.database.expireRunPayloadChunk(run.id, cutoff, now), "expiring");
    assert.equal(await pg.database.expireRunPayloadChunk(run.id, cutoff, now), "expired");
    assert.equal(
      (await pg.database.cancelTriggerRun(run.organizationId, run.id))?.transitioned,
      false,
    );
  });
});
