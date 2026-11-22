import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import type { SessionPrincipal } from "../interactive-sessions/types.js";

const now = new Date("2026-11-22T08:00:00Z");
const organizations = ["fixture", "other"];
const memberships = organizations.flatMap((organizationId) =>
  (["owner", "member", "viewer"] as const).map((userId) => ({
    userId,
    organizationId,
    organizationName: organizationId,
    organizationSlug: organizationId,
    membershipId: `${organizationId}:${userId}`,
    role: userId === "owner" ? ("owner" as const) : ("member" as const),
  })),
);
const member = (userId: string, organizationId = "fixture"): SessionPrincipal => ({
  userId,
  organizationId,
  role: userId === "owner" ? "owner" : "member",
});

async function seed(db: Database, organizationId: string, participant: boolean) {
  const verifier = randomUUID();
  const daemonId = randomUUID();
  assert.ok(
    await db.issueEnrollmentToken({
      id: randomUUID(),
      verifier,
      organizationId,
      expiresAt: new Date(+now + 60_000),
      consumedAt: null,
    }),
  );
  assert.ok(
    await db.enrollDaemon({
      daemonId,
      idempotencyKey: randomUUID(),
      tokenVerifier: verifier,
      serverId: randomUUID(),
      daemonPublicKey: "test-public-key",
      credentialVerifier: "test-credential-verifier",
      permissions: ["hub.execute"],
      now,
    }),
  );
  await db.setDaemonPresence(daemonId, "connected");
  const profile = await db.saveSessionProfile({
    principal: member("owner", organizationId),
    id: null,
    version: null,
    daemonId,
    name: "Fixture",
    cwd: "/repo",
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
  if (typeof profile === "string") throw new Error(profile);
  const { id: profileId, version: profileVersion } = profile;
  async function start() {
    const result = await db.startInteractiveSession({
      principal: member("member", organizationId),
      profileId,
      profileVersion,
      idempotencyKey: randomUUID(),
      message: "hello",
      participants: participant ? [{ userId: "viewer", role: "viewer" }] : [],
      usage: { periodStart: now, limit: 100 },
      maxActivePerDaemon: 10,
      bodyCutoff: null,
      now,
    });
    assert.equal(result.status, "created");
    return result.session;
  }
  return { first: await start(), start };
}

it("keeps both stores in parity and reads PGlite session history through the reader indexes", async () => {
  const data = await mkdtemp(join(tmpdir(), "hub-home-session-count-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(data);
  const pg = createDatabase(runtime, locks);
  const memory = createMemoryDatabase({ memberships });
  try {
    await runtime.migrate();
    for (const id of organizations) {
      await runtime.query("insert into organization (id, name, slug) values ($1,$1,$1)", [id]);
    }
    for (const id of ["owner", "member", "viewer"]) {
      await runtime.query('insert into "user" (id, name, email) values ($1,$1,$2)', [
        id,
        `${id}@example.test`,
      ]);
    }
    for (const m of memberships) {
      await runtime.query(
        "insert into member (id, organization_id, user_id, role) values ($1,$2,$3,$4)",
        [m.membershipId, m.organizationId, m.userId, m.role],
      );
    }

    for (const db of [memory, pg]) {
      const { first, start } = await seed(db, "fixture", true);
      await seed(db, "other", false);
      for (const who of [member("owner"), member("absent"), member("viewer", "other")]) {
        assert.deepEqual(await db.countOwnInteractiveSessions(who, 2), {
          open: 0,
          openCapped: false,
          started: false,
        });
      }
      for (const who of [member("member"), member("viewer")]) {
        assert.deepEqual(await db.countOwnInteractiveSessions(who, 2), {
          open: 1,
          openCapped: false,
          started: true,
        });
      }
      const close = await db.acceptInteractiveSessionCommand({
        principal: member("member"),
        sessionId: first.id,
        generation: first.generation,
        idempotencyKey: randomUUID(),
        kind: "close",
        now,
        bodyCutoff: null,
      });
      assert.equal(close.status, "accepted");
      assert.deepEqual(await db.countOwnInteractiveSessions(member("viewer"), 2), {
        open: 0,
        openCapped: false,
        started: true,
      });
      await start();
      await start();
      assert.deepEqual(await db.countOwnInteractiveSessions(member("member"), 2), {
        open: 2,
        openCapped: false,
        started: true,
      });
      await start();
      assert.deepEqual(await db.countOwnInteractiveSessions(member("member"), 2), {
        open: 2,
        openCapped: true,
        started: true,
      });
    }

    for (const org of organizations) {
      await runtime.query(
        `
        with added as (
          insert into interactive_sessions
          (id, organization_id, profile_id, profile_version, launch, daemon_id, title, state,
           started_by_user_id, start_idempotency_key, start_request_hash, closed_at)
        select gen_random_uuid(), s.organization_id, s.profile_id, s.profile_version, s.launch, s.daemon_id, 'Fixture history',
           'closed', 'member', gen_random_uuid(), 'hash', now()
        from (select * from interactive_sessions where organization_id = $1 limit 1) s
        cross join generate_series(1,15000)
        returning id, organization_id
        )
        insert into interactive_session_participants (organization_id, session_id, user_id, role)
        select organization_id, id, users.user_id, users.role from added
        cross join (values ('member', 'controller'), ('viewer', 'viewer')) users(user_id, role)`,
        [org],
      );
    }
    await runtime.query("analyze interactive_sessions");
    await runtime.query("analyze interactive_session_participants");
    const query = vi.spyOn(runtime, "query");
    assert.deepEqual(await pg.countOwnInteractiveSessions(member("owner"), 50), {
      open: 0,
      openCapped: false,
      started: false,
    });
    const calls = [...query.mock.calls];
    query.mockRestore();
    assert.ok(calls.length > 0, "capture the queries used by the session count");
    const reads = calls.filter(([sql]) => sql.includes("interactive_sessions"));
    assert.ok(reads.length > 0, "capture the session history read");
    for (const [sql, params] of reads) {
      const { rows } = await runtime.query<{ "QUERY PLAN": string }>(
        `explain (analyze, buffers, format text) ${sql}`,
        params,
      );
      const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
      if (process.env["HUB_HOME_SESSION_EXPLAIN"] === "1") process.stdout.write(`${plan}\n\n`);
      if (sql.includes("with candidates")) {
        assert.match(plan, /interactive_sessions_open_daemon_idx/u);
      } else {
        assert.match(plan, /interactive_sessions_start_key_unique/u);
        assert.match(plan, /interactive_session_participants_org_user_idx/u);
      }
      assert.doesNotMatch(plan, /Seq Scan on interactive_session/u);
      for (const [, removed] of plan.matchAll(/Rows Removed by Filter: (\d+)/gu)) {
        assert.ok(Number(removed) < 10, plan);
      }
    }
    assert.ok(calls.every(([sql]) => !/for\s+share/iu.test(sql)));

    const archiveQuery = vi.spyOn(runtime, "query");
    assert.deepEqual(await pg.countOwnInteractiveSessions(member("viewer"), 200), {
      open: 3,
      openCapped: false,
      started: true,
    });
    const [openRead] = archiveQuery.mock.calls;
    archiveQuery.mockRestore();
    assert.ok(openRead);
    const [sql, params] = openRead;
    const { rows } = await runtime.query<{ "QUERY PLAN": string }>(
      `explain (analyze, buffers, format text) ${sql}`,
      params,
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    if (process.env["HUB_HOME_SESSION_EXPLAIN"] === "1") process.stdout.write(`${plan}\n\n`);
    for (const [, removed] of plan.matchAll(/Rows Removed by Filter: (\d+)/gu)) {
      assert.ok(Number(removed) < 10, plan);
    }
    const hits = /Buffers: shared hit=(\d+)/u.exec(plan)?.[1];
    assert.ok(hits !== undefined && Number(hits) < 100, plan);
    assert.match(plan, /interactive_sessions_open_daemon_idx/u);
    for (const db of [memory, pg]) {
      assert.deepEqual(await db.countOwnInteractiveSessions(member("owner"), 2), {
        open: 0,
        openCapped: true,
        started: false,
      });
    }
  } finally {
    await pg.close();
    await rm(data, { recursive: true, force: true });
  }
}, 60_000);
