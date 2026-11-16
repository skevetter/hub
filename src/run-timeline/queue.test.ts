import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { RunTimelineBus } from "./bus.js";
import { RunTimelineQueue } from "./queue.js";

const ORGANIZATION = "queue-organization";
const PAGE = { afterSeq: 0, limit: 5110 };

async function fixture() {
  const database = createMemoryDatabase({ organizationIds: [ORGANIZATION] });
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Queue",
    slug: "queue",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "queue-configuration",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
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
  const { run } = await database.createAcceptedTriggerRun({
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
  });
  const scope = { organizationId: ORGANIZATION, triggerRunId: run.id };
  const bus = new RunTimelineBus();
  const append = async (value: number) => {
    await database.appendRunTimelineEvent({
      ...scope,
      kind: "turn_started",
      at: new Date(),
      data: { value },
      origin: "captured",
    });
  };
  return { database, scope, bus, append };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded per-run timeline queue", () => {
  it("caps ordinary work at 200 including the blocked write, coalesces drops, and reserves the sealing control", async () => {
    const { database, scope, bus, append } = await fixture();
    const queue = new RunTimelineQueue(database, { bus });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const writes: number[] = [];
    const dropWrite = vi.spyOn(database, "recordRunTimelineDrops");
    const notifications: number[] = [];
    const unsubscribe = bus.subscribe(scope.triggerRunId, ({ seq }) => {
      notifications.push(seq);
    });
    let sealing: Promise<void> | undefined;
    try {
      assert.equal(
        queue.enqueue(scope, async () => {
          entered.resolve();
          await release.promise;
          writes.push(0);
          await append(0);
        }),
        true,
      );
      await entered.promise;
      for (let value = 1; value < 200; value++) {
        assert.equal(
          queue.enqueue(scope, async () => {
            writes.push(value);
            await append(value);
          }),
          true,
        );
      }
      for (let value = 0; value < 5_000; value++) {
        assert.equal(
          queue.enqueue(scope, async () => {
            throw new Error("Dropped work ran");
          }),
          false,
        );
        queue.recordDrops(scope, 2);
      }
      assert.equal(queue.depth(), 200);
      assert.equal(dropWrite.mock.calls.length, 0);
      sealing = queue.run(scope, async () => {
        assert.equal(
          (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
          15_000,
        );
        await database.appendRunTimelineEvent({
          ...scope,
          kind: "run_finished",
          at: new Date(),
          data: { status: "succeeded" },
          origin: "captured",
        });
      });
      assert.equal(queue.depth(), 201);
      assert.deepEqual(writes, []);
      release.resolve();
      await sealing;
      assert.equal(await queue.flush(), true);
      assert.deepEqual(
        writes,
        Array.from({ length: 200 }, (_, index) => index),
      );
      const rows = await database.listRunTimelineEvents(ORGANIZATION, scope.triggerRunId, PAGE);
      assert.deepEqual(
        rows.slice(-2).map((row) => row.kind),
        ["truncated", "run_finished"],
      );
      assert.equal(rows.filter((row) => row.kind === "truncated").length, 1);
      assert.deepEqual(rows.at(-2)?.data, { dropped: 15_000 });
      const state = await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId);
      assert.equal(state?.droppedCount, 15_000);
      assert.equal(state?.sealedSeq, rows.at(-1)?.seq);
      assert.equal(dropWrite.mock.calls.length, 1);
      assert.deepEqual(notifications, [201]);
      assert.equal(queue.depth(), 0);
      queue.recordDrops(scope, 7);
      assert.equal(await queue.flush(), true);
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
        15_007,
      );
      assert.equal(
        (await database.listRunTimelineEvents(ORGANIZATION, scope.triggerRunId, PAGE)).length,
        202,
      );
      assert.deepEqual(notifications, [201]);
    } finally {
      release.resolve();
      await sealing?.catch(() => undefined);
      await queue.flush();
      unsubscribe();
    }
  });

  it("propagates a rejected control without poisoning subsequent ordinary or control work", async () => {
    const { database, scope, bus, append } = await fixture();
    const queue = new RunTimelineQueue(database, { bus });
    const failure = new Error("Control failed");
    const rejected = assert.rejects(
      queue.run(scope, async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    queue.enqueue(scope, () => append(1));
    const later = queue.run(scope, () => append(2));
    await rejected;
    await later;
    assert.equal(await queue.flush(), true);
    assert.deepEqual(
      (await database.listRunTimelineEvents(ORGANIZATION, scope.triggerRunId, PAGE)).map(
        (row) => row.data,
      ),
      [{ value: 1 }, { value: 2 }],
    );
    assert.equal(queue.depth(), 0);
  });

  it("rate limits write errors process-wide to one per 30 seconds and keeps draining even if reporting throws", async () => {
    const { database, scope, bus, append } = await fixture();
    let now = 0;
    const failure = new Error("Write failed");
    const reportFailure = vi.fn(() => {
      throw new Error("Reporter failed");
    });
    const queue = new RunTimelineQueue(database, { bus, now: () => new Date(now), reportFailure });
    for (const at of [0, 1, 29_999, 30_000, 30_001]) {
      now = at;
      queue.enqueue({ ...scope, triggerRunId: `${scope.triggerRunId}-${at}` }, async () => {
        throw failure;
      });
      assert.equal(await queue.flush(), true);
    }
    assert.equal(reportFailure.mock.calls.length, 2);
    queue.enqueue(scope, () => append(1));
    assert.equal(await queue.flush(), true);
    assert.equal(
      (await database.listRunTimelineEvents(ORGANIZATION, scope.triggerRunId, PAGE)).length,
      1,
    );
    assert.equal(queue.depth(), 0);
  });

  it("bounds the default flush at two seconds and cancels all not-yet-started work without later writes", async () => {
    const { database, scope, bus, append } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const canceled = vi.fn(async () => {
      await append(99);
    });
    queue.enqueue(scope, async () => {
      await append(0);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    queue.enqueue(scope, canceled);
    const rejection = assert.rejects(queue.run(scope, canceled), /deadline/);
    queue.recordDrops(scope, 50);
    try {
      let settled = false;
      const flushing = queue.flush().then((drained) => {
        settled = true;
        return drained;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      assert.equal(settled, false);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(await flushing, false);
      await rejection;
      assert.equal(queue.depth(), 1);
      assert.equal(queue.enqueue(scope, canceled), false);
      await assert.rejects(queue.run(scope, canceled), /closed/);
      release.resolve();
      assert.equal(await queue.flush(), true);
      assert.equal(queue.depth(), 0);
      assert.equal(canceled.mock.calls.length, 0);
      assert.deepEqual(
        (await database.listRunTimelineEvents(ORGANIZATION, scope.triggerRunId, PAGE)).map(
          (row) => row.data,
        ),
        [{ value: 0 }],
      );
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
        0,
      );
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      release.resolve();
      await rejection;
      await queue.flush();
    }
  });

  it("does not start a reserved control after its preceding drop write outlives the flush deadline", async () => {
    const { database, scope, bus } = await fixture();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const record = database.recordRunTimelineDrops.bind(database);
    vi.spyOn(database, "recordRunTimelineDrops").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return record(...args);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    const control = vi.fn(async () => undefined);
    queue.recordDrops(scope, 4);
    await entered.promise;
    const rejection = assert.rejects(queue.run(scope, control), /deadline/);
    try {
      const flushing = queue.flush();
      await vi.advanceTimersByTimeAsync(2_000);
      assert.equal(await flushing, false);
      await rejection;
      release.resolve();
      assert.equal(await queue.flush(), true);
      assert.equal(control.mock.calls.length, 0);
      assert.equal(queue.depth(), 0);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      release.resolve();
      await rejection;
      await queue.flush();
    }
  });

  it("clears deadline timers after an ordinary successful drain", async () => {
    const { database, scope, bus, append } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const queue = new RunTimelineQueue(database, { bus });
    queue.enqueue(scope, () => append(1));
    assert.equal(await queue.flush(), true);
    assert.equal(queue.depth(), 0);
    assert.equal(vi.getTimerCount(), 0);
  });
});
