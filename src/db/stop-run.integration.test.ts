import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { scanRunPayloads } from "./run-payload-retention.js";
import { createTimelinePostgresHarness } from "./test-utils/run-timeline-postgres.js";

describe("PostgreSQL run cancellation", () => {
  let pg: Awaited<ReturnType<typeof createTimelinePostgresHarness>>;
  beforeAll(async () => {
    pg = await createTimelinePostgresHarness();
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
    assert.equal((await pg.database.listWorkflowScriptStepsPendingCleanup()).length, 1);
    await pg.database.setWorkflowScriptStepOutput(step.id, null);
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
