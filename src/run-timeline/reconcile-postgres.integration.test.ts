import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createTimelinePostgresHarness,
  pooledTimelineEvent,
  TIMELINE_ORGANIZATION,
  type TimelinePostgresHarness,
  type TimelineQueryHooks,
} from "../db/test-utils/run-timeline-postgres.js";
import type { Database } from "../db/types.js";
import { RunTimelineBus } from "./bus.js";
import { RunTimeline } from "./index.js";
import { RunTimelineReconciler } from "./reconcile.js";
import { createTimelineScrubber } from "./scrub.js";

const PAGE = { afterSeq: 0, limit: 5110 };

async function waitForBarrier(reached: Promise<void>, operation: Promise<unknown>) {
  const controller = new AbortController();
  try {
    await Promise.race([
      reached,
      operation.then(() => {
        throw new Error("Reconciliation completed before its SQL barrier");
      }),
      delay(3_000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Reconciliation did not reach its SQL barrier");
      }),
    ]);
  } finally {
    controller.abort();
  }
}

function reconciler(database: Database) {
  const bus = new RunTimelineBus();
  const scrub = createTimelineScrubber();
  const options = { bus, scrub, maxEvents: 500, retentionDays: 30 };
  const queue = new RunTimeline(database, options);
  return { bus, reconciler: new RunTimelineReconciler(database, { ...options, queue }) };
}

function isStateRead(sql: string): boolean {
  return sql.includes("from run_timeline_state where trigger_run_id = $1 and organization_id = $2");
}

describe("pooled PostgreSQL reconciliation and retention", () => {
  let harness: TimelinePostgresHarness;
  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
  }, 120_000);
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  async function connect(hooks: TimelineQueryHooks = {}) {
    const connection = await harness.connect(hooks);
    await connection.runtime.query("set statement_timeout = '3s'");
    return connection;
  }

  async function terminalRun() {
    const run = await harness.createRun();
    await harness.database.appendRunTimelineEvent(pooledTimelineEvent(run.id));
    const ended = await harness.database.failWorkflowRun(
      run.id,
      "failed",
      "agent_execution_failed",
    );
    assert.ok(ended?.run.completedAt);
    return { run, cutoff: new Date(ended.run.completedAt.getTime() + 60_000) };
  }

  it("never recreates a timeline or seal when retention wins after reconciliation eligibility was read", async () => {
    const { run, cutoff } = await terminalRun();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const selecting = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    let appendStateRead = false;
    let stateReads = 0;
    try {
      const retention = await connect({
        afterQuery: async (sql) => {
          if (!sql.includes("for update of run skip locked")) return;
          locked.resolve();
          await release.promise;
        },
      });
      const writer = await connect({
        beforeQuery: async (sql) => {
          if (sql.includes("select id from trigger_runs")) selecting.resolve();
        },
        afterQuery: async (sql) => {
          if (isStateRead(sql) && ++stateReads > 1) appendStateRead = true;
        },
      });
      assert.notEqual(retention.pid, writer.pid);
      const expiry = retention.database.expireRunTimelines(cutoff, 500);
      pending.push(expiry);
      void expiry.catch(() => undefined);
      await waitForBarrier(locked.promise, expiry);
      const { reconciler: repair, bus } = reconciler(writer.database);
      const notifications: number[] = [];
      bus.subscribe(run.id, ({ seq }) => {
        notifications.push(seq);
      });
      const reconciliation = repair.reconcile(TIMELINE_ORGANIZATION, run.id);
      pending.push(reconciliation);
      void reconciliation.catch(() => undefined);
      await waitForBarrier(selecting.promise, reconciliation);
      const observed = await harness.waitForLockOrRead(writer.pid, () => appendStateRead);
      release.resolve();
      assert.equal(await expiry, 1);
      await reconciliation;
      const state = await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id);
      assert.ok(state);
      assert.deepEqual(state.expiredAt, cutoff);
      assert.equal(state.sealedSeq, null);
      assert.equal(state.eventCount, 1);
      assert.deepEqual(
        await harness.database.listRunTimelineEvents(TIMELINE_ORGANIZATION, run.id, PAGE),
        [],
      );
      assert.deepEqual(notifications, []);
      assert.equal(observed, "blocked");
      await repair.reconcile(TIMELINE_ORGANIZATION, run.id);
      await repair.sweep();
      assert.deepEqual(
        await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id),
        state,
      );
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  }, 30_000);

  it("preserves the reconciled seal when reconciliation wins and expires it only on the later retention pass", async () => {
    const { run, cutoff } = await terminalRun();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    let stateReads = 0;
    try {
      const writer = await connect({
        afterQuery: async (sql) => {
          if (!isStateRead(sql) || ++stateReads !== 2) return;
          locked.resolve();
          await release.promise;
        },
      });
      const retention = await connect();
      assert.notEqual(writer.pid, retention.pid);
      const { reconciler: repair } = reconciler(writer.database);
      const reconciliation = repair.reconcile(TIMELINE_ORGANIZATION, run.id);
      pending.push(reconciliation);
      void reconciliation.catch(() => undefined);
      await waitForBarrier(locked.promise, reconciliation);
      const expiry = retention.database.expireRunTimelines(cutoff, 500);
      pending.push(expiry);
      assert.equal(await expiry, 0);
      release.resolve();
      await reconciliation;
      const rows = await harness.database.listRunTimelineEvents(
        TIMELINE_ORGANIZATION,
        run.id,
        PAGE,
      );
      assert.deepEqual(
        rows.map((row) => row.kind),
        ["turn_started", "run_started", "step_finished", "run_finished"],
      );
      const sealed = await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id);
      assert.ok(sealed?.sealedSeq);
      assert.equal(sealed.sealedSeq, rows.at(-1)!.seq);
      assert.equal(sealed.expiredAt, null);
      await repair.reconcile(TIMELINE_ORGANIZATION, run.id);
      assert.deepEqual(
        await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id),
        sealed,
      );
      assert.equal(await retention.database.expireRunTimelines(cutoff, 500), 1);
      const expired = await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id);
      assert.deepEqual(expired?.expiredAt, cutoff);
      assert.equal(expired?.sealedSeq, sealed.sealedSeq);
      assert.deepEqual(
        await harness.database.listRunTimelineEvents(TIMELINE_ORGANIZATION, run.id, PAGE),
        [],
      );
      await repair.reconcile(TIMELINE_ORGANIZATION, run.id);
      assert.deepEqual(
        await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id),
        expired,
      );
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  }, 30_000);
});
