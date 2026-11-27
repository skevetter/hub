import { describe, expect, it } from "vitest";
import { LiveSessionTranscript, SessionTranscriptNormalizer } from "./normalize.js";

const at = "2026-11-20T00:00:00Z";
const normalizer = new SessionTranscriptNormalizer(["examplePrivatePhrase"]);
type Event = Parameters<LiveSessionTranscript["accept"]>[0];
type Timeline = Extract<Event["event"], { type: "timeline" }>;

function event(seq: number, item: Timeline["item"], epoch = "epoch"): Event {
  return {
    type: "agent_stream",
    agentId: "agent",
    seq,
    epoch,
    timestamp: at,
    event: { type: "timeline", provider: "codex", turnId: "turn", item },
  };
}

function assistant(text: string, messageId = "reply") {
  return { type: "assistant_message" as const, text, messageId };
}

describe("session transcript normalization", () => {
  it("redacts a secret split between history entries and bounds grouped UTF-8", () => {
    const entries = ["before examplePri", "vatePhrase after", "\u00e9".repeat(40_000), "ignored"];
    const normalized = normalizer.historyEntries(
      entries.map((text, i) => ({
        item: assistant(text),
        seqStart: i + 1,
        seqEnd: i + 1,
        timestamp: at,
      })),
    );
    const replies = normalized.filter((entry) => entry.kind === "assistant");
    expect(
      replies
        .map(({ text }) => text)
        .join("")
        .startsWith("before [redacted] after"),
    ).toBe(true);
    expect(replies.at(-1)).toMatchObject({ seqEnd: 3, truncated: true });
    expect(replies.some(({ text }) => text.includes("\ufffd"))).toBe(false);
  });

  it("allows known tool states only and resolves human ids from either identifier", () => {
    for (const status of ["running", "completed", "failed", "canceled"]) {
      expect(
        normalizer.stream(event(3, { type: "tool_call", name: "<hidden>", status })),
      ).toMatchObject({ kind: "tool", name: "unnamed", status });
    }
    expect(normalizer.stream(event(3, { type: "tool_call", status: "unknown" }))).toBeUndefined();
    const commandId = "12345678-1234-1234-1234-123456789abc";
    expect(
      normalizer.stream(
        event(3, { type: "user_message", messageId: "bad", clientMessageId: commandId }),
      ),
    ).toMatchObject({ kind: "human", commandId });
    expect(normalizer.stream(event(3, { type: "user_message", clientMessageId: 5 }))).toMatchObject(
      { kind: "human", commandId: null },
    );
  });

  it("releases partial chunks once, ignores duplicate sequence numbers and resets across epochs", () => {
    const live = new LiveSessionTranscript(normalizer);
    const text = "x".repeat(100);
    const first = event(5, assistant(text));
    expect(live.accept(first)).toMatchObject([
      { epoch: "epoch", item: { chunkOffset: 36, seq: 5 } },
    ]);
    expect(live.accept(first)).toEqual([]);
    expect(live.finish("different")).toEqual([]);
    expect(live.finish("turn")).toMatchObject([{ item: { chunkStart: 36, seq: 5 } }]);
    expect(live.accept(event(1, assistant("next"), "another"))).toEqual([{ gap: "epoch_changed" }]);
    expect(live.finish()).toMatchObject([{ epoch: "another", item: { text: "next", seq: 1 } }]);
  });

  it("reports saturation once and resumes after finishing the turn", () => {
    const live = new LiveSessionTranscript(normalizer);
    for (let i = 1; i <= 64; i++) live.accept(event(i, assistant(`part ${i}`, `m-${i}`)));
    expect(live.accept(event(65, assistant("more", "new")))).toMatchObject([
      { item: { seq: 64 } },
      { gap: "behind" },
    ]);
    expect(live.accept(event(66, assistant("ignored")))).toEqual([]);
    expect(live.finish()).toEqual([]);
    expect(live.accept(event(67, assistant("accepted")))).toEqual([]);
    expect(live.finish()).toMatchObject([{ item: { text: "accepted" } }]);
  });
});
