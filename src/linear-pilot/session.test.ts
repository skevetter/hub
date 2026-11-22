import { expect, test, vi } from "vitest";
import { z } from "zod";
import { DaemonAgents, type AgentEvent } from "../daemons/agents/index.js";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import { MAX_REPLY_INPUT_CHARS } from "../run-replies/format.js";
import { LinearPilotTurn } from "./session.js";
import * as pilotSession from "./session.js";

const { matchesLinearPilotStop } = pilotSession;

type Stream = Extract<AgentEvent, { type: "agent_stream" }>;
const scope = {
  organizationId: "organization",
  sessionId: "session",
  commandId: "command",
  daemonId: "daemon",
  agentId: "agent",
  generation: 1,
  hubTurn: 1,
};
const epoch = "timeline";
const turnId = "turn";
const daemonStartedAt = "2026-01-01T00:00:00.250Z";

function stream(event: Stream["event"], seq?: number): Stream {
  return {
    type: "agent_stream",
    agentId: scope.agentId,
    timestamp: "2026-01-01T00:00:00Z",
    ...(event.type === "turn_started" ? { wireTimestamp: daemonStartedAt } : {}),
    event: { ...event, turnId },
    ...(seq === undefined ? {} : { seq, epoch }),
  };
}

function row(item: Extract<Stream["event"], { type: "timeline" }>["item"], seq: number) {
  return stream({ type: "timeline", provider: "codex", item }, seq);
}

function ownedTurn() {
  const turn = new LinearPilotTurn(scope);
  turn.accept(stream({ type: "turn_started", provider: "codex" }));
  turn.accept(row({ type: "user_message", clientMessageId: scope.commandId }, 1));
  return turn;
}

const completion = stream({ type: "turn_completed", provider: "codex" });

test("retains proof across 70 distinct assistant blocks", () => {
  const turn = ownedTurn();
  for (let index = 1; index <= 70; index++) {
    expect(
      turn.accept(
        row(
          {
            type: "assistant_message",
            messageId: `block-${index}`,
            text: `Answer ${index}`,
          },
          index + 1,
        ),
      ),
    ).toBeUndefined();
  }
  expect(turn.accept(completion)).toMatchObject({
    status: "completed",
    seq: 71,
    messageId: "block-70",
    answer: { text: "Answer 70", truncated: false },
  });
});

test("a reused assistant block loses proof when it is current or immediately previous", () => {
  const first = { type: "assistant_message", messageId: "first", text: "Do not use" } as const;
  for (const between of [
    { type: "tool_call", name: "read", result: "Tool boundary" },
    { type: "assistant_message", messageId: "second", text: "Other answer" },
  ] as const) {
    const turn = ownedTurn();
    turn.accept(row(first, 2));
    turn.accept(row(between, 3));
    expect(turn.accept(row(first, 4))).toMatchObject({ status: "unconfirmed" });
    expect(turn.target).toBeUndefined();
    expect(turn.turnEnded).toBe(false);
  }
});

test("tracks only the current and previous assistant block ids", () => {
  const turn = ownedTurn();
  for (const [index, messageId] of ["first", "second", "third", "first"].entries()) {
    expect(
      turn.accept(
        row(
          {
            type: "assistant_message",
            messageId,
            text: `Answer ${index}`,
          },
          index + 2,
        ),
      ),
    ).toBeUndefined();
  }
  expect(turn.accept(completion)).toMatchObject({
    status: "completed",
    answer: { text: "Answer 3", truncated: false },
  });
});

test("the exact terminal turn selects only its final assistant block", () => {
  const turn = ownedTurn();
  turn.accept(
    row({ type: "assistant_message", messageId: "intermediate", text: "Discard this" }, 2),
  );
  turn.accept(row({ type: "tool_call", name: "read", result: "do not publish" }, 3));
  turn.accept(row({ type: "assistant_message", messageId: "final", text: "Final " }, 4));
  turn.accept(row({ type: "assistant_message", messageId: "final", text: "text" }, 5));
  expect(turn.accept(completion)).toEqual({
    ...scope,
    daemonTurnId: turnId,
    epoch,
    startedAt: daemonStartedAt,
    status: "completed",
    seq: 5,
    messageId: "final",
    answer: { text: "Final text", truncated: false },
  });
  expect(turn.accept(completion)).toBeUndefined();
});

test("Stop will not substitute Hub event receipt time when daemon turn start time is missing", () => {
  const turn = new LinearPilotTurn(scope);
  const { wireTimestamp: _missing, ...received } = stream({
    type: "turn_started",
    provider: "codex",
  });
  turn.accept(received);
  turn.accept(row({ type: "user_message", clientMessageId: scope.commandId }, 1));
  const target = turn.target!;
  expect(target.startedAt).toBeNull();
  expect(
    matchesLinearPilotStop(target, {
      ...scope,
      expectedAgentId: scope.agentId,
      expectedDaemonTurnId: turnId,
      expectedBindingGeneration: 1,
      requestedAt: "2026-01-01T00:00:01.000Z",
    }),
  ).toBe(false);
});

test("Stop compares signed request time with the daemon wire turn start", async () => {
  const receivedAt = new Date("2026-01-01T00:00:30.000Z");
  const turn = new LinearPilotTurn(scope);
  const envelope = z.object({ message: z.object({ requestId: z.string() }) });
  const agents = new DaemonAgents(
    (frame) => {
      const { message } = envelope.parse(JSON.parse(frame));
      agents.receive({
        type: "session",
        message: {
          type: "response",
          payload: {
            requestId: message.requestId,
            agent: { id: scope.agentId, workspaceId: "workspace", status: "idle" },
          },
        },
      });
    },
    () => receivedAt,
  );
  agents.receive({
    type: "session",
    message: {
      type: "server_info",
      payload: { features: { hubAgentRpc: true, agentRequestReceipts: true } },
    },
  });
  const unsubscribe = await agents.watch(scope.agentId, (event) => {
    if (event.type === "agent_stream") turn.accept(event);
  });
  try {
    expect(
      agents.receive({
        type: "session",
        message: {
          type: "agent_stream",
          payload: {
            agentId: scope.agentId,
            timestamp: daemonStartedAt,
            event: { type: "turn_started", provider: "codex", turnId },
          },
        },
      }),
    ).toBe(true);
    turn.accept(row({ type: "user_message", clientMessageId: scope.commandId }, 1));
    const target = turn.target!;
    expect(target.startedAt).toBe(daemonStartedAt);
    const request = {
      ...scope,
      expectedAgentId: scope.agentId,
      expectedDaemonTurnId: turnId,
      expectedBindingGeneration: 1,
    };
    expect(matchesLinearPilotStop(target, { ...request, requestedAt: daemonStartedAt })).toBe(
      false,
    );
    expect(
      matchesLinearPilotStop(target, {
        ...request,
        requestedAt: "2026-01-01T00:00:00.251Z",
      }),
    ).toBe(true);
  } finally {
    unsubscribe();
    agents.close();
  }
});

test("2,048 deterministic mismatches never yield an answer or a confirmed exact end", () => {
  const assistant = row(
    { type: "assistant_message", text: "Do not publish", messageId: "final" },
    2,
  );
  for (let caseId = 0; caseId < 2_048; caseId++) {
    const turn = ownedTurn();
    const mismatch = caseId % 9;
    if (mismatch === 0) turn.accept({ ...assistant, epoch: `other-${caseId}` });
    if (mismatch === 1) turn.accept({ ...assistant, seq: 3 + caseId });
    if (mismatch === 2) turn.accept({ ...assistant, seq: 1 });
    if (mismatch === 3)
      turn.accept({ ...assistant, event: { ...assistant.event, turnId: `other-${caseId}` } });
    if (mismatch === 4)
      turn.accept(row({ type: "user_message", clientMessageId: `other-${caseId}` }, 2));
    if (mismatch === 5) turn.accept({ ...assistant, agentId: `other-${caseId}` });
    if (mismatch === 6) turn.accept(assistant);
    if (mismatch === 7) {
      turn.accept({ ...completion, event: { type: "turn_started", provider: "codex" } });
    }
    if (mismatch === 8) {
      turn.accept(assistant);
      turn.accept(row({ type: "assistant_message", text: "Second", messageId: "second" }, 3));
      turn.accept({ ...assistant, seq: 4 });
    }
    const item = turn.accept(
      mismatch === 6
        ? { ...completion, event: { ...completion.event, turnId: `other-${caseId}` } }
        : completion,
    );
    expect(item?.status).not.toBe("completed");
    if (mismatch !== 5) expect(turn.turnEnded).toBe(false);
  }
});

test("retains at most the reply input bound under large streamed text", () => {
  const turn = ownedTurn();
  for (let seq = 2; seq <= 65; seq++) {
    turn.accept(
      row({ type: "assistant_message", text: "x".repeat(32_768), messageId: "final" }, seq),
    );
  }
  const result = turn.accept(completion);
  expect(result).toMatchObject({ status: "completed", answer: { truncated: true } });
  expect(result?.status === "completed" && result.answer.text.length).toBe(MAX_REPLY_INPUT_CHARS);
});

test.each([
  { permitted: 0, frames: [] },
  { permitted: 1, frames: ["fetch_agents_request"] },
  { permitted: 2, frames: ["fetch_agents_request", "agent.timeline.set_subscription.request"] },
])(
  "watch sends no subsequent frame after pilot authorization is lost ($permitted)",
  async ({ permitted, frames }) => {
    const actual: string[] = [];
    const envelope = z.object({ message: z.object({ type: z.string(), requestId: z.string() }) });
    const agents = new DaemonAgents((frame) => {
      const { message } = envelope.parse(JSON.parse(frame));
      actual.push(message.type);
      agents.receive({
        type: "session",
        message: { type: "response", payload: { requestId: message.requestId } },
      });
    });
    agents.receive({
      type: "session",
      message: {
        type: "server_info",
        payload: { features: { hubAgentRpc: true, agentRequestReceipts: true } },
      },
    });
    const listener = vi.fn();
    await expect(
      agents.watch(scope.agentId, listener, async () => actual.length < permitted),
    ).rejects.toBeInstanceOf(DaemonResponseLostError);
    expect(actual).toEqual(frames);
    expect(listener).not.toHaveBeenCalled();
  },
);
