import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createTimelinePostgresHarness,
  pooledTimelineEvent,
  TIMELINE_ORGANIZATION,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";

describe("pooled progress admission", () => {
  let harness: TimelinePostgresHarness;
  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
  }, 120000);
  afterAll(async () => {
    await harness?.close();
  }, 120000);

  async function completedRun() {
    const run = await harness.createRun();
    await harness.database.appendRunTimelineEvent(pooledTimelineEvent(run.id));
    const completed = await harness.database.failWorkflowRun(run.id, "failed", "failed");
    assert.ok(completed?.run.completedAt);
    return { runId: run.id, cutoff: new Date(completed.run.completedAt.getTime() + 1) };
  }

  it("refuses admission after waiting for a retention transaction to tombstone the run", async () => {
    const { runId, cutoff } = await completedRun();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const retention = await harness.connect({
      afterQuery: async (sql) => {
        if (!sql.includes("for update of run skip locked")) return;
        locked.resolve();
        await release.promise;
      },
    });
    const admission = await harness.connect();
    assert.notEqual(retention.pid, admission.pid);
    const expiring = retention.database.expireRunTimelines(cutoff, 500);
    const operations: Promise<unknown>[] = [expiring];
    try {
      await locked.promise;
      const admitting = admission.database.insertRunProgressMessageIfAbsent({
        triggerRunId: runId,
        organizationId: TIMELINE_ORGANIZATION,
        provider: "github",
        now: new Date(),
      });
      operations.push(admitting);
      assert.equal(await harness.waitForLockOrRead(admission.pid), "blocked");
      release.resolve();
      assert.equal(await expiring, 1);
      assert.equal(await admitting, undefined);
      assert.equal(
        await harness.database.findRunProgressMessage(TIMELINE_ORGANIZATION, runId),
        undefined,
      );
      const state = await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, runId);
      assert.ok(state?.expiredAt instanceof Date);
      assert.deepEqual(
        await harness.database.listRunTimelineEvents(TIMELINE_ORGANIZATION, runId, {
          afterSeq: 0,
          limit: 100,
        }),
        [],
      );
    } finally {
      release.resolve();
      await Promise.allSettled(operations);
    }
  });

  it("holds admission ownership through its insert and returned row before retention can expire it", async () => {
    const { runId, cutoff } = await completedRun();
    const inserted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admission = await harness.connect({
      afterQuery: async (sql) => {
        if (!sql.startsWith("insert into run_progress_messages")) return;
        inserted.resolve();
        await release.promise;
      },
    });
    const retention = await harness.connect();
    assert.notEqual(admission.pid, retention.pid);
    const admitting = admission.database.insertRunProgressMessageIfAbsent({
      triggerRunId: runId,
      organizationId: TIMELINE_ORGANIZATION,
      provider: "github",
      now: new Date(),
    });
    try {
      await inserted.promise;
      assert.equal(await retention.database.expireRunTimelines(cutoff, 500), 0);
      release.resolve();
      const message = await admitting;
      assert.equal(message?.triggerRunId, runId);
      assert.equal(message?.state, "pending");
      assert.equal(await retention.database.expireRunTimelines(cutoff, 500), 1);
      assert.equal(
        await harness.database.findRunProgressMessage(TIMELINE_ORGANIZATION, runId),
        undefined,
      );
      assert.ok(
        (await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, runId))
          ?.expiredAt instanceof Date,
      );
    } finally {
      release.resolve();
      await Promise.allSettled([admitting]);
    }
  });
});
