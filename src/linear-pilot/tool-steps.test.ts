import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "../daemons/agents/index.js";
import { HubExecutionAgentStreamEventSchema } from "../hub/protocol.js";
import { logger } from "../logger.js";
import { LinearAgentError } from "../providers/linear/agent.js";
import {
  createLinearPilotActivities,
  stableActivityId,
  type LinearPilotAcceptedEvent,
  type PilotClient,
} from "./activities.js";
import { LinearPilotTurn } from "./session.js";
import { createLinearPilotToolStepHook, type ToolStepHook } from "./tool-steps.js";

type Stream = Extract<AgentEvent, { type: "agent_stream" }>;
type Item = Extract<Stream["event"], { type: "timeline" }>["item"];
const answer = { text: "Finished.", truncated: false };

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function eventFor(id: string, installation = "installation"): LinearPilotAcceptedEvent {
  return {
    decision: "accepted",
    kind: "prompted",
    nativeSessionId: id,
    interactionId: `${id}-prompt`,
    actorProviderUserId: "owner",
    allowedHumanProviderUserId: "owner",
    publishAnswer: true,
    receivedAt: 0,
    binding: {
      id: installation,
      organizationId: "org",
      linearOrganizationId: "linear-org",
      providerApplicationId: "linear-app",
      appUserId: "app",
    },
  };
}

function fixture(installFor: (id: string) => string = () => "installation") {
  const createActivity = vi.fn<PilotClient["createActivity"]>(async ({ activityId }) => activityId);
  const isActivityConfirmed = vi.fn<PilotClient["isActivityConfirmed"]>(async () => false);
  const clientFor = vi.fn(() => ({ createActivity, isActivityConfirmed }));
  const event = (id: string) => eventFor(id, installFor(id));
  const resolve = vi.fn(({ sessionId }: { sessionId: string }) => ({
    event: event(sessionId),
    clientFor,
  }));
  const hook = createLinearPilotToolStepHook({ resolve, now: () => Date.now() });
  const writer = createLinearPilotActivities({ clientFor, now: () => Date.now() });
  return { createActivity, isActivityConfirmed, clientFor, resolve, hook, writer, event };
}

function stream(event: Stream["event"], seq?: number): Stream {
  return {
    type: "agent_stream",
    agentId: "agent",
    timestamp: "2026-01-01T00:00:00Z",
    event: HubExecutionAgentStreamEventSchema.parse({ ...event, turnId: "daemon-turn" }),
    ...(seq === undefined ? {} : { seq, epoch: "epoch" }),
  };
}

function begin(sessionId: string, toolSteps?: ToolStepHook) {
  const scope = {
    organizationId: "org",
    sessionId,
    commandId: "command",
    daemonId: "daemon",
    agentId: "agent",
    generation: 1,
    hubTurn: 1,
  };
  const turn = new LinearPilotTurn(scope, toolSteps ? { toolSteps, cwd: "/work" } : undefined);
  let seq = 0;
  const row = (item: Item) =>
    turn.accept(stream({ type: "timeline", provider: "codex", item }, ++seq));
  turn.accept(stream({ type: "turn_started", provider: "codex" }));
  row({ type: "user_message", clientMessageId: scope.commandId });
  return {
    turn,
    tool(
      callId: string,
      detail: unknown = { type: "read", filePath: "docs/one.md" },
      status = "completed",
    ) {
      return row({ type: "tool_call", callId, name: "read", detail, status });
    },
    complete() {
      row({ type: "assistant_message", messageId: "answer", text: answer.text });
      return turn.accept(stream({ type: "turn_completed", provider: "codex" }));
    },
    fail: () => turn.accept(stream({ type: "turn_failed", provider: "codex", error: "synthetic" })),
  };
}

type Fixture = ReturnType<typeof fixture>;

function writes(f: Fixture) {
  return f.createActivity.mock.calls.map(([input]) => input.content);
}

function expectGap(f: Fixture, session: string) {
  const { nativeSessionId, interactionId } = f.event(session);
  const id = stableActivityId(nativeSessionId, "action_gap", interactionId);
  const gaps = f.createActivity.mock.calls.filter(([input]) => input.content.type === "thought");
  expect(gaps.map(([input]) => input)).toEqual([
    {
      sessionId: nativeSessionId,
      activityId: id,
      content: { type: "thought", body: "Some steps not shown." },
    },
  ]);
}

it("posts three finished actions in stream order before the exact answer", async () => {
  const f = fixture();
  const pilot = begin("session", f.hook);
  pilot.tool("raw-call-one", { type: "shell", command: "git status", exitCode: 0 }, "running");
  pilot.tool("raw-call-one", { type: "shell", command: "git status", exitCode: 0 });
  pilot.tool("raw-call-two");
  pilot.tool("raw-call-three", { type: "search", toolName: "rg", query: "private search" });
  await vi.advanceTimersByTimeAsync(2_000);
  pilot.tool("raw-call-three");
  const terminal = pilot.complete();
  expect(terminal?.status).toBe("completed");
  if (terminal?.status !== "completed") throw new Error("expected terminal answer");
  await f.writer.respond(f.event("session"), "first-attempt", terminal.answer, []);
  expect(writes(f)).toEqual([
    { type: "action", action: "Ran command", parameter: "git status", result: "exit 0" },
    { type: "action", action: "Read", parameter: "docs/one.md" },
    { type: "action", action: "Searched", parameter: "query" },
    { type: "response", body: "Finished." },
  ]);
  const { nativeSessionId, interactionId } = f.event("session");
  const hash = createHash("sha256").update("raw-call-one").digest("hex");
  expect(f.createActivity.mock.calls[0]?.[0]).toMatchObject({
    ephemeral: false,
    activityId: stableActivityId(nativeSessionId, "action", `${interactionId}:${hash}`),
  });
  expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
    { keys: ["type", "command", "exitCode"] },
    "Linear pilot tool detail keys",
  );
});

it("makes no extra calls when the hook is absent", async () => {
  const f = fixture();
  const pilot = begin("session");
  pilot.tool("call");
  expect(pilot.complete()).toMatchObject({ status: "completed", answer });
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.clientFor).not.toHaveBeenCalled();
  expect(logger.debug).not.toHaveBeenCalled();
  await f.writer.respond(f.event("session"), "first-attempt", answer, []);
  expect(writes(f)).toEqual([{ type: "response", body: "Finished." }]);
});

it("does not expose running, invalid, or unproven calls and clears the diagnostic on release", async () => {
  const f = fixture();
  const first = begin("session", f.hook);
  first.tool("", { type: "read", filePath: "one" }, "completed");
  first.tool("still-running", undefined, "running");
  first.tool("x".repeat(256));
  first.tool("unknown-state", undefined, "pending");
  expect(
    first.turn.accept(
      stream(
        {
          type: "timeline",
          provider: "codex",
          item: { type: "tool_call", callId: "sequence-gap", status: "completed" },
        },
        99,
      ),
    ),
  ).toMatchObject({ status: "unconfirmed" });
  expect(logger.debug).toHaveBeenCalledTimes(1);
  const replay = begin("session", f.hook);
  replay.tool("second-call");
  await vi.advanceTimersByTimeAsync(0);
  expect(writes(f)).toHaveLength(1);
  expect(logger.debug).toHaveBeenCalledTimes(2);
});

it("logs only the first ten valid detail keys and no values", () => {
  const f = fixture();
  const pilot = begin("session", f.hook);
  const maxKey = "a".repeat(32);
  const keys = [maxKey, "_ok", ...Array.from({ length: 9 }, (_, index) => `field${index}`)];
  const rawKeys = ["0bad", "bad-key", "bad\n", "x".repeat(33), ...keys];
  const detail = Object.fromEntries(rawKeys.map((key) => [key, "not logged"]));
  pilot.tool("running-call", detail, "running");
  expect(logger.debug).toHaveBeenCalledExactlyOnceWith(
    { keys: keys.slice(0, 10) },
    "Linear pilot tool detail keys",
  );
});

it.each([false, true])(
  "keeps the final answer when accepting a tool step throws (close throws: %s)",
  (closeThrows) => {
    const accept = vi.fn(() => {
      throw new Error("untrusted detail");
    });
    const close = vi.fn(() => {
      if (closeThrows) throw new Error("untrusted cleanup");
    });
    const pilot = begin("session", () => ({ accept, close }));
    pilot.tool("broken");
    pilot.tool("ignored");
    expect(pilot.complete()).toMatchObject({ status: "completed", answer });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      ["Linear pilot tool step hook failed"],
      ...(closeThrows ? [["Linear pilot tool step close failed"]] : []),
    ]);
  },
);

it("uses the same deterministic action id and deduplicates replays", async () => {
  const f = fixture();
  begin("session", f.hook).tool("call");
  await vi.advanceTimersByTimeAsync(0);
  begin("session", f.hook).tool("call");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(writes(f)).toHaveLength(1);
});

it("posts 30 actions and one fixed gap thought in a turn", async () => {
  const f = fixture();
  const pilot = begin("session", f.hook);
  for (let index = 0; index < 30; index++) {
    pilot.tool(`step-${index}`);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  pilot.tool("omitted-one");
  pilot.tool("omitted-two");
  expect(writes(f).filter((content) => content.type === "action")).toHaveLength(30);
  expectGap(f, "session");
});

it("limits a session to one in-flight action plus five waiting and one gap thought", async () => {
  const f = fixture();
  const stuck = Promise.withResolvers<string>();
  f.createActivity.mockReturnValueOnce(stuck.promise);
  const pilot = begin("session", f.hook);
  for (let index = 0; index < 9; index++) pilot.tool(`step-${index}`);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(writes(f).map((content) => content.type)).toEqual(["action", "thought"]);
  expectGap(f, "session");
  const id = f.createActivity.mock.calls[0]?.[0].activityId;
  if (!id) throw new Error("expected first activity id");
  stuck.resolve(id);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(writes(f).filter((content) => content.type === "action")).toHaveLength(6);
  expectGap(f, "session");
});

it.each([429, 503])(
  "holds the installation bucket 60 s after HTTP %i without readback",
  async (status) => {
    const f = fixture((id) => (id === "outside" ? "other-installation" : "shared-installation"));
    f.createActivity.mockRejectedValueOnce(new LinearAgentError("request_failed", status));
    const first = begin("first", f.hook);
    first.tool("first-call");
    await vi.advanceTimersByTimeAsync(0);
    first.tool("after-failure");
    expect(f.isActivityConfirmed).not.toHaveBeenCalled();
    expectGap(f, "first");
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { operation: "action", httpStatus: status, linearErrorCode: "request_failed" },
      "Linear pilot tool step failed",
    );
    begin("second", f.hook).tool("second-call");
    begin("outside", f.hook).tool("outside-call");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(f.createActivity.mock.calls.map(([input]) => input.sessionId)).toEqual([
      "first",
      "first",
      "outside",
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.createActivity.mock.calls.at(-1)?.[0].sessionId).toBe("second");
  },
);

it.each([true, false])(
  "stops after a write failure and one readback returning %s",
  async (confirmed) => {
    const f = fixture();
    f.createActivity.mockRejectedValueOnce(new Error("synthetic message not logged"));
    f.isActivityConfirmed.mockResolvedValueOnce(confirmed);
    const pilot = begin("session", f.hook);
    pilot.tool("failed");
    pilot.tool("queued");
    await vi.advanceTimersByTimeAsync(5_000);
    pilot.tool("later");
    expect(f.isActivityConfirmed).toHaveBeenCalledTimes(1);
    expect(writes(f).map((content) => content.type)).toEqual(["action", "thought"]);
    expectGap(f, "session");
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { operation: "action", httpStatus: undefined, linearErrorCode: "unconfirmed" },
      "Linear pilot tool step failed",
    );
  },
);

it("the terminal response does not wait on the installation bucket", async () => {
  const f = fixture();
  const pilot = begin("session", f.hook);
  pilot.tool("sent");
  pilot.tool("waiting");
  await vi.advanceTimersByTimeAsync(0);
  pilot.complete();
  await f.writer.respond(f.event("session"), "first-attempt", answer, []);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(writes(f).map((content) => content.type)).toEqual(["action", "response"]);
});

it.each(["response", "error", "stop"])(
  "aborts in-flight action before %s and drops queued calls",
  async (terminal) => {
    const f = fixture();
    const stuck = Promise.withResolvers<string>();
    f.createActivity.mockReturnValueOnce(stuck.promise);
    const pilot = begin("session", f.hook);
    pilot.tool("in-flight");
    pilot.tool("queued");
    const actionSignal = f.createActivity.mock.calls[0]?.[1];

    if (terminal === "stop") {
      f.hook.close(f.event("session"));
      await f.writer.stop({ ...f.event("session"), kind: "stop" }, "first-attempt", "confirmed");
    } else if (terminal === "error") {
      pilot.fail();
      await f.writer.error(f.event("session"), "first-attempt");
    } else {
      pilot.complete();
      await f.writer.respond(f.event("session"), "first-attempt", answer, []);
    }

    expect(actionSignal?.aborted).toBe(true);
    pilot.tool("after-terminal");
    stuck.reject(new LinearAgentError("cancelled"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes(f).map((content) => content.type)).toEqual([
      "action",
      terminal === "error" ? "error" : "response",
    ]);
    expect(f.isActivityConfirmed).not.toHaveBeenCalled();
  },
);

it("separates 2,048 held action claims from the terminal claim", async () => {
  const f = fixture((id) => id);
  for (let index = 0; index < 2_048; index++) begin(`session-${index}`, f.hook).tool("call");
  const pilot = begin("final", f.hook);
  pilot.tool("no-action-claim");
  expectGap(f, "final");
  expect(writes(f).filter((content) => content.type === "action")).toHaveLength(2_048);
  pilot.complete();
  await expect(
    f.writer.respond(f.event("final"), "first-attempt", answer, []),
  ).resolves.toMatchObject({ disposition: "confirmed" });
});
