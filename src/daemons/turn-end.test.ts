import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { AgentEvent } from "./agents/index.js";
import { MAX_TURN_END_OUTPUT_CHARS, TurnEndTracker } from "./turn-end.js";
import { registerTurnEndScenarios } from "./test-utils/turn-end-scenarios.js";

const at = "2026-01-01T00:00:00.000Z";
const stream = (event: Extract<AgentEvent, { type: "agent_stream" }>["event"]): AgentEvent => ({
  type: "agent_stream",
  agentId: "agent-1",
  event,
  timestamp: at,
});
const turnCompleted = () => stream({ type: "turn_completed", provider: "claude" });
const text = (value: string, messageId?: string) =>
  stream({
    type: "timeline",
    provider: "claude",
    item: {
      type: "assistant_message",
      text: value,
      ...(messageId === undefined ? {} : { messageId }),
    },
  });

describe("turn end tracker", () => {
  it("reports a normal turn end and nothing else", () => {
    const tracker = new TurnEndTracker();
    assert.equal(tracker.observe(stream({ type: "turn_started", provider: "claude" })), "none");
    assert.equal(tracker.observe(turnCompleted()), "finished");
    assert.equal(tracker.isCurrent(tracker.currentGeneration), true);
  });

  it.each([
    ["turn_started", { type: "turn_started", provider: "claude" }],
    ["turn_failed", { type: "turn_failed", provider: "claude", error: "x" }],
    ["turn_canceled", { type: "turn_canceled", provider: "claude", reason: "x" }],
    ["permission_requested", { type: "permission_requested", provider: "claude", request: {} }],
    [
      "permission_resolved",
      { type: "permission_resolved", provider: "claude", requestId: "r", resolution: {} },
    ],
    [
      "attention_required for a permission",
      {
        type: "attention_required",
        provider: "claude",
        reason: "permission",
        timestamp: at,
        shouldNotify: true,
      },
    ],
    [
      "a tool call",
      { type: "timeline", provider: "claude", item: { type: "tool_call", name: "Bash" } },
    ],
  ] as const)("withdraws a finished turn on %s", (_label, event) => {
    const tracker = new TurnEndTracker();
    tracker.observe(turnCompleted());
    const generation = tracker.currentGeneration;
    assert.equal(tracker.observe(stream(event)), "active");
    assert.equal(tracker.isCurrent(generation), false);
  });

  it("keeps a finished turn through the attention event that announces it", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(turnCompleted());
    const generation = tracker.currentGeneration;
    const verdict = tracker.observe(
      stream({
        type: "attention_required",
        provider: "claude",
        reason: "finished",
        timestamp: at,
        shouldNotify: true,
      }),
    );
    assert.equal(verdict, "none");
    assert.equal(tracker.isCurrent(generation), true);
  });

  it("does not trust status updates or snapshots", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(turnCompleted());
    const generation = tracker.currentGeneration;
    const agent = { id: "agent-1", workspaceId: "w", status: "running" as const };
    assert.equal(tracker.observe({ type: "agent_update", agent, timestamp: at }), "none");
    assert.equal(tracker.observe({ type: "agent_snapshot", agent, timestamp: at }), "none");
    assert.equal(tracker.isCurrent(generation), true);
  });

  it("returns the trailing assistant message and drops text before the last tool call", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(text("Looking.", "m1"));
    tracker.observe(
      stream({ type: "timeline", provider: "claude", item: { type: "tool_call", name: "Bash" } }),
    );
    tracker.observe(text("Done ", "m2"));
    tracker.observe(text("now.", "m2"));
    tracker.observe(
      stream({ type: "timeline", provider: "claude", item: { type: "reasoning", text: "hm" } }),
    );
    assert.deepEqual(tracker.finalOutput(), { text: "Done now.", truncated: false });
  });

  it("has no output for a turn that said nothing", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(text("   "));
    assert.equal(tracker.finalOutput(), undefined);
  });

  it("bounds the output it keeps", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(text("x".repeat(MAX_TURN_END_OUTPUT_CHARS + 10)));
    const output = tracker.finalOutput();
    assert.equal(output?.text.length, MAX_TURN_END_OUTPUT_CHARS);
    assert.equal(output?.truncated, true);
  });
});

describe("daemon lifecycle with the in-memory database", () => {
  registerTurnEndScenarios(async () => ({
    database: createMemoryDatabase({ organizationIds: ["org-turn-end"] }),
    organizationId: "org-turn-end",
  }));
});
