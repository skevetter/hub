import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { AgentExecutionRecord } from "../db/types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { mayCompleteOnTurnEnd } from "./lifecycle.js";
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

/** A lone surrogate does not survive UTF-8, which is what Postgres stores. */
function wellFormed(value: string | undefined): boolean {
  return value !== undefined && Buffer.from(value, "utf8").toString("utf8") === value;
}

describe("runtime guard for a launch intent that skipped compile-time validation", () => {
  async function stored(
    intent: Partial<LaunchMachineIntent>,
    record: Partial<AgentExecutionRecord> = {},
  ) {
    const database = createMemoryDatabase({ organizationIds: ["org-guard"] });
    const base: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId: "org-guard",
      projectId: "project-guard",
      triggerRunId: "run-guard",
      triggerName: "guard",
      environmentName: "runner",
      environment: {
        kind: "daemon",
        daemonId: "daemon-guard",
        authoredSlug: "runner",
        cwd: "/repo",
      },
      agent: { provider: "claude" },
      prompt: "work",
      allowOutputs: [],
      autoArchive: false,
      background: false,
      completeOnTurnEnd: true,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: "revision-guard",
      hubConfig: {},
    };
    const execution = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000a1",
      organizationId: "org-guard",
      projectId: "project-guard",
      machineId: null,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: "revision-guard",
      launchIntent: { ...base, ...intent },
    });
    return { ...execution, ...record };
  }

  it("allows an opted-in running execution with no output contract", async () => {
    assert.equal(mayCompleteOnTurnEnd(await stored({})), true);
  });

  it.each([
    ["the option is off", { completeOnTurnEnd: false }],
    ["a structured output is declared", { outputSchema: { type: "object" } }],
    [
      "a required output is declared",
      { allowOutputs: [{ type: "manual.reply", max: 1, required: true }] },
    ],
  ])("blocks when %s", async (_label, intent) => {
    assert.equal(mayCompleteOnTurnEnd(await stored(intent)), false);
  });

  it("blocks a terminal execution, an explicit finish, and a finish call in flight", async () => {
    assert.equal(mayCompleteOnTurnEnd(await stored({}, { status: "succeeded" })), false);
    assert.equal(mayCompleteOnTurnEnd(await stored({}, { completedByAgentAt: new Date() })), false);
    const call = (status: "running" | "completed" | "failed" | "canceled") => ({
      hubActionAcknowledgements: {
        terminalAt: null,
        idleAt: null,
        finishExecutionCall: {
          callId: "c",
          status,
          observedAt: new Date(),
          output: null,
          at: new Date(),
        },
      },
    });
    assert.equal(mayCompleteOnTurnEnd(await stored({}, call("running"))), false);
    assert.equal(mayCompleteOnTurnEnd(await stored({}, call("completed"))), false);
    assert.equal(mayCompleteOnTurnEnd(await stored({}, call("failed"))), true);
    assert.equal(mayCompleteOnTurnEnd(await stored({}, call("canceled"))), true);
  });
});

describe("finish_execution calls seen by the tracker", () => {
  const call = (callId: string, status: string, name = "mcp__hub__finish_execution") =>
    stream({
      type: "timeline",
      provider: "claude",
      item: { type: "tool_call", name, callId, status },
    });

  it.each(["hub.finish_execution", "mcp__hub__finish_execution", "hub / finish_execution"])(
    "owns the outcome while a call named %s is running or completed",
    (name) => {
      const running = new TurnEndTracker();
      running.observe(call("c1", "running", name));
      assert.equal(running.finishCallOwnsOutcome(), true);
      running.observe(call("c1", "completed", name));
      assert.equal(running.finishCallOwnsOutcome(), true);
    },
  );

  it("releases the outcome only when every call failed or was canceled", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(call("c1", "failed"));
    tracker.observe(call("c2", "running"));
    assert.equal(tracker.finishCallOwnsOutcome(), true);
    tracker.observe(call("c2", "canceled"));
    assert.equal(tracker.finishCallOwnsOutcome(), false);
  });

  it("keeps a completed call completed and ignores other tools", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(call("c1", "completed"));
    tracker.observe(call("c1", "running"));
    assert.equal(tracker.finishCallOwnsOutcome(), true);
    const other = new TurnEndTracker();
    other.observe(call("c9", "running", "Bash"));
    assert.equal(other.finishCallOwnsOutcome(), false);
  });
});

describe("turn end output normalization", () => {
  it.each([
    ["a NUL", "a\u0000b", "ab"],
    ["a lone high surrogate", "a\uD83Db", "a\uFFFDb"],
    ["a lone low surrogate", "a\uDE00b", "a\uFFFDb"],
    ["a trailing lone high surrogate", "ab\uD83D", "ab\uFFFD"],
  ])("repairs %s", (_label, said, kept) => {
    const tracker = new TurnEndTracker();
    tracker.observe(text(said));
    const output = tracker.finalOutput();
    assert.equal(output?.text, kept);
    assert.equal(wellFormed(output?.text), true);
  });

  it("has no output when nothing but NUL remains", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(text("\u0000\u0000"));
    assert.equal(tracker.finalOutput(), undefined);
  });

  it("caps in characters after repairing, and keeps a pair that fits", () => {
    const tracker = new TurnEndTracker();
    tracker.observe(text(`${"\u0000".repeat(50)}${"x".repeat(MAX_TURN_END_OUTPUT_CHARS + 5)}`));
    const output = tracker.finalOutput();
    assert.equal(output?.text, "x".repeat(MAX_TURN_END_OUTPUT_CHARS));
    assert.equal(output?.truncated, true);
  });
});

describe("turn end output cut", () => {
  it("drops a high surrogate left at the cut and keeps a whole pair that fits", () => {
    const split = new TurnEndTracker();
    split.observe(text(`${"x".repeat(MAX_TURN_END_OUTPUT_CHARS - 1)}\u{1F600}`));
    const cut = split.finalOutput();
    assert.equal(cut?.text, "x".repeat(MAX_TURN_END_OUTPUT_CHARS - 1));
    assert.equal(cut?.truncated, true);
    assert.equal(wellFormed(cut?.text), true);

    const fits = new TurnEndTracker();
    fits.observe(text(`${"x".repeat(MAX_TURN_END_OUTPUT_CHARS - 2)}\u{1F600}x`));
    const kept = fits.finalOutput();
    assert.equal(kept?.text.endsWith("\u{1F600}"), true);
    assert.equal(wellFormed(kept?.text), true);
  });
});

describe("daemon lifecycle with the in-memory database", () => {
  registerTurnEndScenarios(async () => ({
    database: createMemoryDatabase({ organizationIds: ["org-turn-end"] }),
    organizationId: "org-turn-end",
  }));
});
