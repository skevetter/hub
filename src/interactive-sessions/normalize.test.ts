import { expect, test } from "vitest";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { normalizeAgentHistoryEntry, normalizeAgentStreamItem } from "./normalize.js";

const at = "2026-11-20T12:00:00.000Z";
const secret = "exampleSensitiveValue";
const scrub = createTimelineScrubber({ scrubValues: [secret] });

test("relays only scrubbed assistant text, tool summaries, and human anchors", () => {
  const normalize = (item: { type: string } & Record<string, unknown>) =>
    normalizeAgentStreamItem(
      {
        type: "agent_stream",
        agentId: "agent",
        seq: 9,
        epoch: "epoch",
        timestamp: at,
        event: { type: "timeline", provider: "codex", turnId: "turn", item },
      },
      scrub,
    );
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
  expect(normalize({ type: "user_message", text: secret, messageId: "command-id" })).toEqual({
    kind: "human",
    seq: 9,
    commandId: "command-id",
    at,
  });
});

test("history uses the end sequence and bounds assistant output by UTF-8 bytes", () => {
  const item = normalizeAgentHistoryEntry(
    {
      item: { type: "assistant_message", text: "é".repeat(40_000) },
      timestamp: at,
      seqStart: 3,
      seqEnd: 7,
      turnId: "turn",
    },
    scrub,
  );
  expect(item).toMatchObject({ kind: "assistant", seq: 7, truncated: true, at, turnId: "turn" });
  if (item?.kind !== "assistant") throw new Error("Expected assistant item");
  expect(Buffer.byteLength(item.text)).toBeLessThanOrEqual(65_536);
  expect(item.text).not.toContain("\ufffd");
});
