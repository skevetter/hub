import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import { createMemoryDatabase, type MemoryDatabaseOptions } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import type { Database } from "../db/types.js";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "../db/runtime/index.js";
import { SessionEventBus } from "../interactive-sessions/bus.js";
import { InteractiveSessionCoordinator } from "../interactive-sessions/coordinator.js";
import { readInteractiveSessionSettings } from "../interactive-sessions/settings.js";
import { FakeAgents } from "../interactive-sessions/test-utils/fake-agents.js";
import { prepareProfile, surfaceTenant, type SurfaceTenant } from "../surfaces/store.contract.js";
import * as pilotSession from "./session.js";
import {
  type LinearPilotCommand,
  type LinearPilotRetirement,
  type LinearPilotSessionHooks,
  type LinearPilotStopRequest,
  type LinearPilotTerminal,
} from "./session.js";

const { LINEAR_PILOT_FRESH_BODY } = pilotSession;

const daemonStartedAt = "2026-01-01T00:00:02.000Z";

const open: InteractiveSessionCoordinator[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((coordinator) => coordinator.stopAccepting()));
});

async function fixture(stopTimeoutMs = 2_000, maxActive?: number) {
  const tenant = surfaceTenant();
  const { organizationId } = tenant;
  const principal = { organizationId, userId: tenant.userId, role: "owner" as const };
  const membership: NonNullable<MemoryDatabaseOptions["memberships"]>[number] = {
    ...principal,
    organizationSlug: "tenant",
    organizationName: "Tenant",
    membershipId: tenant.userId,
  };
  const database = createMemoryDatabase({
    memberships: [membership],
    linearConnections: [tenant.connection],
  });
  return {
    ...(await preparedFixture(database, tenant, stopTimeoutMs, maxActive)),
    demote: () => {
      membership.role = "admin";
    },
  };
}

async function preparedFixture(
  database: Database,
  tenant: SurfaceTenant,
  stopTimeoutMs: number,
  maxActive?: number,
) {
  const { organizationId } = tenant;
  const principal = { organizationId, userId: tenant.userId, role: "owner" as const };
  const { profile: initialProfile } = await prepareProfile(database, tenant);
  const profile =
    maxActive === undefined
      ? initialProfile
      : await database.saveSessionProfile({
          ...initialProfile,
          principal,
          maxActive,
          now: new Date(),
        });
  assert.ok(typeof profile !== "string");
  const { daemonId } = profile;
  const identity = await database.createSurfaceIdentity({
    organizationId,
    userId: tenant.userId,
    workspaceId: tenant.connection.linearOrganizationId,
    providerUserId: randomUUID(),
    label: "Synthetic owner",
    now: new Date(),
  });
  assert.ok(identity);
  const agents = new FakeAgents();
  const interrupt = agents.control.bind(agents);
  agents.connection.agents.control = async (id, workspace, action, onWritten) => {
    onWritten?.();
    await interrupt(id, workspace, action);
  };
  const watch = agents.watch.bind(agents);
  agents.connection.agents.watch = (agentId, listener) =>
    watch(agentId, (event) => {
      listener(
        event.type === "agent_stream" && event.event.type === "turn_started"
          ? { ...event, wireTimestamp: daemonStartedAt }
          : event,
      );
    });
  const onTerminal = vi.fn<(terminal: LinearPilotTerminal) => void>();
  const authorizeStart = vi.fn<LinearPilotSessionHooks["authorizeStart"]>(async () => true);
  const authorizes = vi.fn<LinearPilotSessionHooks["authorize"]>(async () => true);
  function createCoordinator() {
    const coordinator = new InteractiveSessionCoordinator({
      database,
      entitlements: {
        async meterReservation(_org, meter) {
          return { meter, periodStart: new Date(0), limit: 20 };
        },
      },
      connectionForDaemon: (id) => (id === daemonId ? agents.connection : undefined),
      bus: new SessionEventBus(),
      settings: { ...readInteractiveSessionSettings({}), enabled: true },
      instanceId: randomUUID(),
      reportFailure: vi.fn(),
      linearPilot: { authorizeStart, authorize: authorizes, onTerminal, stopTimeoutMs },
      scrubValues: ["synthetic-private-credential"],
    });
    open.push(coordinator);
    return coordinator;
  }
  const coordinator = createCoordinator();
  const input = {
    profileId: profile.id,
    profileVersion: profile.version,
    idempotencyKey: randomUUID(),
    message: "Synthetic prompt",
    nativeRequester: { identityId: identity.id, workspaceId: identity.workspaceId },
  };
  async function start(): Promise<LinearPilotCommand> {
    const result = await coordinator.startLinearPilot(principal, input);
    assert.equal(result.outcome, "accepted");
    const { sessionId, commandId } = result;
    expect(agents.creations).toEqual([]);
    return { organizationId, sessionId, commandId };
  }
  function emit(event: Parameters<FakeAgents["emit"]>[1], seq?: number) {
    agents.emit(
      "agent-1",
      { ...event, turnId: "synthetic-turn" },
      seq === undefined ? undefined : { epoch: "synthetic-epoch", seq },
    );
  }
  function echo({ commandId }: LinearPilotCommand) {
    emit({ type: "turn_started", provider: "codex" });
    emit(
      {
        type: "timeline",
        provider: "codex",
        item: { type: "user_message", clientMessageId: commandId },
      },
      1,
    );
  }
  async function running() {
    const command = await start();
    agents.afterSend = async () => echo(command);
    await coordinator.dispatchLinearPilotStart(command);
    expect(agents.sends).toHaveLength(1);
    return command;
  }
  async function stopRequest(
    scope: LinearPilotCommand,
    expectedBindingGeneration = 1,
  ): Promise<LinearPilotStopRequest> {
    const target = await coordinator.activeLinearPilotTurn(scope);
    assert.ok(target?.startedAt);
    return {
      ...scope,
      expectedAgentId: target.agentId,
      expectedDaemonTurnId: target.daemonTurnId,
      expectedBindingGeneration,
      requestedAt: new Date(Date.parse(target.startedAt) + 1_000).toISOString(),
    };
  }
  return {
    agents,
    database,
    principal,
    coordinator,
    createCoordinator,
    input,
    start,
    running,
    stopRequest,
    echo,
    emit,
    onTerminal,
    authorizes,
    authorizeStart,
    unlinkRequester: () => database.removeSurfaceIdentity(identity),
  };
}

test("memory refuses a pilot starter demoted after the config authorizer without charging", async () => {
  const f = await fixture();
  f.authorizeStart.mockImplementationOnce(async () => {
    f.demote();
    return true;
  });
  await expect(f.coordinator.startLinearPilot(f.principal, f.input)).resolves.toEqual({
    outcome: "refused",
    code: "forbidden",
  });
  const { organizationId } = f.principal;
  expect(await f.database.listRecoverableInteractiveSessions(organizationId, null)).toEqual([]);
  expect(
    await f.database.getOrganizationUsage(organizationId, "executions.monthly", new Date(0)),
  ).toBeUndefined();
  expect(f.agents.creations).toEqual([]);
  expect(f.agents.sends).toEqual([]);
});

test("only the private owner-native start admits S1 identity and waits for binding before daemon work", async () => {
  const f = await fixture();
  await expect(
    f.coordinator.startLinearPilot({ ...f.principal, role: "admin" }, f.input),
  ).resolves.toEqual({
    outcome: "refused",
    code: "forbidden",
  });
  const session = await f.start();
  const row = await f.database.findInteractiveSession(session.organizationId, session.sessionId);
  expect(row?.session).toMatchObject({
    origin: "linear",
    requesterIdentityId: f.input.nativeRequester.identityId,
  });
  expect(row?.participants.map(({ userId }) => userId)).toEqual([f.principal.userId]);
  await expect(f.coordinator.startLinearPilot(f.principal, f.input)).resolves.toMatchObject({
    replayed: true,
    sessionId: session.sessionId,
    commandId: session.commandId,
  });
  f.authorizes.mockResolvedValue(false);
  await f.coordinator.dispatchLinearPilotStart(session);
  expect(f.agents.creations).toEqual([]);
});

test("authority loss while create is in flight prevents every subsequent pilot RPC", async () => {
  const f = await fixture();
  const input = await f.start();
  f.agents.afterCreate = async () => {
    f.authorizes.mockResolvedValue(false);
  };
  await f.coordinator.dispatchLinearPilotStart(input);
  expect(f.agents.creations).toHaveLength(1);
  expect(f.agents.watches).toEqual([]);
  expect(f.agents.sends).toEqual([]);
  expect(f.onTerminal).not.toHaveBeenCalled();
});

test("the existing watch emits only its exact final assistant block with no SSE reader", async () => {
  const f = await fixture();
  const input = await f.start();
  f.agents.afterSend = async () => {
    f.echo(input);
    f.emit(
      {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "Intermediate text", messageId: "first" },
      },
      2,
    );
    f.emit(
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "tool_call",
          name: "read",
          status: "completed",
          result: "Synthetic tool output",
        },
      },
      3,
    );
    f.emit(
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: "Final synthetic-private-credential",
          messageId: "final",
        },
      },
      4,
    );
    f.emit({ type: "turn_completed", provider: "codex" });
  };
  await f.coordinator.dispatchLinearPilotStart(input);
  await vi.waitFor(() => expect(f.onTerminal).toHaveBeenCalledTimes(1));
  expect(f.onTerminal).toHaveBeenCalledWith(
    expect.objectContaining({
      ...input,
      generation: 1,
      hubTurn: 1,
      agentId: "agent-1",
      epoch: "synthetic-epoch",
      daemonTurnId: "synthetic-turn",
      status: "completed",
      seq: 4,
      messageId: "final",
    }),
  );
  const terminal = f.onTerminal.mock.calls[0]?.[0];
  expect(terminal?.status === "completed" && terminal.answer.text).toContain("Final ");
  expect(terminal?.status === "completed" && terminal.answer.truncated).toBe(false);
  expect(JSON.stringify(f.onTerminal.mock.calls)).not.toMatch(
    /synthetic-private-credential|Intermediate text|Synthetic tool output/u,
  );
  expect(f.agents.watches).toEqual(["agent-1"]);
  await expect(f.coordinator.sendLinearPilot(input)).resolves.toMatchObject({
    outcome: "refused",
    code: "invalid_mode",
  });
  expect(f.agents.sends).toHaveLength(1);
});

async function completedRetirement(
  f: Awaited<ReturnType<typeof preparedFixture>>,
): Promise<LinearPilotRetirement> {
  await f.running();
  f.emit(
    {
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "First final answer", messageId: "final" },
    },
    2,
  );
  f.emit({ type: "turn_completed", provider: "codex" });
  await vi.waitFor(() => expect(f.onTerminal).toHaveBeenCalledTimes(1));
  const terminal = f.onTerminal.mock.calls[0]?.[0];
  assert.equal(terminal?.status, "completed");
  const { organizationId, sessionId, commandId, agentId, generation, hubTurn } = terminal;
  return {
    organizationId,
    sessionId,
    commandId,
    profileId: f.input.profileId,
    workspaceId: f.input.nativeRequester.workspaceId,
    agentId,
    generation,
    hubTurn,
    expectedBindingGeneration: 1,
  };
}

test("capacity-one retirement closes the exact idle predecessor before one fresh dispatch", async () => {
  const f = await fixture(2_000, 1);
  const prior = await completedRetirement(f);
  const { message: _storedBody, ...metadata } = f.input;
  const successor = { ...metadata, idempotencyKey: randomUUID() };
  await expect(
    f.coordinator.startLinearPilot(f.principal, { ...successor, message: "Capacity probe" }),
  ).resolves.toEqual({ outcome: "refused", code: "active_limit" });
  f.authorizes.mockImplementation(
    async (session, commandId, bindingGeneration) =>
      session.id === prior.sessionId && commandId === prior.commandId && bindingGeneration === 1,
  );
  await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(true);
  const { organizationId, sessionId } = prior;
  const closed = await f.database.findInteractiveSession(organizationId, sessionId);
  expect(closed?.session).toMatchObject({
    state: "closed",
    stateReason: null,
    closedByUserId: null,
    generation: prior.generation,
    turn: prior.hubTurn,
    daemonAgentId: prior.agentId,
  });
  expect(closed?.session.closedAt).toBeInstanceOf(Date);
  await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);
  expect(f.agents.creations).toHaveLength(1);
  expect(f.agents.interrupts).toEqual([]);
  expect(f.agents.archives).toEqual([]);
  const fresh = await f.coordinator.reserveLinearPilotFreshStart(f.principal, successor);
  assert.equal(fresh.outcome, "accepted");
  assert.equal(fresh.replayed, false);
  f.authorizes.mockImplementation(
    async (session, commandId) => session.id === fresh.sessionId && commandId === fresh.commandId,
  );
  f.agents.afterSend = async () => {
    f.agents.emit("agent-2", { type: "turn_started", provider: "codex", turnId: "successor" });
    f.agents.emit(
      "agent-2",
      {
        type: "timeline",
        provider: "codex",
        turnId: "successor",
        item: { type: "user_message", clientMessageId: fresh.commandId },
      },
      { seq: 1, epoch: "successor-epoch" },
    );
  };
  await expect(fresh.dispatch("Volatile continuation")).resolves.toBe("started");
  expect(f.agents.sends.map(({ agentId }) => agentId)).toEqual(["agent-1", "agent-2"]);
});

test("retirement refusals leave the predecessor and daemon effects unchanged", async () => {
  const f = await fixture(2_000, 1);
  const scope = await f.running();
  const prior = {
    ...scope,
    profileId: f.input.profileId,
    workspaceId: f.input.nativeRequester.workspaceId,
    agentId: "agent-1",
    generation: 1,
    hubTurn: 1,
    expectedBindingGeneration: 1,
  };
  await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);

  f.emit({ type: "turn_canceled", provider: "codex", reason: "interrupted" });
  await vi.waitFor(() => expect(f.onTerminal).toHaveBeenCalledTimes(1));
  const { organizationId, sessionId } = prior;
  const before = await f.database.findInteractiveSession(organizationId, sessionId);
  expect(before?.session.state).toBe("idle");
  for (const stale of [
    { ...prior, generation: prior.generation + 1 },
    { ...prior, hubTurn: prior.hubTurn + 1 },
    { ...prior, agentId: "different-agent" },
    { ...prior, profileId: randomUUID() },
    { ...prior, workspaceId: randomUUID() },
    { ...prior, commandId: randomUUID() },
  ]) {
    await expect(f.coordinator.retireLinearPilotTurn(f.principal, stale)).resolves.toBe(false);
  }
  await expect(
    f.coordinator.retireLinearPilotTurn({ ...f.principal, userId: "different-owner" }, prior),
  ).resolves.toBe(false);
  f.authorizes.mockResolvedValueOnce(false);
  await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);
  f.authorizes.mockImplementationOnce(async () => {
    f.demote();
    return true;
  });
  await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);
  expect(await f.database.findInteractiveSession(organizationId, sessionId)).toEqual(before);
  expect(f.agents.creations).toHaveLength(1);
  expect(f.agents.sends).toHaveLength(1);
  expect(f.agents.interrupts).toEqual([]);
  expect(f.agents.archives).toEqual([]);
});

test("retirement refuses a requester unlink after binding authority", async () => {
  const f = await fixture();
  const prior = await completedRetirement(f);
  const before = await f.database.findInteractiveSession(prior.organizationId, prior.sessionId);
  f.authorizes.mockImplementationOnce(async () => {
    expect(await f.unlinkRequester()).toBe(true);
    return true;
  });
  await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);
  expect(await f.database.findInteractiveSession(prior.organizationId, prior.sessionId)).toEqual(
    before,
  );
  expect(f.agents.creations).toHaveLength(1);
  expect(f.agents.sends).toHaveLength(1);
  expect(f.agents.interrupts).toEqual([]);
  expect(f.agents.archives).toEqual([]);
});

test("fresh dispatch sends the volatile prompt once and the Hub command holds only its placeholder", async () => {
  const f = await fixture();
  const { message: _storedBody, ...metadata } = f.input;
  const reserved = await f.coordinator.reserveLinearPilotFreshStart(f.principal, metadata);
  assert.equal(reserved.outcome, "accepted");
  assert.equal(reserved.replayed, false);
  const scope = {
    organizationId: f.principal.organizationId,
    sessionId: reserved.sessionId,
    commandId: reserved.commandId,
  };
  await f.coordinator.dispatchLinearPilotStart(scope);
  expect(f.agents.creations).toEqual([]);
  const prompt = "Quoted synthetic history, followed by the new message";
  f.agents.afterSend = async () => f.echo(scope);
  const started = reserved.dispatch(prompt);
  const duplicate = reserved.dispatch("Must not replace the prompt");
  await expect(started).resolves.toBe("started");
  await expect(duplicate).resolves.toBe("unconfirmed");
  expect(f.agents.creations).toHaveLength(1);
  expect(f.agents.sends).toEqual([
    { agentId: "agent-1", messageId: scope.commandId, text: prompt },
  ]);
  const messages = await f.database.listInteractiveSessionMessages(
    scope.organizationId,
    scope.sessionId,
    { beforeOrdinal: null, limit: 2 },
    null,
  );
  expect(messages).toMatchObject([
    { commandId: scope.commandId, body: LINEAR_PILOT_FRESH_BODY, status: "delivered" },
  ]);
  expect(JSON.stringify(messages)).not.toContain(prompt);
  const events = await f.database.listInteractiveSessionEvents(
    scope.organizationId,
    scope.sessionId,
    0,
    20,
  );
  expect(JSON.stringify(events)).not.toContain(prompt);
});

test.each(["\u00e9".repeat(8_193), "contains\0nul", ""])(
  "invalid volatile text consumes the fresh permit without a daemon call (%#)",
  async (prompt) => {
    const f = await fixture();
    const { message: _storedBody, ...metadata } = f.input;
    const reserved = await f.coordinator.reserveLinearPilotFreshStart(f.principal, metadata);
    assert.equal(reserved.outcome, "accepted");
    assert.equal(reserved.replayed, false);
    await expect(reserved.dispatch(prompt)).resolves.toBe("unconfirmed");
    await expect(reserved.dispatch("Valid text cannot reuse the permit")).resolves.toBe(
      "unconfirmed",
    );
    expect(f.agents.creations).toEqual([]);
    expect(f.agents.watches).toEqual([]);
    expect(f.agents.sends).toEqual([]);
  },
);

test("restart cannot rebuild an unused fresh dispatch permit", async () => {
  const f = await fixture();
  const { message: _storedBody, ...metadata } = f.input;
  const reserved = await f.coordinator.reserveLinearPilotFreshStart(f.principal, metadata);
  assert.equal(reserved.outcome, "accepted");
  assert.equal(reserved.replayed, false);
  await f.coordinator.stopAccepting();
  const restarted = f.createCoordinator();
  const replay = await restarted.reserveLinearPilotFreshStart(f.principal, metadata);
  expect(replay).toMatchObject({
    outcome: "accepted",
    replayed: true,
    sessionId: reserved.sessionId,
    commandId: reserved.commandId,
  });
  expect(replay).not.toHaveProperty("dispatch");
  await restarted.dispatchLinearPilotStart({
    organizationId: f.principal.organizationId,
    sessionId: reserved.sessionId,
    commandId: reserved.commandId,
  });
  await expect(reserved.dispatch("Old process permit")).resolves.toBe("unconfirmed");
  expect(f.agents.creations).toEqual([]);
  expect(f.agents.sends).toEqual([]);
});

test("fresh send acknowledgement without a canonical echo is unconfirmed and never publishes later text", async () => {
  const f = await fixture();
  const { message: _storedBody, ...metadata } = f.input;
  const reserved = await f.coordinator.reserveLinearPilotFreshStart(f.principal, metadata);
  assert.equal(reserved.outcome, "accepted");
  assert.equal(reserved.replayed, false);
  await expect(reserved.dispatch("Volatile but unproven")).resolves.toBe("unconfirmed");
  f.echo({
    organizationId: f.principal.organizationId,
    sessionId: reserved.sessionId,
    commandId: reserved.commandId,
  });
  f.emit({ type: "turn_completed", provider: "codex" });
  await expect(reserved.dispatch("Must not be retried")).resolves.toBe("unconfirmed");
  const [message] = await f.database.listInteractiveSessionMessages(
    f.principal.organizationId,
    reserved.sessionId,
    { beforeOrdinal: null, limit: 1 },
    null,
  );
  expect(message).toMatchObject({ status: "unknown", failureCode: "delivery_unconfirmed" });
  expect(f.agents.sends).toHaveLength(1);
  expect(f.onTerminal).not.toHaveBeenCalled();
});

test("after the authorized binding moves, Stop interrupts only the freshly bound live turn", async () => {
  const f = await fixture();
  const old = await f.running();
  const stale = await f.stopRequest(old);
  const { message: _storedBody, ...metadata } = f.input;
  const fresh = await f.coordinator.reserveLinearPilotFreshStart(f.principal, {
    ...metadata,
    idempotencyKey: randomUUID(),
  });
  assert.equal(fresh.outcome, "accepted");
  assert.equal(fresh.replayed, false);
  f.authorizes.mockImplementation(
    async (session, _, generation) =>
      session.id === fresh.sessionId && (generation === undefined || generation === 2),
  );
  f.agents.afterSend = async () => {
    f.agents.emit("agent-2", { type: "turn_started", provider: "codex", turnId: "new-turn" });
    f.agents.emit(
      "agent-2",
      {
        type: "timeline",
        provider: "codex",
        turnId: "new-turn",
        item: { type: "user_message", clientMessageId: fresh.commandId },
      },
      { seq: 1, epoch: "new-epoch" },
    );
  };
  await expect(fresh.dispatch("Fresh conversation context")).resolves.toBe("started");
  await expect(f.coordinator.stopLinearPilot(stale)).resolves.toMatchObject({
    status: "unconfirmed",
  });
  expect(f.agents.interrupts).toEqual([]);
  f.agents.afterInterrupt = async () =>
    f.agents.emit("agent-2", {
      type: "turn_canceled",
      provider: "codex",
      turnId: "new-turn",
      reason: "interrupted",
    });
  const current = await f.stopRequest(
    {
      organizationId: old.organizationId,
      sessionId: fresh.sessionId,
      commandId: fresh.commandId,
    },
    2,
  );
  await expect(
    f.coordinator.stopLinearPilot({ ...current, expectedBindingGeneration: 1 }),
  ).resolves.toMatchObject({
    status: "unconfirmed",
  });
  expect(f.agents.interrupts).toEqual([]);
  await expect(f.coordinator.stopLinearPilot(current)).resolves.toMatchObject({
    status: "stopped",
    target: { agentId: "agent-2", daemonTurnId: "new-turn" },
  });
  expect(f.agents.interrupts).toEqual(["agent-2"]);
  expect(f.agents.sends.map(({ agentId }) => agentId)).toEqual(["agent-1", "agent-2"]);
});

test("a lost prompt admission is never retried or promoted by terminal events", async () => {
  const f = await fixture();
  const input = await f.start();
  f.agents.afterSend = async () => {
    f.echo(input);
    f.emit(
      {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "Unverified", messageId: "answer" },
      },
      2,
    );
    f.emit({ type: "turn_completed", provider: "codex" });
    throw new DaemonResponseLostError();
  };
  await f.coordinator.dispatchLinearPilotStart(input);
  await f.coordinator.dispatchLinearPilotStart(input);
  expect(f.agents.sends).toHaveLength(1);
  expect(f.onTerminal).not.toHaveBeenCalled();
  const [row] = await f.database.listInteractiveSessionMessages(
    input.organizationId,
    input.sessionId,
    { beforeOrdinal: null, limit: 1 },
    null,
  );
  expect(row).toMatchObject({ status: "unknown", failureCode: "delivery_unconfirmed" });
});

test("permission replies and busy follow-ups refuse without sending a daemon prompt", async () => {
  const f = await fixture();
  const input = await f.running();
  await expect(f.coordinator.sendLinearPilot(input)).resolves.toMatchObject({
    outcome: "refused",
    code: "invalid_mode",
  });
  f.emit({ type: "permission_requested", provider: "codex", request: { id: "approval" } });
  await expect(f.coordinator.sendLinearPilot(input)).resolves.toMatchObject({
    outcome: "refused",
    code: "waiting_permission",
  });
  expect(f.agents.sends).toHaveLength(1);
});

test("while Stop waits for exact turn evidence, competing Hub work cannot send or cancel", async () => {
  const f = await fixture();
  const input = await f.running();
  const request = await f.stopRequest(input);
  const turn = await f.coordinator.activeLinearPilotTurn(input);
  assert.ok(turn?.startedAt);
  expect(turn.startedAt).toBe(daemonStartedAt);
  for (const stale of [
    { ...request, commandId: randomUUID() },
    { ...request, expectedDaemonTurnId: "other-turn" },
    { ...request, requestedAt: turn.startedAt },
    { ...request, requestedAt: "invalid-time" },
  ]) {
    await expect(f.coordinator.stopLinearPilot(stale)).resolves.toMatchObject({
      status: "unconfirmed",
    });
  }
  expect(await f.coordinator.activeLinearPilotTurn(input)).toEqual(turn);

  expect(f.agents.interrupts).toEqual([]);
  const wroteStop = Promise.withResolvers<void>();
  f.agents.afterInterrupt = async () => wroteStop.resolve();
  const stop = f.coordinator.stopLinearPilot(request);
  await wroteStop.promise;
  const native = { ...input, generation: 1, idempotencyKey: randomUUID() };
  const [followUp, ...browser] = await Promise.all([
    f.coordinator.sendLinearPilot(input),
    f.coordinator.send(f.principal, { ...native, message: "browser prompt", delivery: "steer" }),
    f.coordinator.stop(f.principal, native),
    f.coordinator.close(f.principal, native),
    f.coordinator.replaceAgent(f.principal, native),
  ]);
  expect(followUp).toEqual({ outcome: "refused", code: "session_stopping" });
  for (const refusal of browser) expect(refusal).toEqual({ outcome: "refused", code: "forbidden" });
  const duplicateStop = f.coordinator.stopLinearPilot(request);
  f.emit({ type: "turn_canceled", provider: "codex", reason: "interrupted" });
  await expect(stop).resolves.toEqual({
    status: "stopped",
    message: "Stopped.",
    target: {
      ...input,
      daemonId: (await f.database.findInteractiveSession(input.organizationId, input.sessionId))
        ?.session.daemonId,
      generation: 1,
      hubTurn: 1,
      agentId: "agent-1",
      daemonTurnId: "synthetic-turn",
      epoch: "synthetic-epoch",
      startedAt: turn.startedAt,
    },
  });
  await expect(duplicateStop).resolves.toMatchObject({ status: "unconfirmed" });
  expect(f.agents.interrupts).toEqual(["agent-1"]);
  expect(f.agents.sends).toHaveLength(1);
  expect(f.onTerminal).not.toHaveBeenCalled();
});

test("an unconfirmed Stop remains fenced and cannot produce a stopped or late answer", async () => {
  const f = await fixture(20);
  const input = await f.running();
  const request = await f.stopRequest(input);
  await expect(f.coordinator.stopLinearPilot(request)).resolves.toMatchObject({
    status: "unconfirmed",
    message: "Stop requested; I could not confirm it stopped",
    target: { daemonTurnId: "synthetic-turn" },
  });
  f.emit(
    {
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "Late", messageId: "late" },
    },
    2,
  );
  f.emit({ type: "turn_completed", provider: "codex" });
  await f.coordinator.dispatchLinearPilotStart(input);
  await expect(f.coordinator.sendLinearPilot(input)).resolves.toMatchObject({ outcome: "refused" });
  await expect(f.coordinator.stopLinearPilot(request)).resolves.toMatchObject({
    status: "unconfirmed",
  });
  expect(f.agents.interrupts).toEqual(["agent-1"]);
  expect(f.agents.sends).toHaveLength(1);
  expect(f.onTerminal).not.toHaveBeenCalled();
  const row = await f.database.findInteractiveSession(input.organizationId, input.sessionId);
  expect(row?.session.state).toBe("stopping");
});

async function withEmbeddedPilotTenant(
  run: (runtime: DatabaseRuntime, database: Database, tenant: SurfaceTenant) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "hub-pilot-session-"));
  try {
    const { runtime, locks } = await embeddedDatabaseRuntime(root);
    try {
      await runtime.migrate();
      const tenant = surfaceTenant();
      const { organizationId, userId, connection } = tenant;
      const database = createDatabase(runtime, locks);
      await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
        organizationId,
      ]);
      const owner = { organizationId, userId, role: "owner" as const };
      const peer = { organizationId, userId: userId + "-peer", role: "owner" as const };
      const admin = { organizationId, userId: userId + "-admin", role: "admin" as const };
      for (const principal of [owner, peer, admin]) {
        await runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
          principal.userId,
          principal.userId + "@example.test",
        ]);
        await runtime.query(
          "insert into member (id, organization_id, user_id, role) values ($1, $2, $1, $3)",
          [principal.userId, organizationId, principal.role],
        );
      }
      await runtime.query(
        `insert into linear_connections (id, organization_id, linear_organization_id, provider_application_id, slug, linear_organization_name, app_user_id, access_token) values ($1,$2,$3,$4,$5,$5,$6,$7)`,
        [
          connection.id,
          organizationId,
          connection.linearOrganizationId,
          connection.providerApplicationId,
          connection.slug,
          connection.appUserId,
          connection.accessToken,
        ],
      );
      await run(runtime, database, tenant);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SQL filters native list pages and refuses stale owner authority before any start writes", async () => {
  await withEmbeddedPilotTenant(
    async (runtime, database, { organizationId, userId, connection }) => {
      const owner = { organizationId, userId, role: "owner" as const };
      const peer = { organizationId, userId: userId + "-peer", role: "owner" as const };
      const admin = { organizationId, userId: userId + "-admin", role: "admin" as const };
      const identity = await database.createSurfaceIdentity({
        organizationId,
        workspaceId: connection.linearOrganizationId,
        userId,
        providerUserId: randomUUID(),
        label: "Synthetic owner",
        now: new Date(),
      });
      assert.ok(identity);
      const { profile, request } = await prepareProfile(database, {
        organizationId,
        userId,
        connection,
      });
      const nativeRequester = { identityId: identity.id, workspaceId: identity.workspaceId };
      const web = await database.startInteractiveSession(request);
      assert.equal(web.status, "created");
      const native = await database.startInteractiveSession({
        ...request,
        idempotencyKey: randomUUID(),
        now: new Date(request.now.getTime() + 1_000),
        nativeRequester,
      });
      assert.equal(native.status, "created");
      for (const viewer of [owner, admin, peer]) {
        const found = await database.listInteractiveSessions(organizationId, viewer, {
          filter: "all",
          cursor: null,
          limit: 1,
        });
        expect(found.sessions.map(({ id }) => id)).toEqual([
          viewer === owner ? native.session.id : web.session.id,
        ]);
        expect(found.nextCursor === null).toBe(viewer !== owner);
      }
      const persisted = () =>
        runtime.query<{ sessions: number; commands: number }>(
          `select (select count(*)::int from interactive_sessions where organization_id = $1) as sessions,
              (select count(*)::int from interactive_session_commands where organization_id = $1) as commands`,
          [organizationId],
        );
      const usage = () =>
        database.getOrganizationUsage(organizationId, "executions.monthly", request.now);
      const agents = new FakeAgents();
      const coordinator = new InteractiveSessionCoordinator({
        database,
        entitlements: { meterReservation: async (_org, meter) => ({ meter, ...request.usage }) },
        connectionForDaemon: (id) => (id === profile.daemonId ? agents.connection : undefined),
        bus: new SessionEventBus(),
        settings: { ...readInteractiveSessionSettings({}), enabled: true },
        instanceId: randomUUID(),
        reportFailure: vi.fn(),
        linearPilot: {
          authorizeStart: async () => {
            await runtime.query(
              "update member set role = 'admin' where organization_id = $1 and user_id = $2",
              [organizationId, userId],
            );
            return true;
          },
          authorize: async () => false,
          onTerminal: vi.fn(),
        },
      });
      open.push(coordinator);
      const initialCounts = (await persisted()).rows;
      const initialUsage = await usage();
      expect(initialCounts).toEqual([{ sessions: 2, commands: 2 }]);
      expect(initialUsage?.used).toBe(2);
      await expect(
        coordinator.startLinearPilot(owner, {
          profileId: request.profileId,
          profileVersion: request.profileVersion,
          idempotencyKey: randomUUID(),
          message: "Owner demoted after precheck",
          nativeRequester,
        }),
      ).resolves.toEqual({ outcome: "refused", code: "forbidden" });
      expect((await persisted()).rows).toEqual(initialCounts);
      expect(await usage()).toEqual(initialUsage);
      expect(agents.creations).toEqual([]);
      const demoted = await database.listInteractiveSessions(organizationId, owner, {
        filter: "all",
        cursor: null,
        limit: 1,
      });
      expect(demoted.sessions.map(({ id }) => id)).toEqual([web.session.id]);
      const generalStart = await database.startInteractiveSession({
        ...request,
        principal: { ...owner, role: "admin" },
        idempotencyKey: randomUUID(),
        nativeRequester,
      });
      expect(generalStart.status).toBe("created");
    },
  );
});

test("SQL retires the exact delivered idle predecessor with the existing closed tuple", async () => {
  await withEmbeddedPilotTenant(async (runtime, database, tenant) => {
    const f = await preparedFixture(database, tenant, 2_000, 1);
    const prior = await completedRetirement(f);
    const { organizationId, sessionId, commandId } = prior;
    const before = await database.findInteractiveSession(organizationId, sessionId);

    const changeRole = (role: string) =>
      runtime.query("update member set role = $3 where organization_id = $1 and user_id = $2", [
        organizationId,
        tenant.userId,
        role,
      ]);
    f.authorizes.mockImplementationOnce(async () => {
      await changeRole("admin");
      return true;
    });
    await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);
    await changeRole("owner");

    await runtime.query(
      "update interactive_sessions set origin = 'web', requester_identity_id = null where id = $1",
      [sessionId],
    );
    await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);
    await runtime.query(
      "update interactive_sessions set origin = 'linear', requester_identity_id = $2 where id = $1",
      [sessionId, f.input.nativeRequester.identityId],
    );

    await runtime.query(
      "update interactive_session_commands set status = 'unknown' where id = $1",
      [commandId],
    );
    await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(false);
    await runtime.query(
      "update interactive_session_commands set status = 'delivered' where id = $1",
      [commandId],
    );
    expect(await database.findInteractiveSession(organizationId, sessionId)).toEqual(before);

    await expect(f.coordinator.retireLinearPilotTurn(f.principal, prior)).resolves.toBe(true);
    const closed = await database.findInteractiveSession(organizationId, sessionId);
    expect(closed?.session).toMatchObject({
      state: "closed",
      stateReason: null,
      closedByUserId: null,
      generation: prior.generation,
      turn: prior.hubTurn,
      daemonAgentId: prior.agentId,
    });
    expect(closed?.session.closedAt).toBeInstanceOf(Date);
    assert.ok(before);
    const events = await database.listInteractiveSessionEvents(
      organizationId,
      sessionId,
      before.session.hubSeq,
      5,
    );
    expect(events).toMatchObject([
      {
        kind: "state",
        data: { state: "closed", stateReason: null, generation: 1, turn: 1 },
      },
    ]);
    expect(f.agents.creations).toHaveLength(1);
    expect(f.agents.sends).toHaveLength(1);
    expect(f.agents.interrupts).toEqual([]);
    expect(f.agents.archives).toEqual([]);
  });
});
