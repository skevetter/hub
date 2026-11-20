import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRunProgressSettings } from "../run-progress/settings.js";
import { SessionEventBus } from "./bus.js";
import { InteractiveSessionStream } from "./stream.js";
import type { SessionStreamSource } from "./stream-subscriber.js";
import type { SessionEventRecord, SessionPrincipal } from "./types.js";

const sessionId = randomUUID();
const principal = { organizationId: "org", userId: "viewer", role: "member" as const };
const epoch = "test:epoch";
const now = new Date("2026-11-20T00:00:00Z");

function state(seq: number): SessionEventRecord {
  return {
    sessionId,
    organizationId: "org",
    kind: "state",
    commandId: null,
    at: now,
    seq,
    data: { state: "running", stateReason: null, generation: 1, turn: seq },
  };
}

function agent(seq: number, agentEpoch = epoch, text = "assistant fixture") {
  return {
    kind: "agent" as const,
    epoch: agentEpoch,
    item: { kind: "assistant" as const, seq, text, truncated: false, at: now.toISOString() },
  };
}

function setup() {
  const bus = new SessionEventBus();
  const rows: SessionEventRecord[] = [];
  const removed = new Set<string>();
  const source = {
    authorizeStream: vi.fn(async (request: Request) => {
      const userId = request.headers.get("cookie") ?? "viewer";
      return removed.has(userId) ? ("not_found" as const) : { ...principal, userId };
    }),
    streamEvents: vi.fn(
      async (_principal: SessionPrincipal, _id: string, after: number, limit: number) =>
        rows.filter((row) => row.seq > after).slice(0, limit),
    ),
    streamEventData: vi.fn<SessionStreamSource["streamEventData"]>(async (_principal, event) =>
      event.kind === "state" ? event.data : undefined,
    ),
    streamCatchUp: vi.fn(
      async (
        _principal: SessionPrincipal,
        _id: string,
        cursor: { epoch: string; seq: number },
      ) => ({
        epoch: cursor.epoch,
        items: [agent(2).item, agent(3).item],
        hasNewer: false,
      }),
    ),
  };
  const stream = new InteractiveSessionStream({
    service: source,
    bus,
    settings: readRunProgressSettings({}),
  });
  streams.add(stream);
  const open = (after = "0", userId = "viewer", request?: Request) =>
    stream.handle(
      request ??
        new Request("https://hub.test/events?organization=org&after=" + encodeURIComponent(after), {
          headers: { cookie: userId },
        }),
      sessionId,
    );
  return { bus, stream, open, rows, source, removed };
}

const streams = new Set<InteractiveSessionStream>();
afterEach(async () => {
  for (const stream of streams) await stream.beginShutdown();
  streams.clear();
});

function read(response: Response) {
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  return {
    next: async () => {
      for (;;) {
        const { value } = await reader.read();
        if (value === undefined) return null;
        const frame = new TextDecoder().decode(value);
        if (!frame.startsWith(":")) return frame;
      }
    },
    cancel: () => reader.cancel(),
  };
}

describe("interactive session stream", () => {
  it("replays the remaining text of a daemon chunk after a partial live cursor", async () => {
    const { bus, open, source } = setup();
    const first = read(await open());
    const frame = agent(4, epoch, "prefix");
    bus.publish(sessionId, { ...frame, item: { ...frame.item, chunkOffset: 6 } });
    expect(await first.next()).toContain(`id: 0:4.6:${epoch}`);
    await first.cancel();
    const suffix = agent(4, epoch, " suffix");
    bus.publish(sessionId, { ...suffix, item: { ...suffix.item, chunkStart: 6 } });
    const resumed = read(
      await open(
        "0",
        "viewer",
        new Request("https://hub.test/events?organization=org", {
          headers: { cookie: "viewer", "last-event-id": `0:4.6:${epoch}` },
        }),
      ),
    );
    const remainder = await resumed.next();
    expect(remainder).toContain(`id: 0:4:${epoch}`);
    expect(remainder).toContain('"text":" suffix"');
    expect(source.streamCatchUp).not.toHaveBeenCalled();
    await resumed.cancel();
  });
  it("replays durable Hub events after the cursor before relaying buffered live items", async () => {
    const { bus, rows, open } = setup();
    rows.push(state(1), state(2), state(3));
    const reader = read(await open("1:7:" + epoch));
    bus.publish(sessionId, agent(8));
    const replay = await reader.next();
    expect(replay).toContain("id: 2:7:" + epoch + "\nevent: state");
    expect(replay).toContain('"turn":2');
    expect(await reader.next()).toContain("id: 3:7:" + epoch + "\nevent: state");
    expect(await reader.next()).toContain("id: 3:8:" + epoch);
    await reader.cancel();
  });

  it("deduplicates history and live items and preserves the agent cursor on later Hub events", async () => {
    const { bus, open, rows } = setup();
    const reader = read(await open("0:1:" + epoch));
    expect(await reader.next()).toContain("id: 0:2:" + epoch);
    bus.publish(sessionId, agent(3));
    bus.publish(sessionId, agent(4));
    expect(await reader.next()).toContain("id: 0:3:" + epoch);
    expect(await reader.next()).toContain("id: 0:4:" + epoch);
    rows.push(state(1));
    bus.publish(sessionId, { kind: "hub", event: rows[0]! });
    const frame = await reader.next();
    expect(frame).toContain("id: 1:4:" + epoch + "\nevent: state");
    await reader.cancel();
    bus.publish(sessionId, agent(5));
    const lastEventId = frame?.match(/^id: ([^\n]+)/u)?.[1];
    expect(lastEventId).toBeDefined();
    const resumed = read(
      await open(
        "0",
        "viewer",
        new Request("https://hub.test/events?organization=org", {
          headers: { cookie: "viewer", "last-event-id": lastEventId! },
        }),
      ),
    );
    expect(await resumed.next()).toContain("id: 1:5:" + epoch);
    await resumed.cancel();
  });

  it.each([
    ["agent", "0:3:" + epoch],
    ["Hub after agent", "1:3:" + epoch],
    ["connection", "0:3:" + epoch],
    ["disconnect gap", "0:3:" + epoch],
    ["epoch gap", "0"],
    ["Hub before agent", "1"],
  ])("replays missed agent items or sends a gap after a %s frame", async (last, expectedId) => {
    const { bus, open, rows } = setup();
    const first = read(await open());
    let frame: string | null = null;
    if (last !== "Hub before agent") {
      bus.publish(sessionId, agent(3));
      frame = await first.next();
    }
    if (last.startsWith("Hub")) {
      const event = state(1);
      rows.push(event);
      bus.publish(sessionId, { kind: "hub", event });
    }
    if (last === "connection") bus.publish(sessionId, { kind: "connection", online: false });
    if (last === "disconnect gap")
      bus.publish(sessionId, { kind: "gap", reason: "daemon_disconnected" });
    if (last === "epoch gap") bus.publish(sessionId, { kind: "gap", reason: "epoch_changed" });
    if (last !== "agent") frame = await first.next();
    const lastId = frame?.match(/^id: ([^\n]+)/u)?.[1];
    expect(lastId).toBe(expectedId);
    await first.cancel();

    const currentEpoch = last === "epoch gap" ? "next-epoch" : epoch;
    bus.publish(sessionId, agent(5, currentEpoch));
    bus.publish(sessionId, agent(6, currentEpoch));
    const resumed = read(
      await open(
        "0",
        "viewer",
        new Request("https://hub.test/events?organization=org", {
          headers: { cookie: "viewer", "last-event-id": lastId! },
        }),
      ),
    );
    bus.publish(sessionId, agent(7, currentEpoch));
    const replay = await resumed.next();
    if (expectedId.includes(":")) {
      expect(replay).toContain(`:5:${currentEpoch}\nevent: agent`);
      expect(await resumed.next()).toContain(`:6:${currentEpoch}\nevent: agent`);
    } else {
      expect(replay).toContain('event: gap\ndata: {"reason":"behind"}');
    }
    expect(await resumed.next()).toContain(`:7:${currentEpoch}\nevent: agent`);
    await resumed.cancel();
  });

  it("emits a gap before switching epoch and discards late items from the prior epoch", async () => {
    const { bus, open } = setup();
    const reader = read(await open());
    bus.publish(sessionId, agent(5));
    expect(await reader.next()).toContain("id: 0:5:" + epoch);
    bus.publish(sessionId, agent(1, "new-epoch"));
    bus.publish(sessionId, agent(6));
    bus.publish(sessionId, agent(2, "new-epoch"));
    expect(await reader.next()).toContain('"reason":"epoch_changed"');
    expect(await reader.next()).toContain("id: 0:1:new-epoch");
    expect(await reader.next()).toContain("id: 0:2:new-epoch");
    await reader.cancel();
  });

  it("includes the current cursor in shutdown even before the first agent or Hub item", async () => {
    const { open, stream } = setup();
    const reader = read(await open());
    await stream.beginShutdown();
    expect(await reader.next()).toContain("id: 0\nevent: shutdown");
    expect(await reader.next()).toBeNull();
  });

  it("ends a removed viewer within one second and discards pending transcript frames", async () => {
    const { bus, open, removed } = setup();
    const reader = read(await open());
    bus.publish(sessionId, agent(1));
    removed.add("viewer");
    bus.publish(sessionId, { kind: "access_changed" });
    expect(await reader.next()).toContain('"code":"reauth"');
    expect(await reader.next()).toBeNull();
  }, 1_000);

  it("closes within one second when the removal access check stalls", async () => {
    const { bus, open, source, stream } = setup();
    const reader = read(await open());
    bus.publish(sessionId, agent(1));
    expect(await reader.next()).toContain("id: 0:1:");

    const pending = Promise.withResolvers<"not_found">();
    source.authorizeStream.mockImplementationOnce(() => pending.promise);
    try {
      const start = performance.now();
      bus.publish(sessionId, { kind: "access_changed" });
      bus.publish(sessionId, agent(2));
      expect(await reader.next()).toContain('"code":"reauth"');
      expect(performance.now() - start).toBeLessThan(1000);
      expect(stream.activeStreamCount()).toBe(0);
    } finally {
      pending.resolve("not_found");
      await reader.cancel();
    }
  }, 2000);

  it("reads persisted events in sequence even when wakeups arrive out of order", async () => {
    const { bus, open, rows } = setup();
    const reader = read(await open());
    rows.push(state(1), state(2));
    bus.publish(sessionId, { kind: "hub", event: rows[1]! });
    bus.publish(sessionId, { kind: "hub", event: rows[0]! });
    bus.publish(sessionId, { kind: "hub", event: rows[1]! });
    bus.publish(sessionId, agent(1));
    expect(await reader.next()).toContain("id: 1\nevent: state");
    expect(await reader.next()).toContain("id: 2\nevent: state");
    expect(await reader.next()).toContain("id: 2:1:");
    await reader.cancel();
  });

  it("closes with resync when more than 500 Hub events need replay", async () => {
    const { open, rows } = setup();
    for (let seq = 1; seq <= 501; seq += 1) rows.push(state(seq));
    const reader = read(await open());
    expect(await reader.next()).toContain("event: resync");
    expect(await reader.next()).toBeNull();
  });

  it("honors a browser reconnect cursor and rejects malformed or unsafe cursors", async () => {
    const { bus, open, rows } = setup();
    rows.push(state(1), state(2));
    const response = await open(
      "0",
      "viewer",
      new Request("https://hub.test/events?organization=org&after=0", {
        headers: { cookie: "viewer", "last-event-id": "1" },
      }),
    );
    const reader = read(response);
    expect(await reader.next()).toContain("id: 2\nevent: state");
    expect(await reader.next()).toContain("event: gap");
    bus.publish(sessionId, agent(1, "bad\nevent: injection"));
    bus.publish(sessionId, agent(2));
    expect(await reader.next()).toContain("id: 2:2:");
    await reader.cancel();
    for (const after of ["-1", "1:2:", "1:2:unnamed\n", "9007199254740992"]) {
      const invalid = await open(after);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
    }
  });

  it("closes slow readers without delaying a second viewer", async () => {
    const { bus, open, stream } = setup();
    const slow = read(await open());
    const fast = read(await open("0", "fast"));
    const text = "x".repeat(64 * 1024);
    for (let seq = 1; seq <= 20; seq += 1) {
      bus.publish(sessionId, agent(seq, epoch, text));
      expect(await fast.next()).toContain("id: 0:" + seq + ":" + epoch);
    }
    expect(stream.activeStreamCount()).toBe(1);
    expect(await slow.next()).toContain('"code":"slow_consumer"');
    expect(await slow.next()).toBeNull();
    await fast.cancel();
  });

  it("sends a reconnect hint to existing streams and rejects new opens on shutdown", async () => {
    const { stream, open } = setup();
    const reader = read(await open());
    await stream.beginShutdown();
    expect(await reader.next()).toContain('"reconnectMs":5000');
    expect(await reader.next()).toBeNull();
    const response = await open();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(stream.activeStreamCount()).toBe(0);
  });
});
