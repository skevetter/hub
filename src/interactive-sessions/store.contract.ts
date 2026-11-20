import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "vitest";
import type { Database } from "../db/types.js";
import type { AcceptCommandInput, StartSessionInput } from "./store.js";
import type { SessionCommandRecord } from "./types.js";

export interface SessionStoreFixture {
  database: Database;
  expireLease(command: SessionCommandRecord): Promise<void>;
  readAudit(
    sessionId: string,
  ): Promise<{ action: string; actorIdentity: string; evidence: unknown }[]>;
  insertEventForAnotherCommand?: (sessionId: string, commandId: string) => Promise<void>;
  insertParticipantOutsideOrganization?: (sessionId: string) => Promise<void>;
  raceProfileSaveWithRevocation?: (
    input: Parameters<Database["saveSessionProfile"]>[0],
  ) => ReturnType<Database["saveSessionProfile"]>;
}

export function sessionOrganization(organizationId: string) {
  return {
    organizationId,
    users: [
      { userId: organizationId + "-owner", role: "owner" as const },
      { userId: organizationId + "-controller", role: "member" as const },
      { userId: organizationId + "-viewer", role: "member" as const },
      { userId: organizationId + "-outsider", role: "member" as const },
    ],
  };
}

export function interactiveSessionStoreContract(
  backend: string,
  createDatabase: (
    organization: ReturnType<typeof sessionOrganization>,
    now: Date,
  ) => Promise<SessionStoreFixture>,
) {
  describe(backend + " interactive session store", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const periodStart = new Date("2026-11-01T00:00:00Z");
    let fixture: SessionStoreFixture;
    let database: Database;
    let daemonId: string;
    let start: StartSessionInput;

    beforeEach(async () => {
      const { organizationId, users } = sessionOrganization(randomUUID());
      fixture = await createDatabase({ organizationId, users }, now);
      ({ database } = fixture);
      ({ daemonId, start } = await prepareStart(database, organizationId, users));
    });

    async function prepareStart(
      target: Database,
      organizationId: string,
      users: ReturnType<typeof sessionOrganization>["users"],
    ) {
      const enrollment = {
        id: randomUUID(),
        verifier: randomUUID(),
        organizationId,
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: null,
      };
      assert.equal(await target.issueEnrollmentToken(enrollment), true);
      const enrolledDaemonId = randomUUID();
      assert.ok(
        await target.enrollDaemon({
          daemonId: enrolledDaemonId,
          idempotencyKey: randomUUID(),
          tokenVerifier: enrollment.verifier,
          serverId: randomUUID(),
          daemonPublicKey: "test-public-key",
          credentialVerifier: "test-credential-verifier",
          permissions: ["hub.execute"],
          now,
        }),
      );
      await target.setDaemonPresence(enrolledDaemonId, "connected");
      const principal = { organizationId, ...users[0]! };
      const profile = await target.saveSessionProfile({
        principal,
        id: null,
        version: null,
        daemonId: enrolledDaemonId,
        name: "Contract profile",
        cwd: "/repo",
        worktree: { mode: "branch-off", base: "main" },
        provider: "codex",
        providerOptions: {},
        model: null,
        mode: null,
        thinkingOptionId: null,
        fullAccessAcknowledged: false,
        status: "active",
        now,
      });
      assert.equal(typeof profile, "object");
      if (typeof profile === "string") throw new Error(profile);
      const request: StartSessionInput = {
        principal,
        profileId: profile.id,
        profileVersion: profile.version,
        idempotencyKey: randomUUID(),
        message: "first message",
        participants: [
          { userId: users[1]!.userId, role: "controller" },
          { userId: users[2]!.userId, role: "viewer" },
        ],
        usage: { periodStart, limit: 100 },
        maxActivePerDaemon: 4,
        bodyCutoff: null,
        now,
      };
      return { daemonId: enrolledDaemonId, start: request };
    }

    async function started() {
      const result = await database.startInteractiveSession(start);
      assert.equal(result.status, "created");
      assert.equal(result.session.launch.worktree?.mode, "branch-off");
      assert.deepEqual(result.session.launch.worktree, {
        mode: "branch-off",
        base: "main",
        newBranch: "hub-session/" + result.session.id.slice(0, 8),
      });
      return result;
    }

    function command(
      sessionId: string,
      generation = 1,
    ): Extract<AcceptCommandInput, { kind: "message" }> {
      return {
        principal: start.principal,
        sessionId,
        generation,
        idempotencyKey: randomUUID(),
        kind: "message",
        delivery: "steer",
        message: "follow-up",
        maxQueued: 100,
        usage: start.usage,
        bodyCutoff: null,
        now,
      };
    }

    function usage() {
      return database.getOrganizationUsage(
        start.principal.organizationId,
        "executions.monthly",
        periodStart,
      );
    }

    it("two starts with one idempotency key create one session and one usage unit", async () => {
      const options = { ...start, maxActivePerDaemon: 1, usage: { periodStart, limit: 1 } };
      const results = await Promise.all([
        database.startInteractiveSession(options),
        database.startInteractiveSession({
          ...options,
          idempotencyKey: options.idempotencyKey.toUpperCase(),
        }),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["created", "replayed"]);
      const [a, b] = results;
      assert.ok(a && b && a.status !== "refused" && b.status !== "refused");
      assert.equal(a.session.id, b.session.id);
      assert.equal(a.command.id, b.command.id);
      assert.equal((await usage())?.used, 1);
      assert.equal(
        (await database.listRecoverableInteractiveSessions(start.principal.organizationId, null))
          .length,
        1,
      );
    });

    it("the same key with a different message is an idempotency conflict", async () => {
      const { session } = await started();
      assert.deepEqual(await database.startInteractiveSession({ ...start, message: "different" }), {
        status: "refused",
        code: "idempotency_conflict",
      });
      const input = command(session.id);
      const accepted = await database.acceptInteractiveSessionCommand(input);
      assert.equal(accepted.status, "accepted");
      const replay = await database.acceptInteractiveSessionCommand(input);
      assert.equal(replay.status, "replayed");
      assert.equal(replay.command.id, accepted.command.id);
      assert.deepEqual(
        await database.acceptInteractiveSessionCommand({ ...input, message: "different" }),
        {
          status: "refused",
          code: "idempotency_conflict",
        },
      );
      assert.equal((await usage())?.used, 2);
    });

    it("a usage denial stores no session, command or event", async () => {
      const { organizationId } = start.principal;
      assert.deepEqual(
        await database.startInteractiveSession({ ...start, usage: { periodStart, limit: 0 } }),
        {
          status: "refused",
          code: "usage_limit",
        },
      );
      assert.deepEqual(await database.listRecoverableInteractiveSessions(organizationId, null), []);
      assert.equal(await usage(), undefined);
      const { session } = await started();
      assert.deepEqual(
        await database.acceptInteractiveSessionCommand({
          ...command(session.id),
          usage: { periodStart, limit: 1 },
        }),
        { status: "refused", code: "usage_limit" },
      );
      assert.deepEqual(
        (
          await database.listInteractiveSessionMessages(
            organizationId,
            session.id,
            { beforeOrdinal: null, limit: 10 },
            null,
          )
        ).map((message) => message.ordinal),
        [1],
      );
      assert.deepEqual(
        (await database.listInteractiveSessionEvents(organizationId, session.id, 0, 10)).map(
          (event) => event.kind,
        ),
        ["state", "message"],
      );
      assert.equal((await usage())?.used, 1);
    });

    it("hub sequence stays gapless under concurrent sends", async () => {
      const { session } = await started();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          database.acceptInteractiveSessionCommand(command(session.id)),
        ),
      );
      assert.ok(results.every((result) => result.status === "accepted"));
      const events = await database.listInteractiveSessionEvents(
        session.organizationId,
        session.id,
        0,
        100,
      );
      assert.deepEqual(
        events.map((event) => event.seq),
        Array.from({ length: 22 }, (_, i) => i + 1),
      );
      assert.ok(events.every((event) => !JSON.stringify(event.data).includes("follow-up")));
      const messages = await database.listInteractiveSessionMessages(
        session.organizationId,
        session.id,
        { beforeOrdinal: null, limit: 100 },
        null,
      );
      assert.deepEqual(
        messages.map((message) => message.ordinal).sort((a, b) => a - b),
        Array.from({ length: 21 }, (_, i) => i + 1),
      );
      assert.equal((await usage())?.used, 21);
    });

    it("a settle for an older generation changes nothing", async () => {
      const { session } = await started();
      const scope = { organizationId: session.organizationId, sessionId: session.id };
      const claim = await database.claimInteractiveSessionCommand({
        ...scope,
        owner: "worker",
        leaseMs: 60_000,
        agentIdle: false,
        bodyCutoff: null,
        now,
      });
      assert.ok(claim);
      assert.ok(
        await database.bindInteractiveSessionAgent({
          ...scope,
          generation: 1,
          agentId: "agent",
          workspaceId: "workspace",
          now,
        }),
      );
      assert.ok(
        await database.applyInteractiveSessionState({
          ...scope,
          generation: 1,
          agentId: "agent",
          turn: 0,
          from: ["starting"],
          to: "failed",
          reason: "agent_missing",
          now,
        }),
      );
      const replacement = await database.acceptInteractiveSessionCommand({
        ...command(session.id),
        kind: "replace",
      });
      assert.equal(replacement.status, "accepted");
      assert.equal(replacement.session.generation, 2);
      const before = await database.listInteractiveSessionEvents(
        session.organizationId,
        session.id,
        0,
        100,
      );
      assert.equal(
        await database.settleInteractiveSessionCommand({
          ...scope,
          commandId: claim.id,
          generation: 1,
          claimOwner: "worker",
          attempts: claim.attempts,
          status: "delivered",
          now,
        }),
        false,
      );
      assert.equal(
        await database.applyInteractiveSessionState({
          ...scope,
          generation: 2,
          agentId: "agent",
          turn: 0,
          from: ["starting"],
          to: "idle",
          now,
        }),
        undefined,
      );
      assert.deepEqual(
        await database.listInteractiveSessionEvents(session.organizationId, session.id, 0, 100),
        before,
      );
    });

    it("two claimers never hold one command; an expired lease can be reclaimed", async () => {
      const { session, command: first } = await started();
      const input = {
        organizationId: session.organizationId,
        sessionId: session.id,
        leaseMs: 60_000,
        agentIdle: false,
        bodyCutoff: null,
        now,
      };
      const claims = await Promise.all(
        ["worker-a", "worker-b"].map((owner) =>
          database.claimInteractiveSessionCommand({ ...input, owner }),
        ),
      );
      const held = claims.filter((claim) => claim !== undefined);
      assert.equal(held.length, 1);
      assert.equal(held[0]!.id, first.id);
      await fixture.expireLease(held[0]!);
      const reclaimed = await database.claimInteractiveSessionCommand({
        ...input,
        owner: "worker-c",
      });
      assert.equal(reclaimed?.id, first.id);
      assert.equal(reclaimed.attempts, 2);
      assert.equal(reclaimed.body, first.body);
      assert.equal(
        await database.settleInteractiveSessionCommand({
          ...input,
          commandId: first.id,
          generation: 1,
          claimOwner: held[0]!.claimOwner!,
          attempts: 1,
          status: "delivered",
          now,
        }),
        false,
      );
      assert.equal(
        await database.settleInteractiveSessionCommand({
          ...input,
          commandId: first.id,
          generation: 1,
          claimOwner: "worker-c",
          attempts: 2,
          status: "delivered",
          now,
        }),
        true,
      );
    });

    it("a stale idle observation cannot claim a second queued message in the same turn", async () => {
      const { session } = await started();
      const scope = { organizationId: session.organizationId, sessionId: session.id };
      const agent = { ...scope, generation: session.generation, agentId: "agent", turn: 0, now };
      const claim = { ...scope, lane: "message" as const, leaseMs: 60_000, bodyCutoff: null, now };
      const owner = "first-worker";
      const settleDelivered = (commandId: string, attempts: number) =>
        database.settleInteractiveSessionCommand({
          ...scope,
          commandId,
          generation: agent.generation,
          claimOwner: owner,
          attempts,
          status: "delivered",
          now,
        });

      assert.ok(await database.bindInteractiveSessionAgent({ ...agent, workspaceId: "workspace" }));
      const initial = await database.claimInteractiveSessionCommand({
        ...claim,
        owner,
        agentIdle: false,
      });
      assert.ok(initial);
      assert.ok(await settleDelivered(initial.id, initial.attempts));
      assert.ok(
        await database.applyInteractiveSessionState({
          ...agent,
          from: ["starting"],
          to: "running",
        }),
      );

      for (const message of ["first queued", "second queued"]) {
        const queued = await database.acceptInteractiveSessionCommand({
          ...command(session.id),
          message,
          delivery: "queue",
        });
        assert.equal(queued.status, "accepted");
      }
      assert.ok(
        await database.applyInteractiveSessionState({
          ...agent,
          turn: 1,
          from: ["running"],
          to: "idle",
        }),
      );
      const observedIdle =
        (await database.findInteractiveSession(scope.organizationId, scope.sessionId))?.session
          .state === "idle";
      assert.ok(observedIdle);
      assert.equal(
        await database.claimInteractiveSessionCommand({ ...claim, owner, agentIdle: false }),
        undefined,
      );

      const first = await database.claimInteractiveSessionCommand({
        ...claim,
        owner,
        agentIdle: observedIdle,
      });
      assert.equal(first?.body, "first queued");
      assert.ok(
        await database.applyInteractiveSessionState({
          ...agent,
          turn: 1,
          from: ["idle"],
          to: "running",
        }),
      );
      assert.ok(await settleDelivered(first.id, first.attempts));

      const secondWorker = { ...claim, owner: "second-worker", agentIdle: observedIdle };
      assert.equal(await database.claimInteractiveSessionCommand(secondWorker), undefined);

      assert.ok(
        await database.applyInteractiveSessionState({
          ...agent,
          turn: 2,
          from: ["running"],
          to: "idle",
        }),
      );
      const second = await database.claimInteractiveSessionCommand(secondWorker);
      assert.equal(second?.body, "second queued");
    });

    it("stop prevents retries of an in-flight message with an unconfirmed outcome", async () => {
      const { session } = await started();
      const scope = { organizationId: session.organizationId, sessionId: session.id };
      const claimInput = {
        ...scope,
        lane: "message" as const,
        owner: "worker",
        leaseMs: 60_000,
        agentIdle: false,
        bodyCutoff: null,
        now,
      };
      const claim = await database.claimInteractiveSessionCommand(claimInput);
      assert.ok(claim);
      assert.ok(
        await database.applyInteractiveSessionState({
          ...scope,
          generation: 1,
          agentId: null,
          turn: 0,
          from: ["starting"],
          to: "running",
          now,
        }),
      );
      const stop = await database.acceptInteractiveSessionCommand({
        principal: start.principal,
        sessionId: session.id,
        generation: 1,
        idempotencyKey: randomUUID(),
        kind: "stop",
        bodyCutoff: null,
        now,
      });
      assert.equal(stop.status, "accepted");
      await fixture.expireLease(claim);
      assert.equal(
        await database.claimInteractiveSessionCommand({
          ...claimInput,
          owner: "another-worker",
        }),
        undefined,
      );
      const [message] = await database.listInteractiveSessionMessages(
        session.organizationId,
        session.id,
        { beforeOrdinal: null, limit: 1 },
        null,
      );
      assert.equal(message?.status, "unknown");
      assert.equal(message.failureCode, "delivery_unconfirmed");
    });

    async function storeRunning() {
      const { session } = await started();
      const scope = { organizationId: session.organizationId, sessionId: session.id };
      const observation = { ...scope, generation: 1, agentId: null, now };
      assert.ok(
        await database.applyInteractiveSessionState({
          ...observation,
          turn: 0,
          from: ["starting"],
          to: "running",
        }),
      );
      const claim = {
        ...scope,
        lane: "message" as const,
        owner: "worker",
        leaseMs: 60_000,
        agentIdle: false,
        bodyCutoff: null,
        now,
      };
      const stop = { ...command(session.id), kind: "stop" as const };
      return { scope, observation, claim, stop };
    }

    it("refuses new steer and queue messages while stopping without reserving usage", async () => {
      const { scope, stop } = await storeRunning();
      assert.equal((await database.acceptInteractiveSessionCommand(stop)).status, "accepted");
      for (const delivery of ["steer", "queue"] as const) {
        assert.deepEqual(
          await database.acceptInteractiveSessionCommand({
            ...command(scope.sessionId),
            delivery,
          }),
          { status: "refused", code: "session_stopping" },
        );
      }
      assert.equal((await usage())?.used, 1);
    });

    it("refuses new messages and claims after revocation without charging again or invalidating replays", async () => {
      const { scope, claim } = await storeRunning();
      const request = command(scope.sessionId);
      const accepted = await database.acceptInteractiveSessionCommand(request);
      assert.equal(accepted.status, "accepted");
      await database.revokeDaemon(daemonId);
      assert.deepEqual(await database.acceptInteractiveSessionCommand(command(scope.sessionId)), {
        status: "refused",
        code: "daemon_unavailable",
      });
      const replay = await database.acceptInteractiveSessionCommand(request);
      assert.equal(replay.status, "replayed");
      assert.equal(replay.command.id, accepted.command.id);
      assert.equal(await database.claimInteractiveSessionCommand(claim), undefined);
      assert.equal((await usage())?.used, 2);
    });

    it("settles a definitive acknowledgement under the original claim after Stop", async () => {
      const { claim, scope, stop } = await storeRunning();
      const held = await database.claimInteractiveSessionCommand(claim);
      assert.ok(held);
      assert.equal((await database.acceptInteractiveSessionCommand(stop)).status, "accepted");
      assert.ok(
        await database.settleInteractiveSessionCommand({
          ...scope,
          commandId: held.id,
          claimOwner: claim.owner,
          generation: held.generation,
          attempts: held.attempts,
          status: "delivered",
          now,
        }),
      );
    });

    it("retries a stopped send by its stored ID and exact body without a new charge", async () => {
      const { claim, scope, stop, observation } = await storeRunning();
      const held = await database.claimInteractiveSessionCommand(claim);
      assert.ok(held);
      assert.equal((await database.acceptInteractiveSessionCommand(stop)).status, "accepted");
      await database.settleInteractiveSessionCommand({
        ...scope,
        commandId: held.id,
        claimOwner: claim.owner,
        generation: held.generation,
        attempts: held.attempts,
        status: "unknown",
        now,
      });
      assert.ok(
        await database.applyInteractiveSessionState({
          ...observation,
          turn: 1,
          from: ["stopping"],
          to: "idle",
          reason: "stopped_by_person",
        }),
      );
      assert.equal(await database.claimInteractiveSessionCommand(claim), undefined);
      const retry = { ...command(scope.sessionId), kind: "retry" as const, commandId: held.id };
      const result = await database.acceptInteractiveSessionCommand(retry);
      assert.equal(result.status, "accepted");
      assert.equal(result.command.id, held.id);
      assert.equal(result.command.body, held.body);
      const retried = await database.claimInteractiveSessionCommand(claim);
      assert.equal(retried?.id, held.id);
      assert.equal(retried.attempts, held.attempts + 1);
      assert.equal((await usage())?.used, 1);
    });

    it("blocks pending steer claims during permission waits under the session lock", async () => {
      const { claim, observation } = await storeRunning();
      assert.ok(
        await database.applyInteractiveSessionState({
          ...observation,
          turn: 1,
          from: ["running"],
          to: "waiting_permission",
        }),
      );
      assert.equal(
        await database.claimInteractiveSessionCommand({ ...claim, agentIdle: true }),
        undefined,
      );
      assert.ok(
        await database.applyInteractiveSessionState({
          ...observation,
          turn: 1,
          from: ["waiting_permission"],
          to: "running",
        }),
      );
      assert.ok(await database.claimInteractiveSessionCommand(claim));
    });

    it("records an unconfirmed Stop in a state event and allows a second Stop", async () => {
      const { scope, claim, stop } = await storeRunning();
      assert.equal((await database.acceptInteractiveSessionCommand(stop)).status, "accepted");
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const held = await database.claimInteractiveSessionCommand({ ...claim, lane: "control" });
        assert.ok(held);
        assert.equal(held.attempts, attempt);
        assert.ok(
          await database.settleInteractiveSessionCommand({
            ...scope,
            commandId: held.id,
            claimOwner: claim.owner,
            generation: held.generation,
            attempts: held.attempts,
            status: "unknown",
            now,
          }),
        );
      }
      const events = await database.listInteractiveSessionEvents(
        scope.organizationId,
        scope.sessionId,
        0,
        100,
      );
      const latest = events.findLast((event) => event.kind === "state");
      assert.equal(latest?.data.state, "running");
      assert.equal(latest.data.stateReason, "stop_unconfirmed");
      assert.equal(
        (await database.acceptInteractiveSessionCommand({ ...stop, idempotencyKey: randomUUID() }))
          .status,
        "accepted",
      );
    });

    it("exhausting an uncertain replacement closes the session with a durable reason", async () => {
      const { scope, claim, observation } = await storeRunning();
      assert.ok(
        await database.applyInteractiveSessionState({
          ...observation,
          turn: 1,
          from: ["running"],
          to: "failed",
          reason: "agent_missing",
        }),
      );
      assert.equal(
        (
          await database.acceptInteractiveSessionCommand({
            ...command(scope.sessionId),
            kind: "replace",
          })
        ).status,
        "accepted",
      );
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const held = await database.claimInteractiveSessionCommand({ ...claim, lane: "control" });
        assert.ok(held);
        assert.equal(held.attempts, attempt);
        assert.ok(
          await database.settleInteractiveSessionCommand({
            ...scope,
            commandId: held.id,
            claimOwner: claim.owner,
            generation: held.generation,
            attempts: held.attempts,
            status: "unknown",
            now,
          }),
        );
      }
      const current = await database.findInteractiveSession(scope.organizationId, scope.sessionId);
      assert.equal(current?.session.state, "closed");
      assert.equal(current.session.stateReason, "launch_failed");
      assert.deepEqual(current.session.closedAt, now);
    });

    async function startAsMember() {
      const principal = {
        ...start.principal,
        userId: start.principal.organizationId + "-outsider",
        role: "member" as const,
      };
      const result = await database.startInteractiveSession({ ...start, principal });
      assert.equal(result.status, "created");
      return { principal, session: result.session };
    }

    it("removing a member starter revokes stop and close rights", async () => {
      const { principal, session } = await startAsMember();
      assert.equal(
        await database.setInteractiveSessionParticipant({
          principal: start.principal,
          sessionId: session.id,
          userId: principal.userId,
          role: null,
          now,
        }),
        "removed",
      );
      assert.deepEqual(await database.startInteractiveSession({ ...start, principal }), {
        status: "refused",
        code: "forbidden",
      });
      for (const kind of ["stop", "close"] as const) {
        assert.deepEqual(
          await database.acceptInteractiveSessionCommand({
            ...command(session.id),
            principal,
            kind,
          }),
          { status: "refused", code: "not_found" },
        );
      }
    });

    it("a starter demoted to viewer cannot promote themselves", async () => {
      const { principal, session } = await startAsMember();
      const change = { sessionId: session.id, userId: principal.userId, now };
      assert.equal(
        await database.setInteractiveSessionParticipant({
          ...change,
          principal: start.principal,
          role: "viewer",
        }),
        "set",
      );
      assert.equal(
        await database.setInteractiveSessionParticipant({
          ...change,
          principal,
          role: "controller",
        }),
        "forbidden",
      );
    });

    it("start and command replays redact expired bodies before the sweep", async () => {
      const { session } = await started();
      const send = command(session.id);
      assert.equal((await database.acceptInteractiveSessionCommand(send)).status, "accepted");
      const cutoff = new Date(now.getTime() + 1);
      const replayedStart = await database.startInteractiveSession({
        ...start,
        bodyCutoff: cutoff,
      });
      const replayedSend = await database.acceptInteractiveSessionCommand({
        ...send,
        bodyCutoff: cutoff,
      });
      assert.equal(replayedStart.status, "replayed");
      assert.equal(replayedSend.status, "replayed");
      assert.deepEqual([replayedStart.command.body, replayedSend.command.body], [null, null]);
      assert.equal((await usage())?.used, 2);
    });

    it("claim leaves an expired body unclaimed before the sweep", async () => {
      const { session } = await started();
      assert.equal(
        await database.claimInteractiveSessionCommand({
          organizationId: session.organizationId,
          sessionId: session.id,
          owner: "worker",
          leaseMs: 60_000,
          agentIdle: false,
          bodyCutoff: new Date(now.getTime() + 1),
          now,
        }),
        undefined,
      );
    });

    it("provider options enforce the jsonb text size at the byte boundary", async () => {
      const profile = await database.findSessionProfile(
        start.principal.organizationId,
        start.profileId,
      );
      assert.ok(profile);
      const save = {
        ...profile,
        principal: start.principal,
        id: null,
        version: null,
        name: "Sized options",
        now,
      };
      // Each compact separator gains one byte when PostgreSQL renders jsonb.
      const options = (length: number) => ({
        a: Array.from({ length: 15 }, () => 0),
        b: "x".repeat(length),
      });
      const oversized = await database.saveSessionProfile({
        ...save,
        providerOptions: options(4036),
      });
      assert.equal(oversized, "invalid_profile");
      const atLimit = await database.saveSessionProfile({
        ...save,
        providerOptions: options(4035),
      });
      assert.equal(typeof atLimit, "object");
    });

    it("writes metadata-only audit rows and does not audit idempotent replays twice", async () => {
      const { session, command: initial } = await started();
      const send = command(session.id);
      const sent = await database.acceptInteractiveSessionCommand(send);
      assert.equal(sent.status, "accepted");
      assert.equal((await database.acceptInteractiveSessionCommand(send)).status, "replayed");
      const userId = start.participants[0]!.userId;
      assert.equal(
        await database.setInteractiveSessionParticipant({
          principal: start.principal,
          sessionId: session.id,
          userId,
          role: "viewer",
          now,
        }),
        "set",
      );
      const audit = await fixture.readAudit(session.id);
      assert.deepEqual(
        audit.toSorted((a, b) => a.action.localeCompare(b.action)),
        [
          {
            action: "interactive_session.message",
            actorIdentity: start.principal.userId,
            evidence: { commandId: sent.command.id },
          },
          {
            action: "interactive_session.participant_changed",
            actorIdentity: start.principal.userId,
            evidence: { userId, role: "viewer" },
          },
          {
            action: "interactive_session.started",
            actorIdentity: start.principal.userId,
            evidence: { profileId: start.profileId, commandId: initial.id },
          },
        ],
      );
    });

    it("close supersedes an earlier pending stop", async () => {
      const { session } = await started();
      const scope = { organizationId: session.organizationId, sessionId: session.id };
      assert.ok(
        await database.applyInteractiveSessionState({
          ...scope,
          generation: 1,
          turn: 0,
          agentId: null,
          from: ["starting"],
          to: "running",
          now,
        }),
      );
      const stop = { ...command(session.id), kind: "stop" as const };
      assert.equal((await database.acceptInteractiveSessionCommand(stop)).status, "accepted");
      assert.equal(
        (await database.acceptInteractiveSessionCommand({ ...command(session.id), kind: "close" }))
          .status,
        "accepted",
      );
      const replay = await database.acceptInteractiveSessionCommand(stop);
      assert.equal(replay.status, "replayed");
      assert.equal(replay.command.status, "superseded");
      const close = await database.claimInteractiveSessionCommand({
        ...scope,
        owner: "worker",
        lane: "control",
        leaseMs: 60_000,
        agentIdle: false,
        bodyCutoff: null,
        now,
      });
      assert.equal(close?.kind, "close");
    });

    it("a caller 61 seconds ahead cannot steal or invalidate a live lease", async () => {
      const { session } = await started();
      const input = {
        organizationId: session.organizationId,
        sessionId: session.id,
        leaseMs: 60_000,
        agentIdle: false,
        bodyCutoff: null,
        now,
      };
      const first = await database.claimInteractiveSessionCommand({ ...input, owner: "first" });
      assert.ok(first);
      const skewed = new Date(first.claimExpiresAt!.getTime() + 1_000);
      assert.equal(
        await database.claimInteractiveSessionCommand({ ...input, owner: "ahead", now: skewed }),
        undefined,
      );
      assert.equal(
        await database.settleInteractiveSessionCommand({
          ...input,
          commandId: first.id,
          generation: first.generation,
          claimOwner: "first",
          attempts: first.attempts,
          status: "delivered",
          now: skewed,
        }),
        true,
      );
    });

    it("a caller behind the store clock cannot settle an expired lease", async () => {
      const { session } = await started();
      const input = {
        organizationId: session.organizationId,
        sessionId: session.id,
        leaseMs: 60_000,
        agentIdle: false,
        bodyCutoff: null,
        now,
      };
      const first = await database.claimInteractiveSessionCommand({ ...input, owner: "first" });
      assert.ok(first);
      await fixture.expireLease(first);
      assert.equal(
        await database.settleInteractiveSessionCommand({
          ...input,
          commandId: first.id,
          generation: first.generation,
          claimOwner: "first",
          attempts: first.attempts,
          status: "delivered",
          now: new Date(first.claimExpiresAt!.getTime() - 121_000),
        }),
        false,
      );
    });

    it("a delayed transition from an older turn preserves the current turn in the same generation", async () => {
      const { session } = await started();
      const agent = {
        organizationId: session.organizationId,
        sessionId: session.id,
        generation: session.generation,
        agentId: "agent",
        now,
      };
      assert.ok(await database.bindInteractiveSessionAgent({ ...agent, workspaceId: "workspace" }));
      async function enterTurn(turn: number, from: "starting" | "idle") {
        return database.applyInteractiveSessionState({
          ...agent,
          turn,
          from: [from],
          to: "running",
        });
      }
      const complete = { ...agent, turn: 1, from: ["running"] as const, to: "idle" as const };
      assert.ok(await enterTurn(0, "starting"));
      assert.ok(await database.applyInteractiveSessionState(complete));
      const next = await enterTurn(1, "idle");
      assert.ok(next);
      assert.equal(await database.applyInteractiveSessionState(complete), undefined);
      assert.equal(next.turn, 2);
      assert.equal(
        (await database.findInteractiveSession(session.organizationId, session.id))?.session.state,
        "running",
      );
      assert.ok(await database.applyInteractiveSessionState({ ...complete, turn: 2 }));
    });

    it("an authoritative replacement turn advances the fence while the session stays running", async () => {
      const { session } = await started();
      const agent = {
        organizationId: session.organizationId,
        sessionId: session.id,
        generation: session.generation,
        agentId: null,
        now,
      };
      assert.ok(
        await database.applyInteractiveSessionState({
          ...agent,
          turn: 0,
          from: ["starting"],
          to: "running",
        }),
      );
      const steerStartedNewTurn = {
        ...agent,
        turn: 1,
        from: ["running"] as const,
        to: "running" as const,
        beginsTurn: true as const,
      };
      const replacement = await database.applyInteractiveSessionState(steerStartedNewTurn);
      assert.equal(replacement?.turn, 2);
      assert.equal(
        await database.applyInteractiveSessionState({
          ...agent,
          turn: 1,
          from: ["running"],
          to: "idle",
        }),
        undefined,
      );
    });

    it("a new start rechecks daemon presence, permissions, and revocation", async () => {
      const refused = { status: "refused", code: "daemon_unavailable" };
      await database.setDaemonPresence(daemonId, "offline");
      assert.deepEqual(await database.startInteractiveSession(start), refused);
      await database.setDaemonPresence(daemonId, "connected");
      await database.setDaemonPermissions(daemonId, []);
      assert.deepEqual(await database.startInteractiveSession(start), refused);
      await database.setDaemonPermissions(daemonId, ["hub.execute"]);
      await database.revokeDaemon(daemonId);
      assert.deepEqual(await database.startInteractiveSession(start), refused);
      assert.equal(await usage(), undefined);
    });

    if (backend === "PostgreSQL") {
      it("the database rejects session events linked to another organization's command", async () => {
        const { session } = await started();
        const foreign = sessionOrganization(randomUUID());
        const other = await createDatabase(foreign, now);
        const foreignStart = await prepareStart(
          other.database,
          foreign.organizationId,
          foreign.users,
        );
        const created = await other.database.startInteractiveSession(foreignStart.start);
        assert.equal(created.status, "created");
        assert.ok(fixture.insertEventForAnotherCommand);
        await assert.rejects(
          fixture.insertEventForAnotherCommand(session.id, created.command.id),
          /foreign key/u,
        );
      });

      it("profile save rechecks daemon state after waiting for the profile lock", async () => {
        const profile = await database.findSessionProfile(
          start.principal.organizationId,
          start.profileId,
        );
        assert.ok(profile);
        assert.ok(fixture.raceProfileSaveWithRevocation);
        assert.equal(
          await fixture.raceProfileSaveWithRevocation({
            ...profile,
            principal: start.principal,
            now,
          }),
          "daemon_unavailable",
        );
      });

      it("the database rejects participants without an organization membership", async () => {
        const { session } = await started();
        assert.ok(fixture.insertParticipantOutsideOrganization);
        await assert.rejects(
          fixture.insertParticipantOutsideOrganization(session.id),
          /foreign key/u,
        );
      });
    }

    it("the per-daemon active limit holds under concurrent starts", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          database.startInteractiveSession({
            ...start,
            idempotencyKey: randomUUID(),
            maxActivePerDaemon: 2,
          }),
        ),
      );
      assert.equal(results.filter((result) => result.status === "created").length, 2);
      assert.deepEqual(
        results.filter((result) => result.status === "refused"),
        Array.from({ length: 4 }, () => ({ status: "refused", code: "active_limit" })),
      );
      assert.equal((await usage())?.used, 2);
    });

    it("another organization cannot read a session, its commands or its events", async () => {
      const { session } = await started();
      const foreign = sessionOrganization(randomUUID());
      const principal = { organizationId: foreign.organizationId, ...foreign.users[0]! };
      assert.equal(
        await database.findInteractiveSession(principal.organizationId, session.id),
        undefined,
      );
      assert.deepEqual(
        await database.listInteractiveSessionMessages(
          principal.organizationId,
          session.id,
          { beforeOrdinal: null, limit: 10 },
          null,
        ),
        [],
      );
      assert.deepEqual(
        await database.listInteractiveSessionEvents(principal.organizationId, session.id, 0, 10),
        [],
      );
      assert.deepEqual(
        await database.listInteractiveSessions(session.organizationId, principal, {
          filter: "all",
          cursor: null,
          limit: 10,
        }),
        { sessions: [], nextCursor: null },
      );
      const outsider = {
        organizationId: session.organizationId,
        userId: session.organizationId + "-outsider",
        role: "admin" as const,
      };
      const page = { filter: "all" as const, cursor: null, limit: 10 };
      assert.deepEqual(
        await database.listInteractiveSessions(session.organizationId, outsider, page),
        {
          sessions: [],
          nextCursor: null,
        },
      );
      assert.deepEqual(
        await database.acceptInteractiveSessionCommand({
          ...command(session.id),
          principal: outsider,
        }),
        {
          status: "refused",
          code: "not_found",
        },
      );
      const controller = {
        ...outsider,
        userId: start.participants[0]!.userId,
        role: "member" as const,
      };
      assert.deepEqual(
        (
          await database.listInteractiveSessions(session.organizationId, controller, page)
        ).sessions.map(({ id }) => id),
        [session.id],
      );
      assert.deepEqual(
        await database.acceptInteractiveSessionCommand({ ...command(session.id), principal }),
        { status: "refused", code: "not_found" },
      );
    });

    it("an expired body is hidden by the read cutoff and cleared by the sweep", async () => {
      const { session } = await started();
      const newer = new Date(now.getTime() + 1);
      assert.equal(
        (await database.acceptInteractiveSessionCommand({ ...command(session.id), now: newer }))
          .status,
        "accepted",
      );
      const list = (cutoff: Date | null) =>
        database.listInteractiveSessionMessages(
          session.organizationId,
          session.id,
          { beforeOrdinal: null, limit: 10 },
          cutoff,
        );
      assert.deepEqual(
        (await list(newer)).map(({ body, expired }) => [body, expired]),
        [
          ["follow-up", false],
          [null, true],
        ],
      );
      assert.equal(
        await database.expireInteractiveSessionMessageBodies(
          newer,
          10,
          new Date("2026-12-20T00:00:00.001Z"),
        ),
        1,
      );
      assert.equal(
        await database.expireInteractiveSessionMessageBodies(
          newer,
          10,
          new Date("2026-12-20T00:00:00.001Z"),
        ),
        0,
      );
      assert.deepEqual(
        (await list(null)).map(({ body, expired }) => [body, expired]),
        [
          ["follow-up", false],
          [null, true],
        ],
      );
    });
  });
}
