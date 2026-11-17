import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, it, vi } from "vitest";
import type * as ReactStart from "@tanstack/react-start";
import {
  RunEventSubscription,
  pollOmittedSteps,
  type RunEventSource,
} from "./run-event-subscription.js";
import { useRunEvents } from "./use-run-events.js";
import { emptyTimeline, runEvent } from "./test-utils/run-detail.js";
import { timelineRows } from "./run-timeline-view.js";
import type { RunEventPage } from "./run-events.js";
vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));

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
function fixture(initial: RunEventPage = emptyTimeline, status = 200) {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  const seal = vi.fn();
  const subscription = new RunEventSubscription({
    initial,
    after: 0,
    url: "/api/v1/runs/run/events?organization=acme",
    source: (url) => {
      urls.push(url);
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    },
    probe: async () => status,
    onSeal: seal,
  });
  subscription.start();
  return { subscription, sources, urls, seal };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("run event subscription", () => {
  it("orders and deduplicates replay and merges calls within a step only", () => {
    const { subscription, sources } = fixture();
    const source = sources.at(0)!;
    source.emit("open");
    source.emit(
      "tool_started",
      runEvent(2, "tool_started", { callId: "one", tool: "Bash", category: "command" }),
    );
    source.emit("run_started", runEvent(1, "run_started"));
    source.emit(
      "tool_finished",
      runEvent(3, "tool_finished", {
        callId: "one",
        tool: "Bash",
        category: "command",
        status: "completed",
      }),
    );
    source.emit(
      "tool_finished",
      runEvent(3, "tool_finished", {
        callId: "one",
        tool: "Bash",
        category: "command",
        status: "completed",
      }),
    );
    source.emit(
      "tool_started",
      runEvent(
        4,
        "tool_started",
        { callId: "one", tool: "Read", category: "read" },
        "another-step",
      ),
    );
    assert.deepEqual(
      subscription.snapshot().events.map((row) => row.seq),
      [1, 2, 3, 4],
    );
    const tools = timelineRows(subscription.snapshot().events, 0).filter((row) => row.tool);
    assert.equal(tools.length, 2);
    assert.equal(tools[0]?.detail, "Bash - completed - review");
    assert.equal(tools[1]?.key, "another-step\0one");
    assert.equal(subscription.snapshot().connection, "Live");
    subscription.stop();
    assert.equal(source.closed, true);
  });

  it("stops at a delivered seal and refetches the snapshot once", () => {
    const { subscription, sources, seal } = fixture();
    sources.at(0)!.emit("status", {
      status: "failed",
      sealedSeq: 2,
      stepRowsOmitted: 4,
      origin: "captured",
    });
    sources.at(0)!.emit("run_started", runEvent(1, "run_started"));
    assert.equal(subscription.snapshot().connection, "Live");
    sources.at(0)!.emit("run_finished", runEvent(2, "run_finished", { status: "failed" }));
    sources.at(0)!.emit("end", { status: "failed", sealedSeq: 2, stepRowsOmitted: 4 });
    assert.equal(sources.at(0)!.closed, true);
    assert.equal(subscription.snapshot().connection, null);
    assert.equal(subscription.snapshot().stepRowsOmitted, 4);
    assert.equal(seal.mock.calls.length, 1);
    subscription.stop();
  });

  it("handles end by closing and invalidating, without ending on terminal status alone", () => {
    const { subscription, sources, seal } = fixture();
    sources.at(0)!.emit("status", {
      status: "succeeded",
      sealedSeq: null,
      stepRowsOmitted: 0,
      origin: "derived",
    });
    assert.equal(sources.at(0)!.closed, false);
    sources.at(0)!.emit("run_finished", runEvent(1, "run_finished", { status: "succeeded" }));
    sources.at(0)!.emit("end", { status: "succeeded", sealedSeq: 1, stepRowsOmitted: 0 });
    assert.equal(subscription.snapshot().origin, "derived");
    assert.equal(subscription.snapshot().connection, null);
    assert.equal(seal.mock.calls.length, 1);
    subscription.stop();
  });

  it("falls back after three consecutive failures and polls past terminal status until the seal is read", async () => {
    const { subscription, sources, seal } = fixture();
    for (let index = 0; index < 3; index += 1) sources.at(0)!.emit("error");
    await Promise.resolve();
    assert.equal(subscription.snapshot().connection, "Polling");
    assert.equal(sources.at(0)!.closed, true);
    subscription.acceptPage({
      ...emptyTimeline,
      status: "failed",
      events: [runEvent(1, "run_started")],
    });
    assert.equal(subscription.snapshot().connection, "Polling");
    assert.equal(seal.mock.calls.length, 0);
    subscription.acceptPage({
      ...emptyTimeline,
      status: "failed",
      sealedSeq: 3,
      events: [runEvent(2, "step_finished", { status: "failed" })],
      stepRowsOmitted: 2,
    });
    assert.equal(subscription.snapshot().connection, "Polling");
    subscription.acceptPage({
      ...emptyTimeline,
      status: "failed",
      sealedSeq: 3,
      events: [runEvent(3, "run_finished", { status: "failed" })],
    });
    assert.equal(subscription.snapshot().connection, null);
    assert.equal(seal.mock.calls.length, 1);
    subscription.stop();
  });

  it("switches immediately on a 404 probe and stops on a 410 without rows", async () => {
    const off = fixture(emptyTimeline, 404);
    off.sources.at(0)!.emit("error");
    await Promise.resolve();
    assert.equal(off.subscription.snapshot().connection, "Polling");
    off.subscription.stop();
    const expired = fixture({ ...emptyTimeline, events: [runEvent(1, "run_started")] }, 410);
    expired.sources.at(0)!.emit("error");
    await Promise.resolve();
    assert.equal(expired.subscription.snapshot().expired, true);
    assert.deepEqual(expired.subscription.snapshot().events, []);
    assert.equal(expired.subscription.snapshot().connection, null);
    expired.subscription.stop();
  });

  it("resets consecutive failures on successful connection and resumes control reconnects after the cursor", async () => {
    vi.useFakeTimers();
    const { subscription, sources, urls } = fixture();
    sources.at(0)!.emit("error");
    sources.at(0)!.emit("error");
    sources.at(0)!.emit("open");
    sources.at(0)!.emit("error");
    assert.equal(subscription.snapshot().connection, "Reconnecting");
    sources.at(0)!.emit("run_started", runEvent(1, "run_started"));
    sources.at(0)!.emit("shutdown");
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(urls[1], "/api/v1/runs/run/events?organization=acme&after=1");
    sources.at(1)!.emit("reconnect");
    subscription.stop();
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(sources.length, 2);
  });

  it("captures polling expiry and stored provenance and refreshes omitted steps every ten seconds", async () => {
    vi.useFakeTimers();
    const { subscription, seal } = fixture({ ...emptyTimeline, streamEnabled: false });
    subscription.acceptPage({
      ...emptyTimeline,
      streamEnabled: false,
      origin: "derived",
      stepRowsOmitted: 12,
    });
    assert.equal(subscription.snapshot().origin, "derived");
    assert.equal(subscription.snapshot().stepRowsOmitted, 12);
    const refresh = vi.fn();
    const stop = pollOmittedSteps(refresh);
    await vi.advanceTimersByTimeAsync(20000);
    assert.equal(refresh.mock.calls.length, 2);
    stop();
    subscription.acceptPage({ ...emptyTimeline, expired: true, events: [], origin: "captured" });
    assert.equal(subscription.snapshot().origin, "captured");
    assert.equal(subscription.snapshot().connection, null);
    assert.equal(seal.mock.calls.length, 1);
    subscription.stop();
  });

  it("never restores expired events from a stale in-flight page", () => {
    const { subscription, sources } = fixture({
      ...emptyTimeline,
      expired: true,
      events: [runEvent(1, "run_started")],
    });
    assert.equal(sources.length, 0);
    subscription.acceptPage({ ...emptyTimeline, events: [runEvent(1, "run_started")] });
    assert.deepEqual(subscription.snapshot().events, []);
    assert.equal(subscription.snapshot().connection, null);
    subscription.stop();
  });

  it("never constructs EventSource during server rendering", () => {
    const createSource = vi.fn(() => {
      throw new Error("source created during SSR");
    });
    vi.stubGlobal("EventSource", createSource);
    const client = new QueryClient();
    function ServerView() {
      const state = useRunEvents({
        organizationSlug: "acme",
        runId: "run",
        after: 0,
        initial: emptyTimeline,
        stepCount: 101,
      });
      return <span>{state.connection}</span>;
    }
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ServerView />
      </QueryClientProvider>,
    );
    assert.match(markup, /Reconnecting/u);
    assert.equal(createSource.mock.calls.length, 0);
    client.clear();
  });
});
