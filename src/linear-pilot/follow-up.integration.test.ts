import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { FakeAgents } from "../interactive-sessions/test-utils/fake-agents.js";
import {
  createPilotFollowUp,
  type PilotFollowUpOptions,
  type PilotTurn,
  type SignedPilotPrompted,
} from "./follow-up.js";
import {
  activity,
  activityPage,
  conversation,
  fixtureActivityIds,
  fixturePromptId,
  initialRows,
  type FixtureActivity,
} from "./test-fixtures.js";

const scope = { ...conversation, teamId: "linear-team" };

async function fixture() {
  const agents = new FakeAgents();
  const profile = {
    provider: "codex",
    cwd: "/synthetic/private",
    env: {},
    background: false,
  } as const;
  const first = await agents.create("initial", profile);
  let turn: PilotTurn = {
    ...scope,
    state: "complete",
    preceding: { activityId: fixturePromptId(1), kind: "answer" },
    generation: 1,
    policyRevision: 2,
    profileId: "private-profile",
    profileVersion: 3,
    hubSessionId: "hub-session-1",
    agentId: first.id,
    daemonTurnId: "daemon-turn-1",
  };
  const receipts = new Set<string>();
  const retired = new Set<string>();
  const writes: { session: string; id: string; body: string }[] = [];
  const reads: { session: string; id: string; limit: number }[] = [];
  const rows = [...initialRows];
  const interruptIntents = new Set<string>();
  let confirmInterrupt = true;
  let lane = Promise.resolve();
  const options: PilotFollowUpOptions = {
    withSession: (_scope, run) => {
      const result = lane.then(run);
      lane = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    activityIds: fixtureActivityIds,
    async current() {
      return turn;
    },
    async claim({ activityId }) {
      if (receipts.has(activityId)) return "duplicate";
      receipts.add(activityId);
      return "claimed";
    },
    async confirmStop(_scope, activityId) {
      return rows.some(({ id, content }) => id === activityId && content.type === "response");
    },
    async appendRefusal() {},
    async readPrompt({ nativeSessionId }, { activityId }) {
      reads.push({ session: nativeSessionId, id: activityId, limit: 1 });
      return activityPage(rows.filter((row) => row.id === activityId));
    },
    async readHistory({ nativeSessionId }, anchor, limit) {
      reads.push({ session: nativeSessionId, id: anchor.activityId, limit });
      return activityPage(rows.filter((row) => row.createdAt < anchor.createdAt).slice(0, limit));
    },
    async appendBusy({ scope: { nativeSessionId }, ids, activityId }) {
      const body = "Still working on the previous message; reply when I have answered.";
      writes.push({ session: nativeSessionId, id: ids.busy, body });
      const row = rows.find(({ id }) => id === activityId);
      assert.ok(row);
      add({
        ...activity(ids.busy, 0, "response", body),
        createdAt: new Date(Date.parse(row.createdAt) + 1).toISOString(),
        signal: "continue",
      });
      return true;
    },
    async secrets() {
      return [];
    },
    async reserve({ turn: expected, activityId }) {
      if (turn !== expected || expected.state !== "complete") return undefined;
      retired.add(expected.hubSessionId);
      const generation = turn.generation + 1;
      const hubSessionId = `hub-session-${generation}`;
      const row = rows.find(({ id }) => id === activityId);
      assert.ok(row);
      turn = {
        ...expected,
        hubSessionId,
        generation,
        state: "busy",
        preceding: null,
        agentId: null,
        daemonTurnId: null,
      };
      let used = false;
      return {
        hubSessionId,
        generation,
        async dispatchInitial(command) {
          assert.equal(used, false);
          used = true;
          assert.equal(hubSessionId, turn.hubSessionId);
          const agent = await agents.create(`isession:${hubSessionId}:1`, profile);
          try {
            await agents.send(agent.id, hubSessionId, command);
          } catch {
            turn = { ...turn, state: "fenced" };
            return "unconfirmed";
          }
          turn = {
            ...turn,
            agentId: agent.id,
            daemonTurnId: `daemon-turn-${generation}`,
            startedAt: row.createdAt,
          };
          return "started";
        },
      };
    },
    async stopCurrent({ turn: expected, activityId, ids, requestedAt }) {
      if (turn !== expected || !expected.agentId || !expected.daemonTurnId) return "ignored";
      assert.ok(expected.startedAt && Date.parse(requestedAt) > Date.parse(expected.startedAt));
      if (interruptIntents.has(expected.daemonTurnId)) return "duplicate";
      interruptIntents.add(expected.daemonTurnId);
      const agent = await agents.get(expected.agentId);
      await agents.control(agent.id, agent.workspaceId, "interrupt");
      if (!confirmInterrupt) {
        turn = { ...expected, state: "fenced" };
        return "unconfirmed";
      }
      agents.emit(agent.id, {
        type: "turn_canceled",
        provider: "codex",
        turnId: expected.daemonTurnId,
        reason: "interrupt",
      });
      add(activity(ids.stop, 9, "response", "Stopped."));
      turn = { ...expected, state: "complete", preceding: { activityId, kind: "stop" } };
      return "stopped";
    },
  };
  function add(row: FixtureActivity) {
    rows.unshift(row);
  }
  function prompt(second: number, body: string): SignedPilotPrompted {
    const id = fixturePromptId(second);
    add(activity(id, second, "prompt", body));
    return {
      ...scope,
      action: "prompted",
      activityId: id,
      body,
      userId: scope.ownerId,
      signal: null,
    };
  }
  function complete(event: SignedPilotPrompted, second: number) {
    assert.ok(turn.agentId && turn.daemonTurnId);
    agents.emit(turn.agentId, {
      type: "turn_completed",
      provider: "codex",
      turnId: turn.daemonTurnId,
    });
    const { response } = fixtureActivityIds(scope.nativeSessionId, event.activityId);
    add(activity(response, second, "response", `Completed ${event.body}`));
    turn = {
      ...turn,
      state: "complete",
      preceding: { activityId: event.activityId, kind: "answer" },
    };
  }
  return {
    agents,
    reads,
    writes,
    receipts,
    retired,
    prompt,
    complete,
    readTurn: () => turn,
    loseInterruptConfirmation: () => {
      confirmInterrupt = false;
    },
    handler: () => createPilotFollowUp(options),
  };
}

describe("Linear pilot follow-up seams with local fakes", () => {
  it("starts one fresh agent per eligible delivery on the same native session and stops only the current one", async () => {
    const f = await fixture();
    const handle = f.handler();
    const first = f.prompt(3, "First follow-up");
    const busy = f.prompt(4, "Not another turn while busy");
    expect(await Promise.all([handle(scope, first), handle(scope, busy)])).toEqual([
      "started",
      "busy",
    ]);
    expect(f.reads).toEqual([
      { session: scope.nativeSessionId, id: first.activityId, limit: 1 },
      { session: scope.nativeSessionId, id: first.activityId, limit: 24 },
    ]);
    expect(f.writes).toEqual([
      {
        session: scope.nativeSessionId,
        id: fixtureActivityIds(scope.nativeSessionId, busy.activityId).busy,
        body: "Still working on the previous message; reply when I have answered.",
      },
    ]);
    const refusal = f.writes[0]!;
    // Linear may return a busy refusal as another app response in a later history page.
    f.complete(first, 6);
    const second = f.prompt(7, "Second follow-up");
    const restarted = f.handler();
    expect(await restarted(scope, busy)).toBe("duplicate");
    expect(await restarted(scope, first)).toBe("duplicate");
    expect(await restarted(scope, second)).toBe("started");
    expect(f.reads).toHaveLength(4);
    expect(f.writes).toEqual([refusal]);
    expect(f.agents.creations.map(({ key }) => key)).toEqual([
      "initial",
      "isession:hub-session-2:1",
      "isession:hub-session-3:1",
    ]);
    expect(f.agents.sends.map(({ agentId }) => agentId)).toEqual(["agent-2", "agent-3"]);
    expect(f.agents.sends[1]?.text).toContain("initial application response");
    expect(f.agents.sends[1]?.text).toContain("Completed First follow-up");
    expect(f.agents.sends[1]?.text).not.toContain("Not another turn while busy");
    expect(f.readTurn()).toMatchObject({
      nativeSessionId: scope.nativeSessionId,
      generation: 3,
      profileId: "private-profile",
      profileVersion: 3,
    });
    expect([...f.retired]).toEqual(["hub-session-1", "hub-session-2"]);
    expect([...f.receipts]).toEqual([first.activityId, busy.activityId, second.activityId]);
    const stop = {
      ...second,
      activityId: fixturePromptId(8),
      signal: "stop",
      body: null,
      createdAt: activity("stop-1", 8, "prompt", "").createdAt,
    };
    const staleStop = {
      ...stop,
      activityId: fixturePromptId(5),
      createdAt: activity("delayed-stop", 5, "prompt", "").createdAt,
    };
    expect(await restarted(scope, staleStop)).toBe("ignored");
    const { createdAt: _createdAt, ...withoutTime } = stop;
    expect(await restarted(scope, { ...withoutTime, activityId: fixturePromptId(10) })).toBe(
      "ignored",
    );
    expect(
      await restarted(scope, {
        ...stop,
        activityId: fixturePromptId(11),
        createdAt: f.readTurn().startedAt!,
      }),
    ).toBe("ignored");
    expect(
      await restarted(scope, {
        ...stop,
        activityId: fixturePromptId(12),
        createdAt: "not-a-time",
      }),
    ).toBe("ignored");
    expect(f.agents.interrupts).toHaveLength(0);
    expect(await restarted(scope, stop)).toBe("stopped");
    expect(await restarted(scope, stop)).toBe("duplicate");
    expect(await restarted(scope, { ...stop, activityId: fixturePromptId(13) })).toBe("ignored");
    expect(f.agents.interrupts).toEqual(["agent-3"]);
    expect(f.agents.archives).toEqual([]);
    expect(await restarted(scope, f.prompt(14, "Continue after confirmed Stop"))).toBe("started");
    expect(f.agents.sends[2]?.text).not.toContain("Stopped.");
  });

  it("does not start a delayed prompt that predates the current binding's confirmed answer", async () => {
    const f = await fixture();
    const handle = f.handler();
    const first = f.prompt(3, "New turn");
    const delayed = f.prompt(4, "Sent while the new turn was busy");
    expect(await handle(scope, first)).toBe("started");
    f.complete(first, 5);
    expect(await handle(scope, delayed)).toBe("ignored");
    expect(await f.handler()(scope, delayed)).toBe("duplicate");
    expect(f.agents.sends).toHaveLength(1);
    expect(f.writes).toHaveLength(0);
  });

  it("fences a possible initial send and never replays it or creates a successor", async () => {
    const f = await fixture();
    f.agents.afterSend = async () => {
      throw new Error("synthetic loss after write");
    };
    const first = f.prompt(3, "Lost send");
    expect(await f.handler()(scope, first)).toBe("unconfirmed");
    const restart = f.handler();
    expect(await restart(scope, first)).toBe("ignored");
    expect(await restart(scope, f.prompt(4, "Do not start"))).toBe("ignored");
    expect(f.agents.creations).toHaveLength(2);
    expect(f.agents.sends).toHaveLength(1);
    expect(f.reads).toHaveLength(2);
  });

  it("fences an unconfirmed Stop and issues at most one interrupt", async () => {
    const f = await fixture();
    const handle = f.handler();
    const first = f.prompt(3, "New turn");
    expect(await handle(scope, first)).toBe("started");
    f.loseInterruptConfirmation();
    const stop = {
      ...first,
      activityId: fixturePromptId(4),
      signal: "stop",
      body: null,
      createdAt: activity("stop", 4, "prompt", "").createdAt,
    };
    expect(await handle(scope, stop)).toBe("unconfirmed");
    expect(await f.handler()(scope, { ...stop, activityId: fixturePromptId(5) })).toBe("ignored");
    expect(f.agents.interrupts).toEqual(["agent-2"]);
  });
});
