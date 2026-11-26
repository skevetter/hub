import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION,
} from "../db/test-utils/run-timeline-postgres.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import { RunTimelineBus } from "./bus.js";
import { RunTimelineQueue } from "./queue.js";

const ORGANIZATION = TIMELINE_ORGANIZATION;

interface Harness {
  database: Database;
  createRun(): Promise<AcceptedTriggerRunRecord>;
  close(): Promise<void>;
}

async function memoryHarness(): Promise<Harness> {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION] });
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Accounting recovery",
    slug: "accounting-recovery",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "accounting-recovery-configuration",
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

const backends = [
  ["memory", memoryHarness],
  ["pooled PostgreSQL", createTimelinePostgresHarness],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(backends)("idempotent retained accounting (%s)", (_name, open) => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await open();
  }, 120_000);
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "recovers exactly three drops after sealing, committed=%s, sealed before accounting=%s",
    async (committed, sealedBeforeAccounting) => {
      const { database } = harness;
      const run = await harness.createRun();
      const scope = { organizationId: ORGANIZATION, triggerRunId: run.id };
      const record = database.recordRunTimelineDrops.bind(database);
      const write = vi
        .spyOn(database, "recordRunTimelineDrops")
        .mockImplementationOnce(async (...args) => {
          if (committed) await record(...args);
          throw new Error("Accounting acknowledgement unavailable");
        });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const bus = new RunTimelineBus();
      const notifications: number[] = [];
      const unsubscribe = bus.subscribe(run.id, ({ seq }) => {
        notifications.push(seq);
      });
      const queue = new RunTimelineQueue(database, { bus });
      const finishedEvent = {
        ...scope,
        kind: "run_finished" as const,
        at: new Date(),
        data: { status: "succeeded" },
        origin: "captured" as const,
      };
      function verifyNotices(
        notices: Awaited<ReturnType<Database["listRunTimelineEvents"]>>,
        hasNotice: boolean,
        state: Awaited<ReturnType<Database["readRunTimelineState"]>>,
      ): void {
        assert.equal(notices.length, hasNotice ? 1 : 0);
        assert.deepEqual(notifications, hasNotice ? [notices[0]!.seq] : []);
        if (hasNotice) assert.notEqual(notices[0]!.seq, state?.eventCount);
      }

      async function verifyRecovery(sealed: Awaited<ReturnType<Database["readRunTimelineState"]>>) {
        const state = await database.readRunTimelineState(ORGANIZATION, run.id);
        assert.equal(state?.droppedCount, 3);
        assert.equal(state?.sealedSeq, sealed?.sealedSeq);
        assert.deepEqual(
          write.mock.calls.map((call) => call[2]),
          [3, 3],
        );
        assert.equal(write.mock.calls[0]?.[4], write.mock.calls[1]?.[4]);
        const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, {
          afterSeq: 0,
          limit: 5110,
        });
        const notices = rows.filter((row) => row.kind === "truncated");
        const hasNotice = committed && !sealedBeforeAccounting;
        verifyNotices(notices, hasNotice, state);
        assert.deepEqual(await write.mock.results[1]!.value, {
          seq: state?.eventCount,
          inserted: false,
          ...(hasNotice ? { noticeSeq: notices[0]!.seq } : {}),
        });
        assert.deepEqual(queue.accountingStats(), {
          queueEntries: 0,
          retainedEntries: 0,
          giveUps: 0,
          abandonedDrops: 0,
        });
      }

      try {
        if (sealedBeforeAccounting) await database.appendRunTimelineEvent(finishedEvent);
        queue.recordDrops(scope, 3);
        assert.equal(await queue.flush(), true);
        assert.equal(
          (await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount ?? 0,
          committed ? 3 : 0,
        );
        assert.equal(queue.accountingStats().retainedEntries, 1);
        assert.equal(notifications.length, 0);
        if (!sealedBeforeAccounting) await database.appendRunTimelineEvent(finishedEvent);
        const sealed = await database.readRunTimelineState(ORGANIZATION, run.id);
        await vi.advanceTimersByTimeAsync(30_000);
        assert.equal(await queue.flush(), true);
        await verifyRecovery(sealed);
      } finally {
        unsubscribe();
        await queue.stop();
      }
    },
  );

  it.each([false, true])(
    "holds more than sixteen new-drop wakes behind a rejected batch until its retry is acknowledged, committed=%s",
    async (committed) => {
      const { database } = harness;
      const run = await harness.createRun();
      const scope = { organizationId: ORGANIZATION, triggerRunId: run.id };
      const record = database.recordRunTimelineDrops.bind(database);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const write = vi
        .spyOn(database, "recordRunTimelineDrops")
        .mockImplementationOnce(async (...args) => {
          if (committed) await record(...args);
          throw new Error("Accounting acknowledgement unavailable");
        })
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return record(...args);
        });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const bus = new RunTimelineBus();
      const notifications: number[] = [];
      const unsubscribe = bus.subscribe(run.id, ({ seq }) => {
        notifications.push(seq);
      });
      const queue = new RunTimelineQueue(database, { bus });
      const controls: Promise<void>[] = [];
      async function verifyAdditionalDrops() {
        const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, {
          afterSeq: 0,
          limit: 5110,
        });
        const notice = rows.find((row) => row.kind === "truncated");
        assert.ok(notice);
        assert.ok(notifications.includes(notice.seq));
        for (let index = 0; index < 20; index++) {
          queue.recordDrops(scope, 1);
          assert.equal(await queue.flush(), true);
        }
        assert.equal(new Set(write.mock.calls.slice(2).map((call) => call[4])).size, 21);
        assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount, 63);
        await vi.advanceTimersByTimeAsync(300_000);
        assert.equal(write.mock.calls.length, 23);
        assert.deepEqual(queue.accountingStats(), {
          queueEntries: 0,
          retainedEntries: 0,
          giveUps: 0,
          abandonedDrops: 0,
        });
      }

      try {
        queue.recordDrops(scope, 3);
        assert.equal(await queue.flush(), true);
        assert.equal(notifications.length, 0);
        await vi.advanceTimersByTimeAsync(30_000);
        await entered.promise;
        for (let index = 0; index < 40; index++) {
          queue.recordDrops(scope, 1);
          controls.push(queue.run(scope, async () => undefined));
        }
        assert.deepEqual(
          write.mock.calls.map((call) => call[2]),
          [3, 3],
        );
        assert.equal(write.mock.calls[0]?.[4], write.mock.calls[1]?.[4]);
        assert.equal(
          (await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount ?? 0,
          committed ? 3 : 0,
        );
        release.resolve();
        await Promise.all(controls);
        assert.equal(await queue.flush(), true);
        assert.deepEqual(
          write.mock.calls.map((call) => call[2]),
          [3, 3, 40],
        );
        assert.notEqual(write.mock.calls[0]?.[4], write.mock.calls[2]?.[4]);
        assert.equal((await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount, 43);
        await verifyAdditionalDrops();
      } finally {
        unsubscribe();
        release.resolve();
        await Promise.allSettled(controls);
        await queue.stop();
      }
    },
  );
});
