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

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid subscription limit %s",
    (maxSubscriptions) => {
      assert.throws(() => new RunTimelineBus({ maxSubscriptions }), RangeError);
    },
  );
});
