import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { RunEventSubscription, type RunEventSource } from "./run-event-subscription.js";
import { emptyTimeline, runEvent } from "./test-utils/run-detail.js";

class FakeEventSource implements RunEventSource {
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  addEventListener(kind: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(kind, listener);
  }
  close() {
    this.closed = true;
  }
  emit(kind: string, data: unknown = {}) {
    this.listeners.get(kind)?.(new MessageEvent<string>(kind, { data: JSON.stringify(data) }));
  }
}
function fixture() {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  const subscription = new RunEventSubscription({
    initial: emptyTimeline,
    initialSequence: 0,
    after: 0,
    url: "/api/v1/runs/run/events?organization=acme",
    source: (url) => {
      urls.push(url);
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
    probe: async () => 200,
    onSeal: vi.fn(),
  });
  subscription.start();
  return { subscription, sources, urls };
}
afterEach(() => vi.useRealTimers());

describe("subscription lifecycle", () => {
  it("ignores malformed frames and resumes after the highest row even with a gap", async () => {
    vi.useFakeTimers();
    const { subscription, sources, urls } = fixture();
    const source = sources.at(0);
    assert.ok(source);
    const before = subscription.snapshot();
    source.listeners.get("status")?.(new MessageEvent("status", { data: "{" }));
    source.emit("run_started", { seq: 1 });
    assert.equal(subscription.snapshot(), before);

    source.emit("run_started", runEvent(3, "run_started"));
    source.emit("shutdown");
    source.emit("run_started", runEvent(4, "run_started"));
    await vi.advanceTimersByTimeAsync(4999);
    assert.equal(sources.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(urls[1], "/api/v1/runs/run/events?organization=acme&after=3");
    const resumed = sources.at(1);
    assert.ok(resumed);
    resumed.emit("run_started", runEvent(1, "run_started"));
    resumed.emit("run_started", runEvent(3, "run_started", { replay: true }));
    assert.deepEqual(subscription.snapshot().events, [
      runEvent(1, "run_started"),
      runEvent(3, "run_started"),
    ]);
    subscription.stop();
  });

  it("lets listeners unsubscribe and aborts the pending probe on cleanup", async () => {
    const response = Promise.withResolvers<number>();
    const source = new FakeEventSource();
    const probe = vi.fn((_url: string, _signal: AbortSignal) => response.promise);
    const seal = vi.fn();
    const subscription = new RunEventSubscription({
      initial: emptyTimeline,
      initialSequence: 0,
      after: 7,
      url: "/events?organization=acme",
      source: () => source,
      probe,
      onSeal: seal,
    });
    const unmount = subscription.start();
    const listener = vi.fn();
    const unsubscribe = subscription.subscribe(listener);
    source.emit("open");
    unsubscribe();
    source.emit("error");
    source.emit("error");
    assert.equal(listener.mock.calls.length, 1);
    assert.equal(probe.mock.calls.length, 1);
    const call = probe.mock.calls.at(0);
    assert.ok(call);
    assert.equal(call[0], "/events?organization=acme&after=7");
    const before = subscription.snapshot();

    unmount();
    assert.equal(source.closed, true);
    assert.equal(call[1].aborted, true);
    response.resolve(410);
    await response.promise;
    assert.equal(subscription.snapshot(), before);
    assert.equal(seal.mock.calls.length, 0);
  });

  it("swallows probe rejection and resets failures after valid status", async () => {
    const failure = new Error("probe failed");
    const source = new FakeEventSource();
    const probe = vi.fn(async () => {
      throw failure;
    });
    const subscription = new RunEventSubscription({
      initial: emptyTimeline,
      initialSequence: 0,
      after: 0,
      url: "/events?organization=acme",
      source: () => source,
      probe,
      onSeal: vi.fn(),
    });
    subscription.start();
    try {
      source.emit("error");
      source.emit("error");
      await new Promise<void>((resolve) => setImmediate(resolve));
      source.emit("status", { status: "running", sealedSeq: null, stepRowsOmitted: 0 });
      source.emit("error");
      assert.equal(probe.mock.calls.length, 2);
      assert.equal(subscription.snapshot().connection, "Reconnecting");
      assert.equal(source.closed, false);
    } finally {
      subscription.stop();
    }
  });
});
