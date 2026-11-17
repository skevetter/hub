import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createTimelinePostgresHarness,
  pooledTimelineEvent,
  TIMELINE_ORGANIZATION,
  type TimelinePostgresHarness,
  type TimelineQueryHooks,
} from "./test-utils/run-timeline-postgres.js";

const PAGE = { afterSeq: 0, limit: 5110 };
const WRITERS = ["ordinary append", "run_finished"] as const;

type Writer = (typeof WRITERS)[number];

function signal() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

function isStateRead(sql: string): boolean {
  return sql.includes("from run_timeline_state where trigger_run_id = $1 and organization_id = $2");
}

function start<T>(pending: Promise<unknown>[], operation: Promise<T>): Promise<T> {
  pending.push(operation);
  void operation.catch(() => undefined);
  return operation;
}

async function waitForSignal(reached: Promise<void>, operation: Promise<unknown>) {
  const controller = new AbortController();
  try {
    await Promise.race([
      reached,
      operation.then(() => {
        throw new Error("Operation completed before reaching its SQL barrier");
      }),
      delay(3000, undefined, { signal: controller.signal }).then(() => {
        throw new Error("Operation did not reach its SQL barrier within three seconds");
      }),
    ]);
  } finally {
    controller.abort();
  }
}

function writerEvent(runId: string, writer: Writer) {
  return pooledTimelineEvent(
    runId,
    writer === "run_finished"
      ? { kind: "run_finished", data: { status: "failed" } }
      : { kind: "turn_failed", data: { error: "late failure" } },
  );
}

describe("pooled PostgreSQL timeline concurrency", () => {
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
    assert.deepEqual(await harness.database.appendRunTimelineEvent(pooledTimelineEvent(run.id)), {
      seq: 1,
      inserted: true,
    });
    assert.ok(
      await harness.database.insertRunProgressMessageIfAbsent({
        triggerRunId: run.id,
        organizationId: TIMELINE_ORGANIZATION,
        provider: "github",
        now: new Date(),
      }),
    );
    const completed = await harness.database.failWorkflowRun(run.id, "failed", "finished");
    assert.ok(completed?.run.completedAt);
    const cutoff = new Date(completed.run.completedAt.getTime() + 60_000);
    assert.ok(completed.run.completedAt < cutoff);
    return { run, cutoff };
  }

  async function assertCounters(runId: string, count: number) {
    const rows = await harness.database.listRunTimelineEvents(TIMELINE_ORGANIZATION, runId, PAGE);
    assert.deepEqual(
      rows.map((row) => row.seq),
      Array.from({ length: count }, (_, index) => index + 1),
    );
    const actual = await harness.runtime.query<{ bytes: number }>(
      "select coalesce(sum(octet_length(data::text)), 0)::integer as bytes from run_timeline_events where trigger_run_id = $1",
      [runId],
    );
    const state = await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, runId);
    assert.equal(state?.eventCount, count);
    assert.equal(state?.byteCount, actual.rows[0]!.bytes);
    assert.equal(state?.stepEndCount, 0);
    assert.equal(state?.stepEndBytes, 0);
    assert.equal(state?.droppedCount, 0);
    return rows;
  }

  async function assertExpired(runId: string, cutoff: Date, sealedSeq: number | null) {
    const state = await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, runId);
    assert.ok(state);
    assert.deepEqual(state.expiredAt, cutoff);
    assert.equal(state.sealedSeq, sealedSeq);
    assert.equal(state.sealedAt === null, sealedSeq === null);
    assert.deepEqual(
      await harness.database.listRunTimelineEvents(TIMELINE_ORGANIZATION, runId, PAGE),
      [],
    );
    assert.equal(
      await harness.database.findRunProgressMessage(TIMELINE_ORGANIZATION, runId),
      undefined,
    );
    for (const writer of WRITERS) {
      assert.deepEqual(await harness.database.appendRunTimelineEvent(writerEvent(runId, writer)), {
        reason: "expired",
      });
    }
    assert.deepEqual(
      await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, runId),
      state,
    );
    assert.deepEqual(
      await harness.database.listRunTimelineEvents(TIMELINE_ORGANIZATION, runId, PAGE),
      [],
    );
    assert.equal(
      await harness.database.findRunProgressMessage(TIMELINE_ORGANIZATION, runId),
      undefined,
    );
  }

  it("serializes overlapping state reads on independent connections without losing an append", async () => {
    const run = await harness.createRun();
    assert.deepEqual(await harness.database.appendRunTimelineEvent(pooledTimelineEvent(run.id)), {
      seq: 1,
      inserted: true,
    });
    const firstRead = signal();
    const releaseFirst = signal();
    const secondSelecting = signal();
    const secondRead = signal();
    const releaseSecond = signal();
    let secondStateRead = false;
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
        beforeQuery: async (sql) => {
          if (isStateRead(sql)) secondSelecting.resolve();
        },
        afterQuery: async (sql) => {
          if (!isStateRead(sql)) return;
          secondStateRead = true;
          secondRead.resolve();
          await releaseSecond.promise;
        },
      });
      assert.notEqual(first.pid, second.pid);
      const firstAppend = start(
        pending,
        first.database.appendRunTimelineEvent(
          pooledTimelineEvent(run.id, { kind: "turn_failed", data: { error: 'first "failure"' } }),
        ),
      );
      await waitForSignal(firstRead.promise, firstAppend);
      const secondAppend = start(
        pending,
        second.database.appendRunTimelineEvent(
          pooledTimelineEvent(run.id, { kind: "turn_failed", data: { error: "second\nfailure" } }),
        ),
      );
      await waitForSignal(secondSelecting.promise, secondAppend);
      const observed = await harness.waitForLockOrRead(second.pid, () => secondStateRead);
      releaseFirst.resolve();
      const firstResult = await firstAppend;
      await waitForSignal(secondRead.promise, secondAppend);
      releaseSecond.resolve();
      const secondResult = await secondAppend;
      assert.deepEqual(firstResult, { seq: 2, inserted: true });
      assert.deepEqual(secondResult, { seq: 3, inserted: true });
      assert.equal(observed, "blocked");
      const rows = await assertCounters(run.id, 3);
      assert.deepEqual(
        rows.slice(1).map((row) => row.data["error"]),
        ['first "failure"', "second\nfailure"],
      );
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled(pending);
    }
  }, 30_000);

  it("inserts every append from sixteen independent PostgreSQL writers with exact counters", async () => {
    const run = await harness.createRun();
    assert.deepEqual(await harness.database.appendRunTimelineEvent(pooledTimelineEvent(run.id)), {
      seq: 1,
      inserted: true,
    });
    const pending: Promise<unknown>[] = [];
    try {
      const connections = await Promise.all(Array.from({ length: 16 }, () => connect()));
      assert.equal(new Set(connections.map((connection) => connection.pid)).size, 16);
      const results = await Promise.all(
        connections.map((connection, index) =>
          start(
            pending,
            connection.database.appendRunTimelineEvent(
              pooledTimelineEvent(run.id, {
                kind: "turn_failed",
                data: { error: `writer-${index}` },
              }),
            ),
          ),
        ),
      );
      assert.ok(
        results.every((result) => result !== undefined && "seq" in result && result.inserted),
      );
      assert.deepEqual(
        results
          .map((result) => (result && "seq" in result ? result.seq : -1))
          .sort((a, b) => a - b),
        Array.from({ length: 16 }, (_, index) => index + 2),
      );
      const rows = await assertCounters(run.id, 17);
      assert.equal(new Set(rows.slice(1).map((row) => row.data["error"])).size, 16);
    } finally {
      await Promise.allSettled(pending);
    }
  }, 30_000);

  it.each(WRITERS)(
    "preserves the expiry tombstone when retention wins against %s",
    async (writer) => {
      const { run, cutoff } = await terminalRun();
      const retentionLocked = signal();
      const releaseRetention = signal();
      const writerSelecting = signal();
      let writerStateRead = false;
      const pending: Promise<unknown>[] = [];
      try {
        const retention = await connect({
          afterQuery: async (sql) => {
            if (!sql.includes("for update of run skip locked")) return;
            retentionLocked.resolve();
            await releaseRetention.promise;
          },
        });
        const appender = await connect({
          beforeQuery: async (sql) => {
            if (sql.includes("select id from trigger_runs")) writerSelecting.resolve();
          },
          afterQuery: async (sql) => {
            if (isStateRead(sql)) writerStateRead = true;
          },
        });
        assert.notEqual(retention.pid, appender.pid);
        const expiry = start(pending, retention.database.expireRunTimelines(cutoff, 500));
        await waitForSignal(retentionLocked.promise, expiry);
        const append = start(
          pending,
          appender.database.appendRunTimelineEvent(writerEvent(run.id, writer)),
        );
        await waitForSignal(writerSelecting.promise, append);
        assert.equal(
          await harness.waitForLockOrRead(appender.pid, () => writerStateRead),
          "blocked",
        );
        releaseRetention.resolve();
        assert.equal(await expiry, 1);
        assert.deepEqual(await append, { reason: "expired" });
        await assertExpired(run.id, cutoff, null);
        assert.equal(
          (await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id))?.eventCount,
          1,
        );
      } finally {
        releaseRetention.resolve();
        await Promise.allSettled(pending);
      }
    },
    30_000,
  );

  it.each(WRITERS)(
    "skips the locked run when %s wins, then expires its rows without losing the tombstone",
    async (writer) => {
      const { run, cutoff } = await terminalRun();
      const writerLocked = signal();
      const releaseWriter = signal();
      const pending: Promise<unknown>[] = [];
      try {
        const appender = await connect({
          afterQuery: async (sql) => {
            if (!isStateRead(sql)) return;
            writerLocked.resolve();
            await releaseWriter.promise;
          },
        });
        const retention = await connect();
        assert.notEqual(appender.pid, retention.pid);
        const append = start(
          pending,
          appender.database.appendRunTimelineEvent(writerEvent(run.id, writer)),
        );
        await waitForSignal(writerLocked.promise, append);
        assert.equal(await start(pending, retention.database.expireRunTimelines(cutoff, 500)), 0);
        releaseWriter.resolve();
        assert.deepEqual(await append, { seq: 2, inserted: true });
        const rows = await harness.database.listRunTimelineEvents(
          TIMELINE_ORGANIZATION,
          run.id,
          PAGE,
        );
        assert.deepEqual(
          rows.map((row) => row.seq),
          [1, 2],
        );
        assert.equal(rows[1]!.kind, writer === "run_finished" ? "run_finished" : "turn_failed");
        const sealedSeq = writer === "run_finished" ? 2 : null;
        const state = await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id);
        assert.equal(state?.sealedSeq, sealedSeq);
        assert.equal(state?.expiredAt, null);
        assert.ok(await harness.database.findRunProgressMessage(TIMELINE_ORGANIZATION, run.id));
        assert.equal(await start(pending, retention.database.expireRunTimelines(cutoff, 500)), 1);
        await assertExpired(run.id, cutoff, sealedSeq);
        assert.equal(
          (await harness.database.readRunTimelineState(TIMELINE_ORGANIZATION, run.id))?.eventCount,
          2,
        );
      } finally {
        releaseWriter.resolve();
        await Promise.allSettled(pending);
      }
    },
    30_000,
  );
});
