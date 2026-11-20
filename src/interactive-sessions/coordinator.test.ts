import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { DaemonAgentError } from "../daemons/agents/index.js";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import type { Database } from "../db/types.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { SessionEventBus } from "./bus.js";
import { InteractiveSessionCoordinator, type CommandOutcome } from "./coordinator.js";
import { readInteractiveSessionSettings } from "./settings.js";
import { sessionOrganization } from "./store.contract.js";
import { FakeAgents } from "./test-utils/fake-agents.js";

const knownSecret = "Zq9vW3xT7pLm2Kd8Rf4Y";
const settings = { ...readInteractiveSessionSettings({}), enabled: true };
const now = () => new Date();
const openCoordinators: InteractiveSessionCoordinator[] = [];

afterEach(async () => {
  await Promise.all(openCoordinators.splice(0).map((coordinator) => coordinator.stopAccepting()));
});

function accepted(result: CommandOutcome) {
  assert.equal(result.outcome, "accepted");
  return result;
}

async function fixture(postgres?: Awaited<ReturnType<typeof createPostgresTestRuntime>>) {
  const { organizationId, users } = sessionOrganization(randomUUID());
  const principal = { organizationId, ...users[0]! };
  const participant = { organizationId, ...users[1]! };
  const database =
    postgres?.database ??
    createMemoryDatabase({
      memberships: users.map((user) => ({
        ...user,
        organizationId,
        organizationSlug: organizationId,
        organizationName: organizationId,
        membershipId: user.userId + "-membership",
      })),
    });
  if (postgres) {
    await postgres.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
      organizationId,
    ]);
    for (const { userId, role } of users) {
      await postgres.runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
        userId,
        userId + "@example.test",
      ]);
      await postgres.runtime.query(
        "insert into member (id, organization_id, user_id, role) values ($1, $2, $3, $4)",
        [userId + "-membership", organizationId, userId, role],
      );
    }
  }
  const verifier = randomUUID();
  const daemonId = randomUUID();
  assert.ok(
    await database.issueEnrollmentToken({
      id: randomUUID(),
      verifier,
      organizationId,
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    }),
  );
  const enrollment = await database.enrollDaemon({
    daemonId,
    idempotencyKey: randomUUID(),
    tokenVerifier: verifier,
    serverId: randomUUID(),
    daemonPublicKey: "test-public-key",
    credentialVerifier: "test-credential-verifier",
    permissions: ["hub.execute"],
    now: now(),
  });
  assert.ok(enrollment && "id" in enrollment);
  const daemon = enrollment;
  await database.setDaemonPresence(daemonId, "connected");

  const profile = await database.saveSessionProfile({
    principal,
    id: null,
    version: null,
    daemonId,
    name: "Test profile",
    cwd: "/repo",
    worktree: null,
    provider: "codex",
    providerOptions: { sandbox_mode: "workspace-write" },
    model: "model",
    mode: "auto",
    thinkingOptionId: "high",
    fullAccessAcknowledged: false,
    status: "active",
    now: now(),
  });
  assert.ok(typeof profile === "object");
  const agents = new FakeAgents();
  const bus = new SessionEventBus();
  const reportFailure = vi.fn();
  let online = true;
  function createCoordinator(
    store: Database = database,
    bodyCutoff?: (now: Date) => Date | null,
    shutdownTimeoutMs?: number,
  ) {
    const coordinator = new InteractiveSessionCoordinator({
      database: store,
      entitlements: {
        async meterReservation(_org, meter) {
          return { meter, periodStart: new Date(0), limit: 100 };
        },
      },
      connectionForDaemon: (id) => (id === daemon.id && online ? agents.connection : undefined),
      bus,
      settings,
      scrub: createTimelineScrubber(),
      now,
      instanceId: randomUUID(),
      reportFailure,
      ...(bodyCutoff ? { bodyCutoff } : {}),
      scrubValues: [knownSecret],
      ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
    });
    openCoordinators.push(coordinator);
    return coordinator;
  }
  const coordinator = createCoordinator();
  const startInput = {
    profileId: profile.id,
    profileVersion: profile.version,
    idempotencyKey: randomUUID(),
    message: "first message",
    participants: [{ userId: participant.userId, role: "controller" as const }],
  };
  async function start() {
    return accepted(await coordinator.start(principal, startInput));
  }
  async function state(sessionId: string) {
    return (await database.findInteractiveSession(organizationId, sessionId))?.session;
  }
  async function stateEventReason(sessionId: string) {
    const events = await database.listInteractiveSessionEvents(organizationId, sessionId, 0, 100);
    return events.findLast((event) => event.kind === "state")?.data.stateReason;
  }
  async function waitState(sessionId: string, value: string) {
    await vi.waitFor(async () => expect((await state(sessionId))?.state).toBe(value));
  }
  async function waitDelivery(sessionId: string, commandId: string, value: string) {
    await vi.waitFor(async () => {
      const messages = await database.listInteractiveSessionMessages(
        organizationId,
        sessionId,
        { beforeOrdinal: null, limit: 20 },
        null,
      );
      expect(messages.find((message) => message.commandId === commandId)?.status).toBe(value);
    });
  }
  async function running() {
    const started = await start();
    await waitDelivery(started.sessionId, started.commandId, "delivered");
    await waitState(started.sessionId, "running");
    return started;
  }
  function command(sessionId: string, generation = 1) {
    return { sessionId, generation, idempotencyKey: randomUUID() };
  }
  async function send(sessionId: string, delivery: "steer" | "queue", by = principal) {
    return accepted(
      await coordinator.send(by, { ...command(sessionId), delivery, message: delivery }),
    );
  }
  function disconnect() {
    online = false;
    coordinator.daemonDisconnected(daemon);
  }
  function reconnect(owner = coordinator) {
    online = true;
    return owner.recoverDaemon(daemon);
  }
  return {
    database,
    organizationId,
    principal,
    participant,
    daemon,
    agents,
    bus,
    coordinator,
    createCoordinator,
    reportFailure,
    startInput,
    start,
    running,
    command,
    send,
    state,
    waitState,
    stateEventReason,
    waitDelivery,
    disconnect,
    reconnect,
  };
}

test("start creates a foreground agent with the stable key and sends the first message once", async () => {
  const f = await fixture();
  const started = await f.running();
  expect(await f.coordinator.start(f.principal, f.startInput)).toMatchObject({
    replayed: true,
    commandId: started.commandId,
    status: "delivered",
  });
  expect(f.agents.creations).toEqual([
    {
      key: "isession:" + started.sessionId + ":1",
      options: {
        cwd: "/repo",
        provider: "codex",
        model: "model",
        mode: "auto",
        thinkingOptionId: "high",
        background: false,
        title: "Test profile",
        env: {},
        providerOptions: { sandbox_mode: "workspace-write" },
      },
    },
  ]);
  expect(f.agents.sends).toEqual([
    { agentId: "agent-1", messageId: started.commandId, text: "first message" },
  ]);
});

test("steer sends immediately using the command ID during a running turn", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const sent = await f.send(sessionId, "steer");
  await f.waitDelivery(sessionId, sent.commandId, "delivered");
  expect(f.agents.sends.at(-1)).toEqual({
    agentId: "agent-1",
    messageId: sent.commandId,
    text: "steer",
  });
});

test("queued messages send once per idle turn", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const first = await f.send(sessionId, "queue");
  const second = await f.send(sessionId, "queue");
  await f.waitDelivery(sessionId, second.commandId, "queued");
  expect(f.agents.sends).toHaveLength(1);
  f.agents.emit("agent-1", { type: "turn_completed", provider: "codex" });
  await f.waitDelivery(sessionId, first.commandId, "delivered");
  expect(f.agents.sends).toHaveLength(2);
  await f.waitDelivery(sessionId, second.commandId, "queued");
  f.agents.emit("agent-1", { type: "turn_completed", provider: "codex" });
  await f.waitDelivery(sessionId, second.commandId, "delivered");
  expect(f.agents.sends).toHaveLength(3);
});

test("a steer overtakes an older queued message", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const queued = await f.send(sessionId, "queue");
  const steer = await f.send(sessionId, "steer");
  await f.waitDelivery(sessionId, steer.commandId, "delivered");
  await f.waitDelivery(sessionId, queued.commandId, "queued");
  expect(f.agents.sends.at(-1)?.messageId).toBe(steer.commandId);
});

test("stop supersedes queued messages and reaches idle on cancellation evidence", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const queued = await f.send(sessionId, "queue");
  const stopped = accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
  await vi.waitFor(() => expect(f.agents.interrupts).toEqual(["agent-1"]));
  await f.waitDelivery(sessionId, queued.commandId, "superseded");
  expect((await f.state(sessionId))?.state).toBe("stopping");
  f.agents.emit("agent-1", { type: "turn_canceled", provider: "codex", reason: "interrupt" });
  await f.waitState(sessionId, "idle");
  await vi.waitFor(async () => {
    const events = await f.database.listInteractiveSessionEvents(
      f.organizationId,
      sessionId,
      0,
      100,
    );
    expect(
      events.some(
        (event) =>
          event.commandId === stopped.commandId &&
          event.kind === "delivery" &&
          event.data.status === "done",
      ),
    ).toBe(true);
  });
  expect(f.agents.sends).toHaveLength(1);
});

test("lost acknowledgement stays unknown until reconnect resends the same ID and text", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.agents.afterSend = async () => {
    f.disconnect();
    throw new DaemonResponseLostError();
  };
  const sent = await f.send(sessionId, "steer");
  await f.waitDelivery(sessionId, sent.commandId, "unknown");
  f.agents.afterSend = undefined;
  await f.reconnect();
  await f.waitDelivery(sessionId, sent.commandId, "delivered");
  expect(f.agents.sends.slice(-2)).toEqual([
    { agentId: "agent-1", messageId: sent.commandId, text: "steer" },
    { agentId: "agent-1", messageId: sent.commandId, text: "steer" },
  ]);
});

test("restart re-watches the existing running agent and creates none", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  await f.coordinator.stopAccepting();
  const restarted = f.createCoordinator();
  await restarted.begin();
  expect(f.agents.watches).toEqual(["agent-1", "agent-1"]);
  expect(f.agents.creations).toHaveLength(1);
  expect(f.agents.sends).toHaveLength(1);
  expect((await f.state(sessionId))?.state).toBe("running");
  const steer = accepted(
    await restarted.send(f.principal, {
      ...f.command(sessionId),
      message: "after restart",
      delivery: "steer",
    }),
  );
  await f.waitDelivery(sessionId, steer.commandId, "delivered");
});

test("stop interrupts a running agent while a message acknowledgement is held", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const gate = Promise.withResolvers<void>();
  try {
    f.agents.afterSend = () => gate.promise;
    const sent = await f.send(sessionId, "steer");
    await vi.waitFor(() => expect(f.agents.sends).toHaveLength(2));
    accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
    await vi.waitFor(() => expect(f.agents.interrupts).toEqual(["agent-1"]));
    f.agents.emit("agent-1", { type: "turn_canceled", provider: "codex", reason: "stop" });
    await f.waitState(sessionId, "idle");
    gate.resolve();
    await f.coordinator.stopAccepting();
    await f.waitDelivery(sessionId, sent.commandId, "delivered");
    expect((await f.state(sessionId))?.state).toBe("idle");
  } finally {
    gate.resolve();
  }
});

test("reconnect settles a lost stop from idle evidence without a second interrupt", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.agents.afterInterrupt = async () => {
    f.disconnect();
    f.agents.snapshots.get("agent-1")!.status = "idle";
    throw new DaemonResponseLostError();
  };
  const stop = accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
  await vi.waitFor(async () => {
    const events = await f.database.listInteractiveSessionEvents(
      f.organizationId,
      sessionId,
      0,
      100,
    );
    expect(
      events.some(
        (event) =>
          event.commandId === stop.commandId &&
          event.kind === "delivery" &&
          event.data.status === "unknown",
      ),
    ).toBe(true);
  });
  await f.reconnect();
  await f.waitState(sessionId, "idle");
  expect(f.agents.interrupts).toEqual(["agent-1"]);
  const events = await f.database.listInteractiveSessionEvents(f.organizationId, sessionId, 0, 100);
  expect(
    events.some(
      (event) =>
        event.commandId === stop.commandId &&
        event.kind === "delivery" &&
        event.data.status === "done",
    ),
  ).toBe(true);
});

test("a delayed completion for an older turn cannot release a queued message", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.agents.emit("agent-1", { type: "turn_started", provider: "codex", turnId: "first-turn" });
  f.agents.emit("agent-1", { type: "turn_completed", provider: "codex", turnId: "first-turn" });
  await f.waitState(sessionId, "idle");
  const steer = await f.send(sessionId, "steer");
  await f.waitDelivery(sessionId, steer.commandId, "delivered");
  f.agents.emit("agent-1", { type: "turn_started", provider: "codex", turnId: "second-turn" });
  f.agents.emit("agent-1", { type: "turn_completed", provider: "codex", turnId: "first-turn" });
  const queued = await f.send(sessionId, "queue");
  f.agents.emit("agent-1", { type: "permission_requested", provider: "codex", request: {} });
  await f.waitState(sessionId, "waiting_permission");
  await f.waitDelivery(sessionId, queued.commandId, "queued");
  expect((await f.state(sessionId))?.turn).toBe(2);
  expect(f.agents.sends).toHaveLength(2);
});

test("close interrupts without archiving after the daemon reconnects", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.disconnect();
  accepted(await f.coordinator.close(f.principal, f.command(sessionId)));
  await f.waitState(sessionId, "closed");
  expect(f.agents.interrupts).toEqual([]);
  await f.reconnect();
  expect(f.agents.interrupts).toEqual(["agent-1"]);
  expect(f.agents.snapshots.has("agent-1")).toBe(true);
});

test("lost create acknowledgement reuses the same generation key", async () => {
  const f = await fixture();
  f.agents.afterCreate = async () => {
    f.disconnect();
    throw new DaemonResponseLostError();
  };
  const started = await f.start();
  await vi.waitFor(() => expect(f.agents.creations).toHaveLength(1));
  f.agents.afterCreate = undefined;
  await f.reconnect();
  await f.waitDelivery(started.sessionId, started.commandId, "delivered");
  expect(f.agents.creations.map(({ key }) => key)).toEqual(
    Array<string>(2).fill("isession:" + started.sessionId + ":1"),
  );
  expect(f.agents.snapshots.size).toBe(1);
  expect(f.agents.sends).toHaveLength(1);
});

test("revoke fails open sessions and supersedes unsent messages", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const queued = await f.send(sessionId, "queue");
  await f.database.revokeDaemon(f.daemon.id);
  await f.coordinator.daemonRevoked(f.daemon);
  expect(await f.state(sessionId)).toMatchObject({
    state: "failed",
    stateReason: "daemon_revoked",
  });
  await f.waitDelivery(sessionId, queued.commandId, "superseded");
  expect(f.agents.sends).toHaveLength(1);
});

test("a removed controller's message is superseded before dispatch", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.disconnect();
  const pending = await f.send(sessionId, "steer", f.participant);
  expect(
    await f.database.setInteractiveSessionParticipant({
      principal: f.principal,
      sessionId,
      userId: f.participant.userId,
      role: null,
      now: now(),
    }),
  ).toBe("removed");
  await f.reconnect();
  await f.waitDelivery(sessionId, pending.commandId, "superseded");
  expect(f.agents.sends).toHaveLength(1);
});

test("recovery does not send a body past the retention cutoff", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.disconnect();
  const pending = await f.send(sessionId, "steer");
  await f.reconnect(f.createCoordinator(f.database, (date) => new Date(date.getTime() + 1_000)));
  await f.waitDelivery(sessionId, pending.commandId, "superseded");
  expect(f.agents.sends).toHaveLength(1);
});

test("native permission waits are observational and never hold a Hub tool call", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.agents.emit("agent-1", { type: "permission_requested", provider: "codex", request: {} });
  await f.waitState(sessionId, "waiting_permission");
  expect(
    await f.coordinator.send(f.principal, {
      ...f.command(sessionId),
      delivery: "steer",
      message: "steer",
    }),
  ).toEqual({ outcome: "refused", code: "waiting_permission" });
  const queued = await f.send(sessionId, "queue");
  await f.waitDelivery(sessionId, queued.commandId, "queued");
  expect(f.agents.creations[0]?.options).not.toHaveProperty("mcpServers");
  expect(f.agents.creations[0]?.options).not.toHaveProperty("toolPolicy");
  accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
  await vi.waitFor(() => expect(f.agents.interrupts).toEqual(["agent-1"]));
  f.agents.emit("agent-1", { type: "turn_canceled", provider: "codex", reason: "interrupt" });
  await f.waitState(sessionId, "idle");
});

test("scrubs split secret values in live assistant messages", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const relayed: string[] = [];
  const tools: string[] = [];
  const unsubscribe = f.bus.subscribe(sessionId, (event) => {
    if (event.kind === "agent" && event.item.kind === "assistant") relayed.push(event.item.text);
    if (event.kind === "agent" && event.item.kind === "tool") tools.push(event.item.status);
  });
  const chunks = ["See ", "Zq9vW", "3xT7p", "Lm2Kd", "8Rf4Y", " here"];
  for (const [index, text] of chunks.entries()) {
    const seq = 2 * index + 1;
    f.agents.emit(
      "agent-1",
      {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", messageId: "reply", text },
      },
      { seq, epoch: "epoch" },
    );
    if (index === 2) {
      f.agents.emit(
        "agent-1",
        {
          type: "timeline",
          provider: "codex",
          item: { type: "tool_call", callId: "tool", name: "shell", status: "running" },
        },
        { seq: seq + 1, epoch: "epoch" },
      );
      await vi.waitFor(() => {
        expect(relayed.join("")).toBe("See ");
        expect(tools).toEqual(["running"]);
      });
    }
  }
  f.agents.emit("agent-1", { type: "turn_completed", provider: "codex" });
  await f.waitState(sessionId, "idle");
  expect(relayed.join("")).toBe("See [redacted] here");
  unsubscribe();
});

test("Send again after Stop reuses the original command ID and stored text", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const gate = Promise.withResolvers<void>();
  try {
    f.agents.afterSend = async () => {
      await gate.promise;
      throw new DaemonResponseLostError();
    };
    const sent = await f.send(sessionId, "steer");
    await vi.waitFor(() => expect(f.agents.sends).toHaveLength(2));
    accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
    await vi.waitFor(() => expect(f.agents.interrupts).toHaveLength(1));
    f.agents.emit("agent-1", { type: "turn_canceled", provider: "codex", reason: "stop" });
    await f.waitState(sessionId, "idle");
    gate.resolve();
    await f.waitDelivery(sessionId, sent.commandId, "unknown");
    expect(f.agents.sends).toHaveLength(2);
    f.agents.afterSend = undefined;
    const retried = accepted(
      await f.coordinator.retry(f.principal, {
        ...f.command(sessionId),
        commandId: sent.commandId,
      }),
    );
    expect(retried.commandId).toBe(sent.commandId);
    await f.waitDelivery(sessionId, sent.commandId, "delivered");
    expect(f.agents.sends.slice(-2)).toEqual([
      { agentId: "agent-1", messageId: sent.commandId, text: "steer" },
      { agentId: "agent-1", messageId: sent.commandId, text: "steer" },
    ]);
    expect(
      (await f.database.getOrganizationUsage(f.organizationId, "executions.monthly", new Date(0)))
        ?.used,
    ).toBe(2);
  } finally {
    gate.resolve();
  }
});

test("recovery does not republish old Hub events", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  await f.coordinator.stopAccepting();
  const previous = await f.state(sessionId);
  const notifications: number[] = [];
  const unsubscribe = f.bus.subscribe(sessionId, (event) => {
    if (event.kind === "hub") notifications.push(event.event.seq);
  });
  await f.createCoordinator().begin();
  expect(notifications.filter((seq) => seq <= previous!.hubSeq)).toEqual([]);
  unsubscribe();
});

test("startup fails a session whose daemon was revoked while Hub was down", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const queued = await f.send(sessionId, "queue");
  await f.coordinator.stopAccepting();
  await f.database.revokeDaemon(f.daemon.id);
  const restarted = f.createCoordinator();
  const send = () =>
    restarted.send(f.principal, { ...f.command(sessionId), message: "offline", delivery: "steer" });
  expect(await send()).toEqual({ outcome: "refused", code: "daemon_unavailable" });
  await restarted.begin();
  await f.waitDelivery(sessionId, queued.commandId, "superseded");
  expect(await f.state(sessionId)).toMatchObject({
    state: "failed",
    stateReason: "daemon_revoked",
  });
  expect(
    (await f.database.getOrganizationUsage(f.organizationId, "executions.monthly", new Date(0)))
      ?.used,
  ).toBe(2);
});

test("stopping rejects new messages without reserving usage and retries a rejected interrupt", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const first = Promise.withResolvers<void>();
  try {
    f.agents.afterInterrupt = async () => {
      if (f.agents.interrupts.length === 1) {
        await first.promise;
        throw new DaemonAgentError("busy", "daemon_busy");
      }
      f.agents.emit("agent-1", { type: "turn_canceled", provider: "codex", reason: "stop" });
    };
    accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
    for (const delivery of ["steer", "queue"] as const) {
      expect(
        await f.coordinator.send(f.principal, {
          ...f.command(sessionId),
          message: delivery,
          delivery,
        }),
      ).toEqual({ outcome: "refused", code: "session_stopping" });
    }
    expect(
      (await f.database.getOrganizationUsage(f.organizationId, "executions.monthly", new Date(0)))
        ?.used,
    ).toBe(1);
    first.resolve();
    await vi.waitFor(() => expect(f.agents.interrupts).toHaveLength(2), { timeout: 2_000 });
    await f.waitState(sessionId, "idle");
  } finally {
    first.resolve();
  }
});

test("unknown interrupts exhaust their retries and permit another Stop", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.agents.afterInterrupt = async () => {
      throw new DaemonResponseLostError();
    };
    accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
    await vi.advanceTimersByTimeAsync(18_000);
    expect(f.agents.interrupts).toHaveLength(5);
    expect((await f.state(sessionId))?.state).toBe("running");
    expect(await f.stateEventReason(sessionId)).toBe("stop_unconfirmed");
    accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
  } finally {
    vi.useRealTimers();
  }
});

test("an interrupt abandoned by a disconnect eventually permits another Stop", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.agents.afterInterrupt = async () => {
      f.disconnect();
      throw new DaemonResponseLostError();
    };
    accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
    await vi.advanceTimersByTimeAsync(18_000);
    expect((await f.state(sessionId))?.state).toBe("running");
    expect(await f.stateEventReason(sessionId)).toBe("stop_unconfirmed");
    expect(f.agents.interrupts).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("restart also recovers a pending Stop on an offline daemon", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  f.disconnect();
  accepted(await f.coordinator.stop(f.principal, f.command(sessionId)));
  await f.coordinator.stopAccepting();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await f.createCoordinator().begin();
    await vi.advanceTimersByTimeAsync(18_000);
    expect((await f.state(sessionId))?.state).toBe("running");
    expect(await f.stateEventReason(sessionId)).toBe("stop_unconfirmed");
    expect(f.agents.interrupts).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("five uncertain replacement attempts make the failed launch visible", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const current = (await f.state(sessionId))!;
  await f.database.applyInteractiveSessionState({
    organizationId: f.organizationId,
    sessionId,
    generation: 1,
    turn: current.turn,
    agentId: current.daemonAgentId,
    from: ["running"],
    to: "failed",
    reason: "agent_missing",
    now: now(),
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let replacementResponses = 0;
    f.agents.afterCreate = async () => {
      if (++replacementResponses <= 5) throw new DaemonResponseLostError();
    };
    accepted(await f.coordinator.replaceAgent(f.principal, f.command(sessionId)));
    await vi.advanceTimersByTimeAsync(18_000);
    const closed = await f.state(sessionId);
    expect(closed?.closedAt).toBeInstanceOf(Date);
    expect(closed).toMatchObject({
      state: "closed",
      stateReason: "launch_failed",
      generation: 2,
    });
    expect(f.agents.archives).toEqual(["agent-2"]);
    expect(f.agents.creations).toHaveLength(7);
    expect(f.agents.creations.slice(1).map(({ key }) => key)).toEqual(
      Array(6).fill(`isession:${sessionId}:2`),
    );
    expect(f.agents.snapshots.size).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("a transient watch rejection on an existing agent retries the same pending message", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  await f.coordinator.stopAccepting();
  const restarted = f.createCoordinator();
  const watch = vi
    .spyOn(f.agents, "watch")
    .mockRejectedValueOnce(new DaemonAgentError("busy", "daemon_busy"));
  const submitted = accepted(
    await restarted.send(f.principal, {
      ...f.command(sessionId),
      delivery: "steer",
      message: "keep this",
    }),
  );
  await vi.waitFor(async () => {
    const events = await f.database.listInteractiveSessionEvents(
      f.organizationId,
      sessionId,
      0,
      100,
    );
    expect(
      events.some(
        (event) =>
          event.kind === "delivery" &&
          event.commandId === submitted.commandId &&
          event.data.failureCode === "daemon_rejected",
      ),
    ).toBe(true);
  });
  await f.reconnect(restarted);
  await f.waitDelivery(sessionId, submitted.commandId, "delivered");
  expect(watch).toHaveBeenCalledTimes(2);
  expect(
    f.reportFailure.mock.calls.some(([, operation]) => operation === "interactive_session.watch"),
  ).toBe(true);
  expect(f.agents.sends.at(-1)).toMatchObject({
    messageId: submitted.commandId,
    text: "keep this",
  });
});

test("shutdown returns on its deadline even if a daemon call is held", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  await f.coordinator.stopAccepting();
  const coordinator = f.createCoordinator(f.database, undefined, 25);
  const gate = Promise.withResolvers<void>();
  try {
    f.agents.afterSend = () => gate.promise;
    const message = accepted(
      await coordinator.send(f.principal, {
        ...f.command(sessionId),
        delivery: "steer",
        message: "held",
      }),
    );
    await f.waitDelivery(sessionId, message.commandId, "dispatching");
    await expect(
      Promise.race([
        coordinator.stopAccepting().then(() => "stopped"),
        new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 200)),
      ]),
    ).resolves.toBe("stopped");
  } finally {
    gate.resolve();
  }
});

test("a previously accepted steer waits while the daemon requests permission", async () => {
  const f = await fixture();
  const { sessionId } = await f.running();
  const gate = Promise.withResolvers<void>();
  try {
    f.agents.afterSend = () => gate.promise;
    const first = await f.send(sessionId, "steer");
    await f.waitDelivery(sessionId, first.commandId, "dispatching");
    const deferred = await f.send(sessionId, "steer");
    f.agents.emit("agent-1", { type: "permission_requested", provider: "codex", request: {} });
    await f.waitState(sessionId, "waiting_permission");
    gate.resolve();
    await f.waitDelivery(sessionId, first.commandId, "delivered");
    await f.waitDelivery(sessionId, deferred.commandId, "pending");
    expect(f.agents.sends).toHaveLength(2);
    f.agents.emit("agent-1", {
      type: "permission_resolved",
      provider: "codex",
      requestId: "request",
      resolution: {},
    });
    await f.waitDelivery(sessionId, deferred.commandId, "delivered");
  } finally {
    gate.resolve();
  }
});

describe("coordinator with PostgreSQL", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let postgres: Awaited<ReturnType<typeof createPostgresTestRuntime>>;
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    postgres = await createPostgresTestRuntime(container.getConnectionUri());
  }, 120_000);
  afterAll(async () => {
    try {
      await postgres?.runtime.close();
    } finally {
      await container?.stop();
    }
  }, 30_000);

  test("one thousand chunks do not delay turn completion on PostgreSQL", async () => {
    const f = await fixture(postgres);
    const { sessionId } = await f.running();
    const started = performance.now();
    for (let seq = 1; seq <= 1_000; seq++) {
      f.agents.emit(
        "agent-1",
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", messageId: "reply", text: "chunk " },
        },
        { seq, epoch: "epoch" },
      );
    }
    f.agents.emit("agent-1", { type: "turn_completed", provider: "codex" });
    await vi.waitFor(async () => expect((await f.state(sessionId))?.state).toBe("idle"), {
      timeout: 400,
      interval: 10,
    });
    expect(performance.now() - started).toBeLessThan(450);
  });

  test("a late acknowledgement after agent replacement changes nothing", async () => {
    const f = await fixture(postgres);
    const { sessionId } = await f.running();
    const gate = Promise.withResolvers<void>();
    try {
      f.agents.afterSend = () => gate.promise;
      const sent = await f.send(sessionId, "steer");
      await vi.waitFor(() => expect(f.agents.sends).toHaveLength(2));
      const session = (await f.state(sessionId))!;
      await f.database.applyInteractiveSessionState({
        organizationId: f.organizationId,
        sessionId,
        generation: session.generation,
        turn: session.turn,
        agentId: session.daemonAgentId,
        from: ["running"],
        to: "failed",
        reason: "agent_missing",
        now: now(),
      });
      const other = f.createCoordinator();
      accepted(await other.replaceAgent(f.principal, f.command(sessionId)));
      await vi.waitFor(async () =>
        expect(await f.state(sessionId)).toMatchObject({ generation: 2, daemonAgentId: "agent-2" }),
      );
      gate.resolve();
      await f.coordinator.stopAccepting();
      await f.waitDelivery(sessionId, sent.commandId, "superseded");
      expect(await f.state(sessionId)).toMatchObject({ generation: 2, daemonAgentId: "agent-2" });
    } finally {
      gate.resolve();
    }
  });

  test("two coordinators sharing a database never send a command twice", async () => {
    const f = await fixture(postgres);
    const { sessionId } = await f.running();
    const second = f.createCoordinator();
    const gate = Promise.withResolvers<void>();
    try {
      f.agents.afterSend = () => gate.promise;
      const input = {
        ...f.command(sessionId),
        delivery: "steer" as const,
        message: "one durable message",
      };
      const [a, b] = await Promise.all([
        f.coordinator.send(f.principal, input),
        second.send(f.principal, input),
      ]);
      expect(accepted(a).commandId).toBe(accepted(b).commandId);
      await vi.waitFor(() => expect(f.agents.sends).toHaveLength(2));
      gate.resolve();
      await f.waitDelivery(sessionId, accepted(a).commandId, "delivered");
      await Promise.all([f.coordinator.stopAccepting(), second.stopAccepting()]);
      expect(
        f.agents.sends.filter((send) => send.messageId === accepted(a).commandId),
      ).toHaveLength(1);
    } finally {
      gate.resolve();
    }
  });

  test("restart reclaims an expired dispatch lease using the original ID and body", async () => {
    const f = await fixture(postgres);
    const { sessionId } = await f.running();
    f.disconnect();
    const sent = await f.send(sessionId, "steer");
    const claimed = await f.database.claimInteractiveSessionCommand({
      organizationId: f.organizationId,
      sessionId,
      owner: "crashed-hub",
      leaseMs: 60_000,
      agentIdle: false,
      lane: "message",
      bodyCutoff: null,
      now: now(),
    });
    expect(claimed?.id).toBe(sent.commandId);
    await postgres.runtime.query(
      "update interactive_session_commands set claim_expires_at = now() - interval '1 second' where id = $1",
      [sent.commandId],
    );
    await f.coordinator.stopAccepting();
    await f.reconnect(f.createCoordinator());
    await f.waitDelivery(sessionId, sent.commandId, "delivered");
    expect(f.agents.creations).toHaveLength(1);
    expect(f.agents.sends.at(-1)).toEqual({
      agentId: "agent-1",
      messageId: sent.commandId,
      text: "steer",
    });
  });
});
