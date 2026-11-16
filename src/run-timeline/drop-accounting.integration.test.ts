import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION,
  type TimelinePostgresHarness,
  type TimelineQueryHooks,
} from "../db/test-utils/run-timeline-postgres.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";

const ORGANIZATION = TIMELINE_ORGANIZATION;
const PAGE = { afterSeq: 0, limit: 5110 };

interface Harness {
  database: Database;
  createRun(): Promise<AcceptedTriggerRunRecord>;
  close(): Promise<void>;
  pooled?: TimelinePostgresHarness;
}

async function memoryHarness(): Promise<Harness> {
  const database = createMemoryDatabase({
    organizationIds: [ORGANIZATION, "foreign-organization"],
  });
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Drop accounting",
    slug: "drop-accounting",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "drop-accounting-configuration",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  return {
    database,
    async createRun() {
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
      return (
        await database.createAcceptedTriggerRun({
          organizationId: ORGANIZATION,
          projectId: project.id,
          configurationRevisionId: revision.id,
          providerEventReceiptId: receipt.event.providerEventReceiptId,
          configuredTriggerName: "timeline",
          prompt: "",
          inputs: {},
          triggerContext: {},
          outputContext: {},
          deadlineAt: new Date(Date.now() + 3_600_000),
          stepIds: ["work"],
        })
      ).run;
    },
    close: async () => undefined,
  };
}

async function pooledHarness(): Promise<Harness> {
  const pooled = await createTimelinePostgresHarness();
  return {
    database: pooled.database,
    createRun: () => pooled.createRun(),
    close: () => pooled.close(),
    pooled,
  };
}

function event(runId: string, kind: "turn_started" | "run_finished" = "turn_started") {
  return {
    organizationId: ORGANIZATION,
    triggerRunId: runId,
    kind,
    at: new Date(),
    data: kind === "turn_started" ? { text: "ordinary bytes" } : { status: "failed" },
    origin: "captured" as const,
  };
}

async function waitForBarrier(reached: Promise<void>, operation: Promise<unknown>) {
  const controller = new AbortController();
  try {
    await Promise.race([
      reached,
      operation.then(() => {
        throw new Error("Operation completed before its SQL barrier");
      }),
      delay(3_000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Operation did not reach its SQL barrier");
      }),
    ]);
  } finally {
    controller.abort();
  }
}

function isStateRead(sql: string): boolean {
  return sql.includes("from run_timeline_state where trigger_run_id = $1 and organization_id = $2");
}

const backends = [
  ["memory", memoryHarness],
  ["pooled PostgreSQL", pooledHarness],
] as const;

describe.each(backends)("durable timeline drop accounting (%s)", (name, open) => {
  let harness: Harness;
  let database: Database;
  beforeAll(async () => {
    harness = await open();
    database = harness.database;
  }, 120_000);
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it("atomically accumulates concurrent counts with one immutable notice and no ordinary byte charge", async () => {
    const run = await harness.createRun();
    await database.appendRunTimelineEvent(event(run.id));
    const before = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.ok(before);
    const counts = Array.from({ length: 40 }, (_, index) => index + 1);
    const results = await Promise.all(
      counts.map((count) =>
        database.recordRunTimelineDrops(ORGANIZATION, run.id, count, new Date()),
      ),
    );
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.equal(state?.droppedCount, 820);
    assert.equal(state?.byteCount, before.byteCount);
    assert.equal(state?.stepEndBytes, before.stepEndBytes);
    assert.equal(state?.eventCount, before.eventCount + 1);
    assert.equal(results.filter((result) => result?.inserted).length, 1);
    assert.equal(rows.filter((row) => row.kind === "truncated").length, 1);
    assert.deepEqual(
      rows.map((row) => row.seq),
      [1, 2],
    );
    const notice = rows[1]!;
    assert.equal(notice.kind, "truncated");
    const again = await database.recordRunTimelineDrops(ORGANIZATION, run.id, 7, new Date());
    assert.deepEqual(again, { seq: 2, inserted: false });
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), rows);
    assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount, 827);
    assert.equal(
      (await database.readRunTimelineState(ORGANIZATION, run.id))?.byteCount,
      before.byteCount,
    );
  });

  it("opens captured state for an overflow before any ordinary event", async () => {
    const run = await harness.createRun();
    const at = new Date("2026-11-16T10:00:00.000Z");
    assert.deepEqual(await database.recordRunTimelineDrops(ORGANIZATION, run.id, 12, at), {
      seq: 1,
      inserted: true,
    });
    const state = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.equal(state?.origin, "captured");
    assert.equal(state?.droppedCount, 12);
    assert.equal(state?.byteCount, 0);
    assert.equal(state?.stepEndBytes, 0);
    assert.equal(state?.eventCount, 1);
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), [
      {
        organizationId: ORGANIZATION,
        triggerRunId: run.id,
        seq: 1,
        kind: "truncated",
        at,
        stepId: "",
        data: { dropped: 12 },
      },
    ]);
  });

  it.each([false, true])(
    "updates only the counter after sealing (existing notice: %s)",
    async (withNotice) => {
      const run = await harness.createRun();
      await database.appendRunTimelineEvent(event(run.id));
      if (withNotice) await database.recordRunTimelineDrops(ORGANIZATION, run.id, 2, new Date());
      await database.appendRunTimelineEvent(event(run.id, "run_finished"));
      const before = await database.readRunTimelineState(ORGANIZATION, run.id);
      const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
      assert.ok(before?.sealedSeq);
      const result = await database.recordRunTimelineDrops(ORGANIZATION, run.id, 11, new Date());
      assert.deepEqual(result, { seq: before.eventCount, inserted: false });
      assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), {
        ...before,
        droppedCount: before.droppedCount + 11,
      });
      assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), rows);
    },
  );

  it("refuses expired state without changing counters, tombstones, events, or seals", async () => {
    const run = await harness.createRun();
    await database.recordRunTimelineDrops(ORGANIZATION, run.id, 4, new Date());
    await database.appendRunTimelineEvent(event(run.id, "run_finished"));
    const ended = await database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
    assert.ok(ended?.run.completedAt);
    const cutoff = new Date(ended.run.completedAt.getTime() + 60_000);
    await database.expireRunTimelines(cutoff, 500);
    const before = await database.readRunTimelineState(ORGANIZATION, run.id);
    assert.deepEqual(before?.expiredAt, cutoff);
    assert.equal(
      await database.recordRunTimelineDrops(ORGANIZATION, run.id, 20, new Date()),
      undefined,
    );
    assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), before);
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
  });

  it("refuses foreign organizations and unknown references without opening or mutating state", async () => {
    const run = await harness.createRun();
    assert.equal(
      await database.recordRunTimelineDrops("foreign-organization", run.id, 2, new Date()),
      undefined,
    );
    assert.equal(
      await database.recordRunTimelineDrops(ORGANIZATION, randomUUID(), 2, new Date()),
      undefined,
    );
    assert.equal(await database.readRunTimelineState(ORGANIZATION, run.id), undefined);
    await database.recordRunTimelineDrops(ORGANIZATION, run.id, 3, new Date());
    const before = await database.readRunTimelineState(ORGANIZATION, run.id);
    const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
    assert.equal(
      await database.recordRunTimelineDrops("foreign-organization", run.id, 50, new Date()),
      undefined,
    );
    assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), before);
    assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), rows);
  });

  it("rejects invalid increments without opening state", async () => {
    const run = await harness.createRun();
    for (const count of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        database.recordRunTimelineDrops(ORGANIZATION, run.id, count, new Date()),
        RangeError,
      );
    }
    assert.equal(await database.readRunTimelineState(ORGANIZATION, run.id), undefined);
  });

  if (name === "pooled PostgreSQL") {
    async function connect(hooks: TimelineQueryHooks = {}) {
      assert.ok(harness.pooled);
      const connection = await harness.pooled.connect(hooks);
      await connection.runtime.query("set statement_timeout = '3s'");
      return connection;
    }

    it("serializes independent drop writers at the state read and returns a cursor including the one notice", async () => {
      assert.ok(harness.pooled);
      const run = await harness.createRun();
      await database.appendRunTimelineEvent(event(run.id));
      const before = await database.readRunTimelineState(ORGANIZATION, run.id);
      const firstRead = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const releaseSecond = Promise.withResolvers<void>();
      let secondRead = false;
      const pending: Promise<unknown>[] = [];
      try {
        const first = await connect({
          afterQuery: async (sql) => {
            if (!isStateRead(sql)) return;
            firstRead.resolve();
            await releaseFirst.promise;
          },
        });
        const second = await connect({
          afterQuery: async (sql) => {
            if (!isStateRead(sql)) return;
            secondRead = true;
            await releaseSecond.promise;
          },
        });
        assert.notEqual(first.pid, second.pid);
        const a = first.database.recordRunTimelineDrops(ORGANIZATION, run.id, 3, new Date());
        pending.push(a);
        void a.catch(() => undefined);
        await waitForBarrier(firstRead.promise, a);
        const b = second.database.recordRunTimelineDrops(ORGANIZATION, run.id, 5, new Date());
        pending.push(b);
        void b.catch(() => undefined);
        const observed = await harness.pooled.waitForLockOrRead(second.pid, () => secondRead);
        releaseFirst.resolve();
        const firstResult = await a;
        releaseSecond.resolve();
        const secondResult = await b;
        const state = await database.readRunTimelineState(ORGANIZATION, run.id);
        const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
        assert.equal(state?.droppedCount, 8);
        assert.equal(state?.eventCount, 2);
        assert.equal(state?.byteCount, before?.byteCount);
        assert.equal(state?.stepEndBytes, before?.stepEndBytes);
        assert.deepEqual(firstResult, { seq: 2, inserted: true });
        assert.deepEqual(secondResult, { seq: 2, inserted: false });
        assert.deepEqual(
          rows.map((row) => [row.seq, row.kind]),
          [
            [1, "turn_started"],
            [2, "truncated"],
          ],
        );
        const bytes = await harness.pooled.runtime.query<{ bytes: number }>(
          "select coalesce(sum(octet_length(data::text)), 0)::integer as bytes from run_timeline_events where trigger_run_id = $1 and kind = 'turn_started'",
          [run.id],
        );
        assert.equal(state?.byteCount, bytes.rows[0]?.bytes);
        assert.equal(observed, "blocked");
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        await Promise.allSettled(pending);
      }
    }, 30_000);

    it("refuses a drop increment after waiting for retention's physical run lock and preserves the tombstone", async () => {
      assert.ok(harness.pooled);
      const run = await harness.createRun();
      await database.appendRunTimelineEvent(event(run.id));
      const ended = await database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      assert.ok(ended?.run.completedAt);
      const cutoff = new Date(ended.run.completedAt.getTime() + 60_000);
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const selecting = Promise.withResolvers<void>();
      let stateRead = false;
      const pending: Promise<unknown>[] = [];
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
            if (isStateRead(sql)) stateRead = true;
          },
        });
        assert.notEqual(retention.pid, writer.pid);
        const expiry = retention.database.expireRunTimelines(cutoff, 500);
        pending.push(expiry);
        void expiry.catch(() => undefined);
        await waitForBarrier(locked.promise, expiry);
        const increment = writer.database.recordRunTimelineDrops(
          ORGANIZATION,
          run.id,
          9,
          new Date(),
        );
        pending.push(increment);
        void increment.catch(() => undefined);
        await waitForBarrier(selecting.promise, increment);
        const observed = await harness.pooled.waitForLockOrRead(writer.pid, () => stateRead);
        release.resolve();
        await expiry;
        const tombstone = await database.readRunTimelineState(ORGANIZATION, run.id);
        assert.equal(await increment, undefined);
        assert.deepEqual(tombstone?.expiredAt, cutoff);
        assert.equal(tombstone?.droppedCount, 0);
        assert.equal(tombstone?.eventCount, 1);
        assert.equal(tombstone?.sealedSeq, null);
        assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
        assert.equal(
          await writer.database.recordRunTimelineDrops(ORGANIZATION, run.id, 2, new Date()),
          undefined,
        );
        assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), tombstone);
        assert.equal(observed, "blocked");
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
      }
    }, 30_000);

    it("lets a winning drop writer finish while retention skips its lock, then expires only on a later pass", async () => {
      assert.ok(harness.pooled);
      const run = await harness.createRun();
      await database.appendRunTimelineEvent(event(run.id));
      const ended = await database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      assert.ok(ended?.run.completedAt);
      const cutoff = new Date(ended.run.completedAt.getTime() + 60_000);
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pending: Promise<unknown>[] = [];
      try {
        const writer = await connect({
          afterQuery: async (sql) => {
            if (!isStateRead(sql)) return;
            locked.resolve();
            await release.promise;
          },
        });
        const retention = await connect();
        assert.notEqual(writer.pid, retention.pid);
        const increment = writer.database.recordRunTimelineDrops(
          ORGANIZATION,
          run.id,
          13,
          new Date(),
        );
        pending.push(increment);
        void increment.catch(() => undefined);
        await waitForBarrier(locked.promise, increment);
        await retention.database.expireRunTimelines(cutoff, 500);
        assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.expiredAt, null);
        release.resolve();
        assert.deepEqual(await increment, { seq: 2, inserted: true });
        const captured = await database.readRunTimelineState(ORGANIZATION, run.id);
        assert.equal(captured?.droppedCount, 13);
        assert.deepEqual(
          (await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE)).map((row) => row.kind),
          ["turn_started", "truncated"],
        );
        await retention.database.expireRunTimelines(cutoff, 500);
        const expired = await database.readRunTimelineState(ORGANIZATION, run.id);
        assert.deepEqual(expired, { ...captured, expiredAt: cutoff });
        assert.equal(
          await writer.database.recordRunTimelineDrops(ORGANIZATION, run.id, 2, new Date()),
          undefined,
        );
        assert.deepEqual(await database.readRunTimelineState(ORGANIZATION, run.id), expired);
        assert.deepEqual(await database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE), []);
      } finally {
        release.resolve();
        await Promise.allSettled(pending);
      }
    }, 30_000);
  }
});
