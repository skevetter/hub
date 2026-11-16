import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { RunTimelineBus, type RunTimelineNotification } from "./bus.js";

describe("RunTimelineBus", () => {
  it("synchronously notifies only the requested run in publication order", () => {
    const bus = new RunTimelineBus();
    const received: RunTimelineNotification[] = [];
    const other = vi.fn();
    bus.subscribe("run-a", (notification) => {
      received.push(notification);
    });
    bus.subscribe("run-b", other);

    bus.publish("run-a", 1);
    assert.deepEqual(received, [{ runId: "run-a", seq: 1 }]);
    bus.publish("run-a", 3);
    assert.deepEqual(received, [
      { runId: "run-a", seq: 1 },
      { runId: "run-a", seq: 3 },
    ]);
    assert.equal(other.mock.calls.length, 0);
  });

  it("does not replay notifications or retain them for future subscriptions", () => {
    const bus = new RunTimelineBus();
    bus.publish("run-a", 1);
    const listener = vi.fn();
    bus.subscribe("run-a", listener);
    assert.equal(listener.mock.calls.length, 0);
    bus.publish("run-a", 2);
    assert.deepEqual(listener.mock.calls, [[{ runId: "run-a", seq: 2 }]]);
  });

  it("unsubscribes idempotently and releases capacity across runs", () => {
    const bus = new RunTimelineBus({ maxSubscriptions: 1 });
    const first = vi.fn();
    const unsubscribe = bus.subscribe("run-a", first);
    assert.throws(() => bus.subscribe("run-b", vi.fn()), /subscription limit/);
    unsubscribe();
    unsubscribe();
    const second = vi.fn();
    const unsubscribeSecond = bus.subscribe("run-a", second);
    unsubscribe();
    bus.publish("run-a", 1);
    assert.equal(first.mock.calls.length, 0);
    assert.equal(second.mock.calls.length, 1);
    unsubscribeSecond();
    bus.subscribe("run-b", first);
    bus.publish("run-b", 2);
    assert.equal(first.mock.calls.length, 1);
  });

  it("treats repeated subscriptions of the same listener independently", () => {
    const bus = new RunTimelineBus({ maxSubscriptions: 2 });
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("run-a", listener);
    bus.subscribe("run-a", listener);
    bus.publish("run-a", 1);
    assert.equal(listener.mock.calls.length, 2);
    unsubscribe();
    bus.publish("run-a", 2);
    assert.equal(listener.mock.calls.length, 3);
  });

  it("isolates listener and reporter failures without changing the notification", () => {
    const error = new Error("listener failed");
    const reportFailure = vi.fn((cause: unknown) => {
      throw new Error("reporter failed", { cause });
    });
    const bus = new RunTimelineBus({ reportFailure });
    bus.subscribe("run-a", () => {
      throw error;
    });
    bus.subscribe("run-a", (notification) => {
      Object.assign(notification, { seq: 100 });
    });
    const healthy = vi.fn();
    bus.subscribe("run-a", healthy);
    assert.doesNotThrow(() => bus.publish("run-a", 1));
    assert.equal(reportFailure.mock.calls.length, 2);
    assert.equal(reportFailure.mock.calls[0]![0], error);
    assert.deepEqual(healthy.mock.calls, [[{ runId: "run-a", seq: 1 }]]);
  });

  it("honors unsubscription during publication and defers new subscribers", () => {
    const bus = new RunTimelineBus();
    const later = vi.fn();
    const removed = vi.fn();
    let unsubscribeRemoved = () => {};
    let added = false;
    bus.subscribe("run-a", () => {
      unsubscribeRemoved();
      if (!added) {
        added = true;
        bus.subscribe("run-a", later);
      }
    });
    unsubscribeRemoved = bus.subscribe("run-a", removed);
    bus.publish("run-a", 1);
    assert.equal(removed.mock.calls.length, 0);
    assert.equal(later.mock.calls.length, 0);
    bus.publish("run-a", 2);
    assert.deepEqual(later.mock.calls, [[{ runId: "run-a", seq: 2 }]]);
  });

  it("reports rejected listeners without delaying other notifications", async () => {
    const failure = new Error("asynchronous listener failed");
    const reportFailure = vi.fn();
    const bus = new RunTimelineBus({ reportFailure });
    bus.subscribe("run-a", async () => {
      throw failure;
    });
    const healthy = vi.fn();
    bus.subscribe("run-a", healthy);
    bus.publish("run-a", 1);
    assert.deepEqual(healthy.mock.calls, [[{ runId: "run-a", seq: 1 }]]);
    await Promise.resolve();
    assert.deepEqual(reportFailure.mock.calls, [[failure]]);
  });

  it("coalesces more than 100000 publications without adding promise reactions", async () => {
    const { promise: stalled, resolve } = Promise.withResolvers<void>();
    const reactions = vi.spyOn(stalled, "then");
    const received: RunTimelineNotification[] = [];
    const listener = (notification: RunTimelineNotification) => {
      received.push(notification);
      return received.length === 1 ? stalled : undefined;
    };
    const bus = new RunTimelineBus({ maxSubscriptions: 1 });
    bus.subscribe("run-a", listener);

    bus.publish("run-a", 1);
    for (let seq = 2; seq <= 100002; seq += 1) {
      bus.publish("run-a", seq);
    }

    assert.equal(received.length, 1);
    assert.equal(reactions.mock.calls.length, 1);
    assert.equal(reactions.mock.calls[0]!.length, 2);
    assert.equal(typeof reactions.mock.calls[0]![0], "function");
    assert.equal(typeof reactions.mock.calls[0]![1], "function");
    resolve();
    await Promise.resolve();
    assert.deepEqual(received, [
      { runId: "run-a", seq: 1 },
      { runId: "run-a", seq: 100002 },
    ]);
    assert.equal(Object.isFrozen(received[1]), true);
    assert.equal(reactions.mock.calls.length, 1);
    bus.publish("run-a", 100003);
    assert.equal(received.at(-1)!.seq, 100003);
  });

  it("reports one rejection and delivers only the latest pending publication", async () => {
    const { promise: stalled, reject } = Promise.withResolvers<void>();
    const reactions = vi.spyOn(stalled, "then");
    const failure = new Error("asynchronous listener failed");
    const reportFailure = vi.fn(() => {
      throw new Error("reporter failed");
    });
    const bus = new RunTimelineBus({ reportFailure });
    const received: RunTimelineNotification[] = [];
    bus.subscribe("run-a", (notification) => {
      received.push(notification);
      return received.length === 1 ? stalled : undefined;
    });
    bus.publish("run-a", 1);
    bus.publish("run-a", 2);
    bus.publish("run-a", 3);

    reject(failure);
    await Promise.resolve();

    assert.deepEqual(reportFailure.mock.calls, [[failure]]);
    assert.equal(reactions.mock.calls.length, 1);
    assert.deepEqual(received, [
      { runId: "run-a", seq: 1 },
      { runId: "run-a", seq: 3 },
    ]);
    bus.publish("run-a", 4);
    assert.equal(received.at(-1)!.seq, 4);
  });

  it.each(["resolve", "reject"] as const)(
    "discards pending delivery after unsubscribe before %s and reuses capacity",
    async (settlement) => {
      const { promise: stalled, resolve, reject } = Promise.withResolvers<void>();
      const failure = new Error("unsubscribed listener failed");
      const reportFailure = vi.fn();
      const bus = new RunTimelineBus({ maxSubscriptions: 1, reportFailure });
      const listener = vi.fn(() => stalled);
      const unsubscribe = bus.subscribe("run-a", listener);
      bus.publish("run-a", 1);
      bus.publish("run-a", 2);
      unsubscribe();
      unsubscribe();
      const replacement = vi.fn();
      bus.subscribe("run-a", replacement);
      bus.publish("run-a", 3);
      assert.deepEqual(replacement.mock.calls, [[{ runId: "run-a", seq: 3 }]]);

      if (settlement === "resolve") resolve();
      else reject(failure);
      await Promise.resolve();

      assert.equal(listener.mock.calls.length, 1);
      assert.deepEqual(replacement.mock.calls, [[{ runId: "run-a", seq: 3 }]]);
      assert.deepEqual(reportFailure.mock.calls, settlement === "reject" ? [[failure]] : []);
      bus.publish("run-a", 4);
      assert.equal(replacement.mock.calls.length, 2);
    },
  );

  it("coalesces asynchronous repeated subscriptions independently", async () => {
    const { promise: stalled, resolve } = Promise.withResolvers<void>();
    const reactions = vi.spyOn(stalled, "then");
    const received: RunTimelineNotification[] = [];
    const listener = (notification: RunTimelineNotification) => {
      received.push(notification);
      return stalled;
    };
    const bus = new RunTimelineBus({ maxSubscriptions: 2 });
    const unsubscribe = bus.subscribe("run-a", listener);
    bus.subscribe("run-a", listener);
    bus.publish("run-a", 1);
    bus.publish("run-a", 2);
    assert.equal(received.length, 2);
    assert.equal(reactions.mock.calls.length, 2);
    unsubscribe();
    resolve();
    await Promise.resolve();

    assert.deepEqual(received, [
      { runId: "run-a", seq: 1 },
      { runId: "run-a", seq: 1 },
      { runId: "run-a", seq: 2 },
    ]);
    assert.equal(reactions.mock.calls.length, 3);
    await Promise.resolve();
    assert.equal(received.length, 3);
  });

  it("defers and coalesces synchronous reentrant publications without nesting listeners", async () => {
    const bus = new RunTimelineBus();
    const received: RunTimelineNotification[] = [];
    let depth = 0;
    let maxDepth = 0;
    bus.subscribe("run-a", (notification) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      received.push(notification);
      if (notification.seq === 1) {
        for (let seq = 2; seq <= 100002; seq += 1) {
          bus.publish("run-a", seq);
        }
      }
      depth -= 1;
    });
    bus.publish("run-a", 1);
    assert.deepEqual(received, [{ runId: "run-a", seq: 1 }]);
    bus.publish("run-a", 100003);
    await Promise.resolve();

    assert.equal(maxDepth, 1);
    assert.deepEqual(received, [
      { runId: "run-a", seq: 1 },
      { runId: "run-a", seq: 100003 },
    ]);
  });

  it("bounds reentrant publications before an asynchronous listener returns its promise", async () => {
    const { promise: stalled, resolve } = Promise.withResolvers<void>();
    const reactions = vi.spyOn(stalled, "then");
    const bus = new RunTimelineBus();
    const received: RunTimelineNotification[] = [];
    const listener = (notification: RunTimelineNotification) => {
      received.push(notification);
      if (notification.seq !== 1) return undefined;
      for (let seq = 2; seq <= 100002; seq += 1) {
        bus.publish("run-a", seq);
      }
      return stalled;
    };
    bus.subscribe("run-a", listener);
    bus.publish("run-a", 1);
    assert.equal(received.length, 1);
    assert.equal(reactions.mock.calls.length, 1);
    resolve();
    await Promise.resolve();

    assert.deepEqual(received, [
      { runId: "run-a", seq: 1 },
      { runId: "run-a", seq: 100002 },
    ]);
    assert.equal(reactions.mock.calls.length, 1);
  });

  it("discards a queued synchronous reentrant wake on unsubscribe", async () => {
    const bus = new RunTimelineBus({ maxSubscriptions: 1 });
    const listener = vi.fn((notification: RunTimelineNotification) => {
      bus.publish("run-a", notification.seq + 1);
    });
    const unsubscribe = bus.subscribe("run-a", listener);
    bus.publish("run-a", 1);
    unsubscribe();
    const replacement = vi.fn();
    bus.subscribe("run-a", replacement);
    await Promise.resolve();

    assert.equal(listener.mock.calls.length, 1);
    assert.equal(replacement.mock.calls.length, 0);
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid subscription limit %s",
    (maxSubscriptions) => {
      assert.throws(() => new RunTimelineBus({ maxSubscriptions }), RangeError);
    },
  );
});
