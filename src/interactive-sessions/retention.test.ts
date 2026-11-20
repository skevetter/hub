import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { logger } from "../logger.js";
import { SessionMessageRetention, sessionMessageBodyCutoff } from "./retention.js";

let container: StartedPostgreSqlContainer;
let fixture: Awaited<ReturnType<typeof createPostgresTestRuntime>>;
const now = new Date("2026-11-20T12:00:00Z");
const cutoff = new Date("2026-10-21T12:00:00Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  fixture = await createPostgresTestRuntime(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  try {
    await fixture?.database.close();
  } finally {
    await container?.stop();
  }
});

it.each(["off", "count", "on"] as const)("handles old message bodies in %s mode", async (mode) => {
  const { database, runtime } = fixture;
  const organizationId = randomUUID();
  const userId = randomUUID();
  const daemonId = randomUUID();
  const verifier = randomUUID();
  const principal = { organizationId, userId, role: "owner" as const };
  const settings = { mode, retentionDays: 30, maxRunsPerPass: 1 };
  await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    organizationId,
  ]);
  await runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
    userId,
    userId + "@example.test",
  ]);
  await runtime.query(
    "insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')",
    [randomUUID(), organizationId, userId],
  );
  await database.issueEnrollmentToken({
    id: randomUUID(),
    organizationId,
    verifier,
    expiresAt: new Date(now.getTime() + 60_000),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId,
    idempotencyKey: randomUUID(),
    tokenVerifier: verifier,
    serverId: randomUUID(),
    daemonPublicKey: "test-key",
    credentialVerifier: "test-verifier",
    permissions: ["hub.execute"],
    now,
  });
  await database.setDaemonPresence(daemonId, "connected");
  const profile = await database.saveSessionProfile({
    principal,
    daemonId,
    id: null,
    version: null,
    name: "Test",
    cwd: "/workspace",
    worktree: null,
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
  const usage = { periodStart: new Date(0), limit: null };
  const old = await database.startInteractiveSession({
    principal,
    profileId: profile.id,
    profileVersion: profile.version,
    idempotencyKey: randomUUID(),
    message: "old body",
    participants: [],
    usage,
    maxActivePerDaemon: 4,
    bodyCutoff: null,
    now: new Date(cutoff.getTime() - 1),
  });
  assert.equal(old.status, "created", old.status === "refused" ? old.code : undefined);
  const boundary = await database.acceptInteractiveSessionCommand({
    principal,
    sessionId: old.session.id,
    generation: 1,
    idempotencyKey: randomUUID(),
    kind: "message",
    delivery: "queue",
    message: "boundary body",
    maxQueued: 20,
    usage,
    bodyCutoff: null,
    now: cutoff,
  });
  assert.equal(boundary.status, "accepted");

  const log = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  const retention = new SessionMessageRetention(database, runtime, settings, () => now);
  try {
    const readCutoff = sessionMessageBodyCutoff(settings, now);
    const visible = await database.listInteractiveSessionMessages(
      organizationId,
      old.session.id,
      { beforeOrdinal: null, limit: 5 },
      readCutoff,
    );
    expect(visible.map((message) => message.body)).toEqual([
      "boundary body",
      mode === "on" ? null : "old body",
    ]);
    await retention.sweep();
    const { rows } = await runtime.query<{ body: string | null; expired: Date | null }>(
      "select body, body_expired_at as expired from interactive_session_commands where session_id = $1 order by ordinal",
      [old.session.id],
    );
    expect(rows).toEqual([
      mode === "on" ? { body: null, expired: now } : { body: "old body", expired: null },
      { body: "boundary body", expired: null },
    ]);
    if (mode === "count") {
      expect(log).toHaveBeenCalledExactlyOnceWith(
        { eligible: 1 },
        "interactive session message retention count",
      );
    } else if (mode === "on") {
      expect(log).toHaveBeenCalledExactlyOnceWith(
        { expired: 1 },
        "interactive session message retention applied",
      );
    } else {
      expect(log).not.toHaveBeenCalled();
    }
  } finally {
    log.mockRestore();
    await runtime.query("delete from organization where id = $1", [organizationId]);
    await runtime.query('delete from "user" where id = $1', [userId]);
  }
});
