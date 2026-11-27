import { describe, expect, it } from "vitest";
import { SessionEventBus, type SessionNotification } from "./bus.js";

const at = "2026-11-20T00:00:00Z";
const id = "session";

function agent(seq: number, text = "answer", epoch = "epoch") {
  return {
    kind: "agent",
    epoch,
    item: { kind: "assistant", seq, at, text, truncated: false },
  } satisfies SessionNotification;
}

describe("session event bus", () => {
  it("notifies in subscription order despite failures and skips unsubscribed listeners", () => {
    const trace: unknown[] = [];
    const failure = new Error("listener failed");
    const bus = new SessionEventBus((error) => {
      trace.push(error);
      throw new Error("reporting failed");
    });
    const unsubscribe = bus.subscribe(id, () => {
      trace.push("first");
      remove();
      throw failure;
    });
    const remove = bus.subscribe(id, () => trace.push("removed"));
    const last = bus.subscribe(id, (notice) => trace.push(notice.kind));
    bus.publish(id, { kind: "resync" });
    expect(trace).toEqual(["first", failure, "resync"]);
    unsubscribe();
    last();
  });

  it("preserves chunk offsets, snapshots items and drops duplicates", () => {
    const bus = new SessionEventBus();
    bus.publish(id, agent(1));
    expect(bus.readAgentItems(id, "epoch", { seq: 0 })).toEqual({
      status: "unavailable",
      reason: "behind",
    });
    const unsubscribe = bus.subscribe(id, () => undefined);
    const first = agent(2);
    const partial = { ...first.item, chunkStart: 2, chunkOffset: 4 };
    bus.publish(id, { ...first, item: partial });
    bus.publish(id, { ...first, item: partial });
    partial.text = "changed";
    bus.publish(id, agent(3));
    expect(bus.readAgentItems(id, "epoch", { seq: 2, chunkOffset: 2 })).toEqual({
      status: "available",
      items: [{ ...partial, text: "answer" }, agent(3).item],
    });
    bus.publish(id, agent(1, "next", "next-epoch"));
    expect(bus.readAgentItems(id, "epoch", { seq: 2 })).toEqual({
      status: "unavailable",
      reason: "epoch_changed",
    });
    unsubscribe();
    bus.clearAgentItems(id);
  });

  it("evicts by count and bytes and drops the buffer on close", () => {
    const bus = new SessionEventBus();
    const unsubscribe = bus.subscribe(id, () => undefined);
    for (let seq = 1; seq <= 257; seq++) bus.publish(id, agent(seq));
    const behind = { status: "unavailable", reason: "behind" };
    expect(bus.readAgentItems(id, "epoch", { seq: 0 })).toEqual(behind);
    const large = agent(258, "x".repeat(512 * 1024));
    bus.publish(id, large);
    expect(bus.readAgentItems(id, "epoch", { seq: 258 })).toEqual({
      status: "available",
      items: [],
    });
    bus.publish(id, {
      kind: "hub",
      event: {
        kind: "state",
        sessionId: id,
        organizationId: "org",
        commandId: null,
        at: new Date(at),
        seq: 1,
        data: { state: "closed", stateReason: null, generation: 1, turn: 1 },
      },
    });
    expect(bus.readAgentItems(id, "epoch", { seq: 258 })).toEqual(behind);
    unsubscribe();
  });
});
