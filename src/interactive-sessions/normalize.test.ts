import { expect, test } from "vitest";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { LiveSessionTranscript, SessionTranscriptNormalizer } from "./normalize.js";

const at = "2026-11-20T12:00:00.000Z";
const secret = "exampleSensitiveValue";
const scrub = createTimelineScrubber({ scrubValues: [secret] });
const normalizer = new SessionTranscriptNormalizer([secret], scrub);
const commandId = "12345678-1234-1234-1234-123456789abc";

test("relays only scrubbed assistant text, tool summaries, and human anchors", () => {
  const normalize = (item: { type: string } & Record<string, unknown>) =>
    normalizer.stream({
      type: "agent_stream",
      agentId: "agent",
      seq: 9,
      epoch: "epoch",
      timestamp: at,
      event: { type: "timeline", provider: "codex", turnId: "turn", item },
    });
  expect(normalize({ type: "assistant_message", text: "Hello " + secret })).toEqual({
    kind: "assistant",
    seq: 9,
    turnId: "turn",
    text: "Hello [redacted]",
    truncated: false,
    at,
  });
  expect(
    normalize({
      type: "tool_call",
      name: "shell",
      status: "completed",
      input: secret,
      output: secret,
    }),
  ).toEqual({ kind: "tool", seq: 9, turnId: "turn", name: "shell", status: "completed", at });
  expect(normalize({ type: "tool_call", name: secret, status: "running" })?.kind).toBe("tool");
  expect(
    JSON.stringify(normalize({ type: "tool_call", name: secret, status: "running" })),
  ).not.toContain(secret);
  expect(normalize({ type: "reasoning", text: secret })).toBeUndefined();
  expect(normalize({ type: "user_message", text: secret, messageId: commandId })).toEqual({
    kind: "human",
    seq: 9,
    commandId,
    at,
  });
});

test("history uses the end sequence and bounds assistant output by UTF-8 bytes", () => {
  const item = normalizer.history({
    item: { type: "assistant_message", text: "\u00e9".repeat(40_000) },
    timestamp: at,
    seqStart: 3,
    seqEnd: 7,
    turnId: "turn",
  });
  expect(item).toMatchObject({ kind: "assistant", seq: 7, truncated: true, at, turnId: "turn" });
  if (item?.kind !== "assistant") throw new Error("Expected assistant item");
  expect(item.text.length).toBe(32_768);
  expect(item.text.replaceAll("\u00e9", "")).toBe("");
  expect(item.text).not.toContain("\ufffd");
});

test.each(["All tests passed", "keyboard", "author", "design doc"])(
  "keeps ordinary assistant prose: %s",
  (text) => {
    expect(
      normalizer.history({
        item: { type: "assistant_message", text },
        seqStart: 1,
        seqEnd: 1,
        timestamp: at,
      }),
    ).toMatchObject({ text, truncated: false });
  },
);

test("replaces credential spans and preserves surrounding prose", () => {
  const text =
    "Bearer abcdef12345678, ghp_Example123456, github_pat_Example123456, lin_api_Example123456; token=0123456789abcdef0123456789abcdef; eyJhbGciOiJIUzI1NiJ9.eyJmb28iOiJiYXIifQ.dGVzdHNpZ25hdHVyZQ";
  expect(
    normalizer.history({
      item: { type: "assistant_message", text },
      seqStart: 1,
      seqEnd: 1,
      timestamp: at,
    }),
  ).toMatchObject({
    text: "Bearer [redacted], [redacted], [redacted], [redacted]; token=[redacted]; [redacted]",
    truncated: false,
  });
});

test("the live transcript keeps up to 64 KiB of an assistant message and marks truncation", () => {
  const live = new LiveSessionTranscript(normalizer);
  const text = "All tests passed. " + "x".repeat(33_000);
  for (const seq of [1, 2]) {
    expect(
      live.accept({
        agentId: "agent",
        type: "agent_stream",
        seq,
        epoch: "epoch",
        timestamp: at,
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", messageId: "reply", text },
        },
      }),
    ).toEqual([]);
  }
  const [frame] = live.finish();
  expect(frame && "item" in frame ? frame.item : undefined).toMatchObject({
    kind: "assistant",
    seq: 2,
    truncated: true,
  });
  if (!frame || !("item" in frame) || frame.item.kind !== "assistant")
    throw new Error("Expected assistant item");
  expect(Buffer.byteLength(frame.item.text)).toBe(65_536);
  expect(frame.item.text.startsWith("All tests passed. ")).toBe(true);
});
