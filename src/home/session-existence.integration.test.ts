import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
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

it("keeps the reader's existence fact across membership, ownership and closure", async () => {
  await withStores(async ({ pg, memory }) => {
    for (const db of [memory, pg]) {
      const first = await seed(db, "fixture", true);
      await seed(db, "other", false);
      for (const who of [member("owner"), member("absent"), member("viewer", "other")]) {
        assert.equal(await db.hasOwnInteractiveSession(who), false);
      }
      for (const who of [member("member"), member("viewer")]) {
        assert.equal(await db.hasOwnInteractiveSession(who), true);
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
      assert.equal(await db.hasOwnInteractiveSession(member("member")), true);
      assert.equal(await db.hasOwnInteractiveSession(member("viewer")), true);
    }
  });
}, 90_000);

it("keeps the PostgreSQL existence plan independent of revoked daemons and other readers' archive", async () => {
  await withStores(async ({ pg, runtime }) => {
    await seed(pg, "fixture", true);
    await seed(pg, "other", true);
    async function insertArchive(org: string, count: number) {
      await runtime.query(
        `with added as (
           insert into interactive_sessions
             (id, organization_id, profile_id, profile_version, launch, daemon_id, title, state,
              started_by_user_id, start_idempotency_key, start_request_hash, closed_at)
           select gen_random_uuid(), s.organization_id, s.profile_id, s.profile_version, s.launch,
                  s.daemon_id, 'Fixture history', 'closed', 'member', gen_random_uuid(), 'hash', now()
           from (select * from interactive_sessions where organization_id = $1 limit 1) s
           cross join generate_series(1, $2)
           returning id, organization_id
         )
         insert into interactive_session_participants (organization_id, session_id, user_id, role)
         select organization_id, id, users.user_id, users.role from added
         cross join (values ('member', 'controller'), ('viewer', 'viewer')) users(user_id, role)`,
        [org, count],
      );
      await runtime.query("analyze interactive_sessions");
      await runtime.query("analyze interactive_session_participants");
    }

    async function measure() {
      const query = vi.spyOn(runtime, "query");
      let reads: typeof query.mock.calls;
      try {
        assert.equal(await pg.hasOwnInteractiveSession(member("owner")), false);
        reads = [...query.mock.calls];
      } finally {
        query.mockRestore();
      }
      const plans: string[] = [];
      let buffers = 0;
      for (const [sql, params] of reads) {
        const { rows } = await runtime.query<{ "QUERY PLAN": string }>(
          `explain (analyze, buffers, format text) ${sql}`,
          params,
        );
        const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
        const blocksRead = /^ +Buffers: shared ([^\n]+)/mu.exec(plan)?.[1];
        assert.ok(blocksRead, plan);
        for (const [, blocks] of blocksRead.matchAll(/(?:hit|read)=(\d+)/gu))
          buffers += Number(blocks);
        plans.push(plan);
      }
      return { reads, plans, buffers };
    }

    // Measure both probes at the same B-tree depth, with the baseline rows in another organization.
    await insertArchive("other", 30_000);
    const before = await measure();
    await runtime.query(`
      with enrolled as (
        select gen_random_uuid() as daemon_id, gen_random_uuid() as machine_id
        from generate_series(1,10000)
      ), inserted_machines as (
        insert into machines (id, org_id, source, status)
        select machine_id, 'fixture', jsonb_build_object('kind', 'daemon', 'daemonId', daemon_id), 'alive'
        from enrolled returning id
      )
      insert into daemons
        (id, idempotency_key, enrollment_verifier, slug, machine_id, organization_id, server_id,
         daemon_public_key, credential_verifier, scopes, status, presence, disconnected_at)
      select e.daemon_id, e.daemon_id::text, 'test', e.daemon_id::text, m.id, 'fixture',
             'test', 'test', 'test', '["hub.execute"]'::jsonb, 'revoked', 'offline', now()
      from enrolled e join inserted_machines m on m.id = e.machine_id
    `);
    await runtime.query("analyze daemons");
    const revoked = await measure();
    await insertArchive("fixture", 15_000);
    const archived = await measure();

    if (process.env["HUB_HOME_SESSION_EXPLAIN"] === "1") {
      process.stdout.write(
        `Home session probe buffers: ${before.buffers}, ${revoked.buffers}, ${archived.buffers}\n` +
          archived.plans.join("\n\n") +
          "\n",
      );
    }
    assert.equal(revoked.buffers, before.buffers, "revoked daemons must not add buffer reads");
    assert.equal(
      archived.buffers,
      before.buffers,
      "unrelated closed sessions must not add buffer reads",
    );
    assert.equal(archived.reads.length, 1);
    const read = archived.reads[0];
    assert.ok(read);
    const [sql, params] = read;
    assert.deepEqual(params, ["fixture", "owner"]);
    assert.doesNotMatch(sql, /\b(?:daemons|machines|state|for\s+share)\b/iu);
    const [plan] = archived.plans;
    assert.ok(plan);
    assert.match(plan, /interactive_sessions_start_key_unique/u);
    assert.match(plan, /interactive_session_participants_org_user_idx/u);
    assert.doesNotMatch(plan, /Seq Scan on interactive_session/u);
  });
}, 90_000);

async function withStores(
  exercise: (context: {
    pg: Database;
    memory: Database;
    runtime: Awaited<ReturnType<typeof createPostgresTestRuntime>>["runtime"];
  }) => Promise<void>,
) {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  try {
    const { runtime, database: pg } = await createPostgresTestRuntime(container.getConnectionUri());
    try {
      const memory = createMemoryDatabase({ memberships });
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
      await exercise({ pg, memory, runtime });
    } finally {
      await runtime.close();
    }
  } finally {
    await container.stop();
  }
}
