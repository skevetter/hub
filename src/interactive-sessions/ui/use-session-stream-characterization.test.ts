import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../functions.js";
import type { useSessionStream as useStream } from "./use-session-stream.js";

type StreamHook = typeof useStream;
type LiveView = ReturnType<StreamHook>["view"];

const hooks = vi.hoisted(() => ({
  order: [] as string[],
  effects: [] as (() => () => void)[],
  snapshot: (): LiveView | undefined => undefined,
  readSession: vi.fn<() => Promise<unknown>>(),
  readHistory: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("react", () => ({
  useState: (create: () => unknown) => {
    hooks.order.push("state");
    return [create()];
  },
  useEffect: (effect: () => () => void) => {
    hooks.order.push("effect");
    hooks.effects.push(effect);
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => LiveView) => {
    hooks.order.push("store");
    hooks.snapshot = getSnapshot;
    return getSnapshot();
  },
  useMemo: (create: () => unknown) => {
    hooks.order.push("memo");
    return create();
  },
}));
vi.mock("../functions.js", () => ({
  readInteractiveSession: hooks.readSession,
  readSessionHistory: hooks.readHistory,
}));

const initial: SessionSnapshot = {
  session: {
    id: "fixture",
    title: "Session",
    state: "starting",
    stateReason: null,
    generation: 1,
    turn: 1,
    profile: { id: "profile", name: "Profile" },
    daemon: { id: "daemon", slug: "daemon", connection: "online" },
    provider: "codex",
    model: null,
    mode: null,
    startedBy: null,
    createdAt: "2026-11-20T00:00:00Z",
    lastActivityAt: "2026-11-20T00:00:00Z",
    closedAt: null,
  },
  hubSeq: 1,
  messages: [],
  participants: [],
  capabilities: {
    send: true,
    close: true,
    stop: true,
    replaceAgent: true,
    manageParticipants: true,
  },
};

class FakeSource extends EventTarget {
  static readonly opened: FakeSource[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeSource.opened.push(this);
  }
  close() {
    this.closed = true;
  }
  frame(type: string, data: unknown, lastEventId = "1") {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId }));
  }
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  FakeSource.opened.length = 0;
  vi.unstubAllGlobals();
});

async function setup() {
  hooks.order.length = 0;
  hooks.effects.length = 0;
  hooks.readSession.mockReset();
  hooks.readHistory.mockReset();
  hooks.readHistory.mockResolvedValue({
    status: "ok",
    data: {
      epoch: "epoch",
      startCursor: null,
      endCursor: null,
      hasOlder: false,
      entries: [],
    },
  });
  vi.stubGlobal("EventSource", FakeSource);
  const { useSessionStream } = await import("./use-session-stream.js");
  const rendered = RenderStream({ useSessionStream });
  expect(hooks.order).toEqual(["state", "effect", "store", "memo"]);
  stop = hooks.effects[0]?.();
  const source = FakeSource.opened[0];
  if (source === undefined) throw new Error("Missing stream");
  return { ...rendered, source, view: currentView };
}

function RenderStream({ useSessionStream }: { useSessionStream: StreamHook }) {
  return useSessionStream("org", initial);
}

function currentView(): LiveView {
  const view = hooks.snapshot();
  if (view === undefined) throw new Error("Missing stream view");
  return view;
}

describe("session stream view and event order", () => {
  it("keeps startup replay quiet, projects gaps and ignores stale state frames", async () => {
    const { source, view } = await setup();
    expect(source.url).toContain("?organization=org&after=1");
    source.frame("gap", { reason: "behind" });
    expect(view().missedUpdates).toBe(false);
    source.frame("gap", { reason: "daemon_disconnected" });
    expect(view().missedUpdates).toBe(true);
    source.frame("state", { state: "idle", stateReason: null, generation: 1, turn: 1 }, "1");
    expect(view().snapshot?.session.state).toBe("starting");
    source.frame("state", { state: "idle", stateReason: null, generation: 1, turn: 1 }, "2");
    expect(view().snapshot?.hubSeq).toBe(2);
    expect(view().announcement).toBe("The agent's turn ended.");
    await Promise.resolve();
    expect(view().boundaries).toMatchObject([
      { label: "Some live updates were missed. Reloaded." },
    ]);
  });

  it("keeps newer daemon presence when a snapshot returns and clears a missing session", async () => {
    const { source, view, refresh } = await setup();
    const pending = Promise.withResolvers<unknown>();
    hooks.readSession.mockReturnValueOnce(pending.promise);
    const refreshed = refresh();
    source.frame("connection", { daemon: "offline" });
    pending.resolve({ status: "ok", data: { ...initial, hubSeq: 3 } });
    expect(await refreshed).toBe(true);
    expect(view().snapshot?.session.daemon.connection).toBe("offline");
    expect(view().history).toBe("daemon_offline");
    hooks.readSession.mockResolvedValueOnce({
      status: "ok",
      data: { outcome: "refused", code: "not_found" },
    });
    expect(await refresh()).toBe(false);
    expect(view().snapshot).toBeNull();
    expect(source.closed).toBe(true);
  });
});
