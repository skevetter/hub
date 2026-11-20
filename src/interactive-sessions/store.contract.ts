import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "vitest";
import type { Database } from "../db/types.js";
import type { AcceptCommandInput, StartSessionInput } from "./store.js";

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
  createDatabase: (organization: ReturnType<typeof sessionOrganization>) => Promise<Database>,
) {
  describe(backend + " interactive session store", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const periodStart = new Date("2026-11-01T00:00:00Z");
    let database: Database;
    let start: StartSessionInput;

    beforeEach(async () => {
      const { organizationId, users } = sessionOrganization(randomUUID());
      database = await createDatabase({ organizationId, users });
      const enrollment = {
        id: randomUUID(),
        verifier: randomUUID(),
        organizationId,
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: null,
      };
      assert.equal(await database.issueEnrollmentToken(enrollment), true);
      const daemonId = randomUUID();
      assert.ok(
        await database.enrollDaemon({
          daemonId,
          idempotencyKey: randomUUID(),
          tokenVerifier: enrollment.verifier,
          serverId: randomUUID(),
          daemonPublicKey: "test-public-key",
          credentialVerifier: "test-credential-verifier",
          permissions: ["hub.execute"],
          now,
        }),
      );
      await database.setDaemonPresence(daemonId, "connected");
      const principal = { organizationId, ...users[0]! };
      const profile = await database.saveSessionProfile({
        principal,
        id: null,
        version: null,
        daemonId,
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
      start = {
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
        now,
      };
    });

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
      const reclaimed = await database.claimInteractiveSessionCommand({
        ...input,
        now: new Date(now.getTime() + 60_000),
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
          now: new Date(now.getTime() + 60_000),
        }),
        true,
      );
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
        now,
      };
      const claim = await database.claimInteractiveSessionCommand(claimInput);
      assert.ok(claim);
      assert.ok(
        await database.applyInteractiveSessionState({
          ...scope,
          generation: 1,
          agentId: null,
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
        now,
      });
      assert.equal(stop.status, "accepted");
      const afterLease = new Date(now.getTime() + 60_001);
      assert.equal(
        await database.claimInteractiveSessionCommand({
          ...claimInput,
          now: afterLease,
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
