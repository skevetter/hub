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
  const createScope = async () => {
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
    return { organizationId: ORGANIZATION, triggerRunId: run.id };
  };
  const scope = await createScope();
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
  return { database, scope, bus, append, createScope };
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

  it("retains all 51 overflow drops after a failed accounting write and retries before sealing", async () => {
    const { database, scope, bus, append } = await fixture();
    const failure = new Error("Drop accounting unavailable");
    const dropWrite = vi.spyOn(database, "recordRunTimelineDrops").mockRejectedValueOnce(failure);
    const reportFailure = vi.fn();
    const queue = new RunTimelineQueue(database, { bus, reportFailure });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    queue.enqueue(scope, async () => {
      entered.resolve();
      await release.promise;
      await append(0);
    });
    try {
      await entered.promise;
      let refused = 0;
      for (let value = 1; value < 251; value++) {
        const accepted = queue.enqueue(scope, () => append(value));
        assert.equal(accepted, value < 200);
        if (!accepted) refused += 1;
      }
      assert.equal(refused, 51);
      assert.equal(queue.depth(), 200);
      release.resolve();
      assert.equal(await queue.flush(), true);
      assert.equal(queue.depth(), 0);
      assert.equal(dropWrite.mock.calls.length, 1);
      assert.equal(dropWrite.mock.calls[0]?.[2], 51);
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
        0,
      );
      assert.deepEqual(reportFailure.mock.calls, [[failure, "run.timeline.write", scope]]);

      await queue.run(scope, async () => {
        assert.equal(
          (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
          51,
        );
        await database.appendRunTimelineEvent({
          ...scope,
          kind: "run_finished",
          at: new Date(),
          data: { status: "succeeded" },
          origin: "captured",
        });
      });
      assert.equal(await queue.flush(), true);
      assert.deepEqual(
        dropWrite.mock.calls.map((call) => call[2]),
        [51, 51],
      );
      const rows = await database.listRunTimelineEvents(ORGANIZATION, scope.triggerRunId, PAGE);
      assert.deepEqual(
        rows.slice(-2).map((row) => row.kind),
        ["truncated", "run_finished"],
      );
      assert.deepEqual(rows.at(-2)?.data, { dropped: 51 });
      const state = await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId);
      assert.equal(state?.droppedCount, 51);
      assert.equal(state?.sealedSeq, rows.at(-1)?.seq);
      assert.equal(queue.depth(), 0);
    } finally {
      release.resolve();
      await queue.flush();
    }
  });

  it("recovers rejected accounting after sealing without any later same-run activity", async () => {
    const { database, scope, bus } = await fixture();
    const failure = new Error("Drop accounting unavailable");
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);
    const reportFailure = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, {
      bus,
      now: () => new Date(0),
      reportFailure,
    });
    const notifications = vi.fn();
    const unsubscribe = bus.subscribe(scope.triggerRunId, notifications);
    try {
      queue.recordDrops(scope, 51);
      assert.equal(await queue.flush(), true);
      assert.equal(dropWrite.mock.calls.length, 1);
      assert.deepEqual(queue.accountingStats(), {
        queueEntries: 1,
        retainedEntries: 1,
        giveUps: 0,
        abandonedDrops: 0,
      });
      await queue.run(scope, async () => {
        await database.appendRunTimelineEvent({
          ...scope,
          kind: "run_finished",
          at: new Date(),
          data: { status: "succeeded" },
          origin: "captured",
        });
      });
      assert.equal(await queue.flush(), true);
      assert.equal(dropWrite.mock.calls.length, 2);
      assert.equal(reportFailure.mock.calls.length, 1);
      const sealed = await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId);
      assert.equal(sealed?.droppedCount, 0);
      assert.equal(sealed?.sealedSeq, 1);
      assert.equal(queue.depth(), 0);
      await vi.advanceTimersByTimeAsync(29_999);
      assert.equal(dropWrite.mock.calls.length, 2);
      await vi.advanceTimersByTimeAsync(1);
      assert.deepEqual(
        dropWrite.mock.calls.map((call) => call[2]),
        [51, 51, 51],
      );
      const recovered = await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId);
      assert.equal(recovered?.droppedCount, 51);
      assert.equal(recovered?.sealedSeq, sealed?.sealedSeq);
      assert.deepEqual(
        (await database.listRunTimelineEvents(ORGANIZATION, scope.triggerRunId, PAGE)).map(
          (row) => row.kind,
        ),
        ["run_finished"],
      );
      assert.equal(notifications.mock.calls.length, 0);
      assert.deepEqual(queue.accountingStats(), {
        queueEntries: 0,
        retainedEntries: 0,
        giveUps: 0,
        abandonedDrops: 0,
      });
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      unsubscribe();
      await queue.stop();
    }
  });

  it("recovers and reclaims 300 completed runs in one database across idle bounded sweeps", async () => {
    const { database, scope, bus, createScope } = await fixture();
    const scopes = [scope];
    for (let index = 1; index < 300; index++) scopes.push(await createScope());
    const record = database.recordRunTimelineDrops.bind(database);
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValue(new Error("Temporary accounting outage"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    try {
      for (const [index, runScope] of scopes.entries()) {
        queue.recordDrops(runScope, index + 1);
        await queue.run(runScope, async () => {
          await database.appendRunTimelineEvent({
            ...runScope,
            kind: "run_finished",
            at: new Date(),
            data: { status: "succeeded" },
            origin: "captured",
          });
        });
      }
      assert.equal(await queue.flush(), true);
      assert.equal(queue.depth(), 0);
      assert.equal(queue.accountingStats().queueEntries, 300);
      assert.equal(queue.accountingStats().retainedEntries, 300);
      dropWrite.mockImplementation(record);
      const attemptsBeforeRecovery = dropWrite.mock.calls.length;
      let recoveredBeforeYield = 0;
      setTimeout(() => {
        recoveredBeforeYield = dropWrite.mock.calls.length - attemptsBeforeRecovery;
      }, 30_000);
      await vi.advanceTimersByTimeAsync(30_010);
      assert.equal(recoveredBeforeYield, 100);
      for (const [index, runScope] of scopes.entries()) {
        const state = await database.readRunTimelineState(ORGANIZATION, runScope.triggerRunId);
        assert.equal(state?.droppedCount, index + 1);
        assert.equal(state?.sealedSeq, 1);
      }
      assert.deepEqual(queue.accountingStats(), {
        queueEntries: 0,
        retainedEntries: 0,
        giveUps: 0,
        abandonedDrops: 0,
      });
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await queue.stop();
    }
  });

  it("gives up after five scheduled rejections with visible abandoned drops and no retained timer", async () => {
    const { database, scope, bus } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const failure = new Error("Permanent accounting outage");
    const dropWrite = vi.spyOn(database, "recordRunTimelineDrops").mockRejectedValue(failure);
    const reportFailure = vi.fn();
    const queue = new RunTimelineQueue(database, {
      bus,
      now: () => new Date(performance.now()),
      reportFailure,
    });
    try {
      queue.recordDrops(scope, 51);
      assert.equal(await queue.flush(), true);
      for (let attempt = 1; attempt <= 4; attempt++) {
        await vi.advanceTimersByTimeAsync(30_000);
        assert.equal(dropWrite.mock.calls.length, attempt + 1);
        assert.equal(queue.accountingStats().retainedEntries, 1);
        assert.equal(queue.accountingStats().giveUps, 0);
      }
      await vi.advanceTimersByTimeAsync(30_000);
      assert.equal(dropWrite.mock.calls.length, 6);
      assert.deepEqual(queue.accountingStats(), {
        queueEntries: 0,
        retainedEntries: 0,
        giveUps: 1,
        abandonedDrops: 51,
      });
      assert.equal(reportFailure.mock.calls.length, 6);
      assert.match(String(reportFailure.mock.calls.at(-1)?.[0]), /batch abandoned/);
      assert.equal(vi.getTimerCount(), 0);
      await vi.advanceTimersByTimeAsync(300_000);
      assert.equal(dropWrite.mock.calls.length, 6);
    } finally {
      await queue.stop();
    }
  });

  it("keeps the original monotonic recovery deadline across normal wakes and wall-clock changes", async () => {
    const { database, scope, bus } = await fixture();
    const record = database.recordRunTimelineDrops.bind(database);
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValue(new Error("Accounting outage"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let now = 0;
    const queue = new RunTimelineQueue(database, { bus, now: () => new Date(now) });
    try {
      queue.recordDrops(scope, 3);
      assert.equal(await queue.flush(), true);
      await vi.advanceTimersByTimeAsync(10_000);
      now = 1_000_000;
      await queue.run(scope, async () => undefined);
      assert.equal(await queue.flush(), true);
      await vi.advanceTimersByTimeAsync(10_000);
      now = -1_000_000;
      await queue.run(scope, async () => undefined);
      assert.equal(await queue.flush(), true);
      assert.equal(dropWrite.mock.calls.length, 3);
      dropWrite.mockImplementation(record);
      await vi.advanceTimersByTimeAsync(9_999);
      assert.equal(dropWrite.mock.calls.length, 3);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(dropWrite.mock.calls.length, 4);
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
        3,
      );
      assert.equal(queue.accountingStats().queueEntries, 0);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await queue.stop();
    }
  });

  it("preserves new drops arriving during the exhausted accounting batch", async () => {
    const { database, scope, bus } = await fixture();
    const record = database.recordRunTimelineDrops.bind(database);
    const failure = new Error("Accounting outage");
    const dropWrite = vi.spyOn(database, "recordRunTimelineDrops").mockRejectedValue(failure);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      queue.recordDrops(scope, 3);
      assert.equal(await queue.flush(), true);
      await vi.advanceTimersByTimeAsync(120_000);
      assert.equal(dropWrite.mock.calls.length, 5);
      dropWrite.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      });
      dropWrite.mockImplementation(record);
      await vi.advanceTimersByTimeAsync(30_000);
      await entered.promise;
      queue.recordDrops(scope, 4);
      assert.equal(queue.accountingStats().retainedEntries, 1);
      release.resolve();
      assert.equal(await queue.flush(), true);
      assert.deepEqual(
        dropWrite.mock.calls.map((call) => call[2]),
        [3, 3, 3, 3, 3, 3, 4],
      );
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
        4,
      );
      assert.deepEqual(queue.accountingStats(), {
        queueEntries: 0,
        retainedEntries: 0,
        giveUps: 1,
        abandonedDrops: 3,
      });
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      release.resolve();
      await queue.stop();
    }
  });

  it("reclaims accounting when the persisted run reference has expired", async () => {
    const { database, scope, bus } = await fixture();
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValueOnce(new Error("Accounting outage"))
      .mockResolvedValueOnce(undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    try {
      queue.recordDrops(scope, 3);
      assert.equal(await queue.flush(), true);
      await vi.advanceTimersByTimeAsync(30_000);
      assert.equal(dropWrite.mock.calls.length, 2);
      assert.deepEqual(queue.accountingStats(), {
        queueEntries: 0,
        retainedEntries: 0,
        giveUps: 0,
        abandonedDrops: 0,
      });
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      await queue.stop();
    }
  });

  it("drains retained accounting during stop and permanently closes admission", async () => {
    const { database, scope, bus } = await fixture();
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValueOnce(new Error("Accounting outage"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    queue.recordDrops(scope, 3);
    assert.equal(await queue.flush(), true);
    assert.equal(await queue.stop(), true);
    assert.equal(dropWrite.mock.calls.length, 2);
    assert.equal(
      (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
      3,
    );
    assert.deepEqual(queue.accountingStats(), {
      queueEntries: 0,
      retainedEntries: 0,
      giveUps: 0,
      abandonedDrops: 0,
    });
    assert.equal(
      queue.enqueue(scope, async () => undefined),
      false,
    );
    await assert.rejects(
      queue.run(scope, async () => undefined),
      /closed/,
    );
    queue.recordDrops(scope, 4);
    await vi.advanceTimersByTimeAsync(300_000);
    assert.equal(dropWrite.mock.calls.length, 2);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("abandons rejected retained accounting on stop without leaving a recovery timer", async () => {
    const { database, scope, bus } = await fixture();
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValue(new Error("Accounting outage"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    queue.recordDrops(scope, 3);
    assert.equal(await queue.flush(), true);
    assert.equal(await queue.stop(), true);
    assert.equal(dropWrite.mock.calls.length, 2);
    assert.deepEqual(queue.accountingStats(), {
      queueEntries: 0,
      retainedEntries: 0,
      giveUps: 1,
      abandonedDrops: 3,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    assert.equal(dropWrite.mock.calls.length, 2);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("does not initiate an accounting retry when stop has zero drain budget", async () => {
    const { database, scope, bus } = await fixture();
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValue(new Error("Accounting outage"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    queue.recordDrops(scope, 3);
    assert.equal(await queue.flush(), true);
    const stopping = queue.stop(0);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(await stopping, false);
    assert.equal(dropWrite.mock.calls.length, 1);
    assert.deepEqual(queue.accountingStats(), {
      queueEntries: 0,
      retainedEntries: 0,
      giveUps: 1,
      abandonedDrops: 3,
    });
    assert.equal(vi.getTimerCount(), 0);
  });

  it("stops with no remaining budget without starting retained accounting or pending controls", async () => {
    const { database, scope, bus } = await fixture();
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValue(new Error("Accounting outage"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    queue.recordDrops(scope, 3);
    assert.equal(await queue.flush(), true);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const pending = vi.fn(async () => undefined);
    queue.enqueue(scope, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    queue.enqueue(scope, pending);
    const rejection = assert.rejects(queue.run(scope, pending), /deadline/);
    try {
      assert.equal(await queue.stop(0), false);
      await rejection;
      assert.equal(dropWrite.mock.calls.length, 1);
      assert.equal(queue.accountingStats().abandonedDrops, 3);
      release.resolve();
      assert.equal(await queue.flush(), true);
      assert.equal(pending.mock.calls.length, 0);
      assert.equal(queue.accountingStats().queueEntries, 0);
      await vi.advanceTimersByTimeAsync(300_000);
      assert.equal(dropWrite.mock.calls.length, 1);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      release.resolve();
      await queue.stop(0);
    }
  });

  it("does not retry an unresolved accounting write after a stop deadline", async () => {
    const { database, scope, bus } = await fixture();
    const record = database.recordRunTimelineDrops.bind(database);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return record(...args);
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new RunTimelineQueue(database, { bus });
    queue.recordDrops(scope, 3);
    await entered.promise;
    try {
      const control = vi.fn(async () => undefined);
      const rejection = assert.rejects(queue.run(scope, control), /deadline/);
      assert.equal(queue.accountingStats().retainedEntries, 1);
      const stopping = queue.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      assert.equal(await stopping, false);
      await rejection;
      assert.equal(control.mock.calls.length, 0);
      assert.equal(
        queue.enqueue(scope, async () => undefined),
        false,
      );
      await assert.rejects(
        queue.run(scope, async () => undefined),
        /closed/,
      );
      await vi.advanceTimersByTimeAsync(300_000);
      assert.equal(dropWrite.mock.calls.length, 1);
      assert.equal(queue.accountingStats().retainedEntries, 1);
      assert.equal(vi.getTimerCount(), 0);
      release.resolve();
      assert.equal(await queue.flush(), true);
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
        3,
      );
      assert.deepEqual(queue.accountingStats(), {
        queueEntries: 0,
        retainedEntries: 0,
        giveUps: 0,
        abandonedDrops: 0,
      });
    } finally {
      release.resolve();
      await queue.stop(0);
    }
  });

  it("keeps later drops separate from the retried batch and accounts for both before the next control", async () => {
    const { database, scope, bus } = await fixture();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const dropWrite = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw new Error("Drop accounting unavailable");
      });
    const queue = new RunTimelineQueue(database, { bus });
    let control: Promise<void> | undefined;
    try {
      queue.recordDrops(scope, 3);
      await entered.promise;
      queue.recordDrops(scope, 4);
      control = queue.run(scope, async () => {
        assert.equal(
          (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
          7,
        );
      });
      release.resolve();
      await control;
      assert.equal(await queue.flush(), true);
      assert.deepEqual(
        dropWrite.mock.calls.map((call) => call[2]),
        [3, 3, 4],
      );
      assert.equal(dropWrite.mock.calls[0]?.[4], dropWrite.mock.calls[1]?.[4]);
      assert.notEqual(dropWrite.mock.calls[1]?.[4], dropWrite.mock.calls[2]?.[4]);
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, scope.triggerRunId))?.droppedCount,
        7,
      );
      assert.equal(queue.depth(), 0);
    } finally {
      release.resolve();
      await control?.catch(() => undefined);
      await queue.flush();
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
