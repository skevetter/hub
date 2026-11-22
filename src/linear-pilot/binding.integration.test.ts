import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { postgresDatabaseRuntime, type DatabaseRuntime } from "../db/runtime/index.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { observedRuntime } from "../db/test-utils/run-timeline-postgres.js";
import {
  installation,
  policyInput,
  prepareProfile,
  startFixtureSession,
  surfaceTenant,
  surfaceTestTime,
  type SurfaceTenant,
} from "../surfaces/store.contract.js";
import { PILOT_POLICY_REVISION, PilotBindings } from "./binding.js";
import type {
  PilotAdvanceInput,
  PilotAuthority,
  PilotNativeOrigin,
  PilotRefusal,
} from "./binding.js";

let container: StartedPostgreSqlContainer;
let root: Awaited<ReturnType<typeof createPostgresTestRuntime>>;
const tenants: SurfaceTenant[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  root = await createPostgresTestRuntime(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  try {
    await root?.runtime.close();
  } finally {
    await container?.stop();
  }
}, 30_000);

afterEach(async () => {
  const used = tenants.splice(0);
  await root?.runtime.query("delete from organization where id = any($1::text[])", [
    used.map(({ organizationId }) => organizationId),
  ]);
  await root?.runtime.query('delete from "user" where id = any($1::text[])', [
    used.flatMap(({ userId }) => [userId, userId + "-member"]),
  ]);
});

async function createTenant(tenant: SurfaceTenant) {
  tenants.push(tenant);
  const { organizationId, userId, connection } = tenant;
  await root.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    organizationId,
  ]);
  for (const [id, role] of [
    [userId, "owner"],
    [userId + "-member", "member"],
  ]) {
    await root.runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
      id,
      id + "@example.test",
    ]);
    await root.runtime.query(
      "insert into member (id, organization_id, user_id, role) values ($1, $2, $3, $4)",
      [id + "-membership", organizationId, id, role],
    );
  }
  await root.runtime.query(
    `insert into linear_connections
      (id, organization_id, linear_organization_id, provider_application_id, slug,
       linear_organization_name, app_user_id, access_token)
     values ($1, $2, $3, $4, $3, $5, $6, $7)`,
    [
      connection.id,
      organizationId,
      connection.linearOrganizationId,
      connection.providerApplicationId,
      connection.linearOrganizationName,
      connection.appUserId,
      connection.accessToken,
    ],
  );
}

async function fixture(teamIds: readonly string[] = ["team"]) {
  const tenant = surfaceTenant();
  await createTenant(tenant);
  const { profile, request } = await prepareProfile(root.database, tenant);
  const authority: PilotAuthority = {
    ...installation(tenant),
    connectionId: tenant.connection.id,
    profileId: profile.id,
    ownerUserId: tenant.userId,
    humanProviderUserId: randomUUID(),
    teamIds,
  };
  const pilot = new PilotBindings(root.runtime, root.locks, root.database);
  const mapped = await pilot.mapIdentity(authority, "Pilot human", surfaceTestTime);
  assert.equal(mapped.status, "mapped");
  const identityId = mapped.identity.id;
  const startSession = (requesterIdentityId = identityId) =>
    startFixtureSession(root.database, {
      ...request,
      nativeRequester: { identityId: requesterIdentityId, workspaceId: authority.workspaceId },
    });
  const origin = (
    overrides: Partial<{ nativeSessionId: string; issueId: string; teamId: string }> = {},
  ) => ({
    nativeSessionId: randomUUID(),
    issueId: "issue",
    teamId: "team",
    actorProviderUserId: authority.humanProviderUserId,
    ...overrides,
  });
  const admit = async (native: PilotNativeOrigin, sessionId: string, from: PilotBindings = pilot) =>
    from.admit(authority, { ...native, sessionId, now: surfaceTestTime });
  const rows = async (nativeSessionId?: string) =>
    (
      await root.runtime.query<{ id: string; generation: number }>(
        `select id, generation from surface_bindings
         where organization_id = $1 and ($2::text is null or native_session_id = $2)
         order by generation`,
        [tenant.organizationId, nativeSessionId ?? null],
      )
    ).rows;
  const sql = (text: string, params: unknown[] = []) => root.runtime.query(text, params);
  return {
    tenant,
    request,
    profile,
    authority,
    pilot,
    identityId,
    startSession,
    origin,
    admit,
    rows,
    sql,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function markRetired(f: Fixture, sessionId: string) {
  const agentId = `agent-${sessionId}`;
  await f.sql(
    `update interactive_sessions
     set state = 'closed', state_reason = null, closed_at = $1, closed_by_user_id = null,
         daemon_agent_id = $2, turn = 1
     where id = $3`,
    [surfaceTestTime, agentId, sessionId],
  );
  const {
    rows: [command],
  } = await root.runtime.query<{ id: string }>(
    `update interactive_session_commands set status = 'delivered', settled_at = $1
     where session_id = $2 and ordinal = 1 returning id`,
    [surfaceTestTime, sessionId],
  );
  assert.ok(command);
  return { sessionGeneration: 1, turn: 1, agentId, firstCommandId: command.id };
}

async function advanceFixture(f: Fixture, native = f.origin()) {
  const [old, next] = [await f.startSession(), await f.startSession()];
  const created = await f.admit(native, old.id);
  assert.ok("binding" in created);
  const retirement = await markRetired(f, old.id);
  const input: PilotAdvanceInput = {
    ...native,
    expected: {
      bindingId: created.binding.id,
      sessionId: old.id,
      generation: 1,
      ...retirement,
    },
    nextSessionId: next.id,
    now: surfaceTestTime,
  };
  return { native, old, next, input };
}

function refusal(reason: PilotRefusal) {
  return { status: "refused", reason };
}

describe("pilot binding over surface_bindings", () => {
  it("creates one generation-1 pilot row, replays it exactly and finds it", async () => {
    const f = await fixture();
    const session = await f.startSession();
    const native = f.origin();
    const created = await f.admit(native, session.id);
    assert.equal(created.status, "created");
    assert.ok("binding" in created);
    assert.equal(created.binding.generation, 1);
    assert.equal(created.binding.policyRevision, PILOT_POLICY_REVISION);
    assert.equal(created.binding.sessionId, session.id);
    assert.equal(created.binding.connectionId, f.authority.connectionId);
    const replayed = await f.admit(native, session.id);
    assert.deepEqual(replayed, { status: "replayed", binding: created.binding });
    assert.deepEqual(await f.pilot.find(f.authority, native), {
      status: "bound",
      binding: created.binding,
    });
    assert.equal((await f.rows()).length, 1);
    assert.deepEqual(await f.pilot.find(f.authority, f.origin()), { status: "none" });
  });

  it("resolves exact connection metadata without credential columns and refuses drift", async () => {
    const f = await fixture();
    const resolved = await f.pilot.resolveConnection(f.authority);
    assert.deepEqual(resolved, {
      status: "resolved",
      connection: {
        connectionId: f.authority.connectionId,
        organizationId: f.authority.organizationId,
        workspaceId: f.authority.workspaceId,
        applicationId: f.authority.applicationId,
        appUserId: f.authority.appUserId,
      },
    });
    await f.sql("update linear_connections set app_user_id = $1 where id = $2", [
      randomUUID(),
      f.authority.connectionId,
    ]);
    assert.deepEqual(await f.pilot.resolveConnection(f.authority), refusal("access_lost"));
  });

  it("refuses to map the human when the owner is only a member", async () => {
    const f = await fixture();
    await f.sql("update member set role = 'member' where organization_id = $1 and user_id = $2", [
      f.tenant.organizationId,
      f.tenant.userId,
    ]);
    const other = { ...f.authority, humanProviderUserId: randomUUID() };
    assert.deepEqual(
      await f.pilot.mapIdentity(other, "Someone", surfaceTestTime),
      refusal("owner_mismatch"),
    );
  });

  it("maps the configured human to the profile owner once and never overwrites a mapping", async () => {
    const f = await fixture();
    const again = await f.pilot.mapIdentity(f.authority, "Pilot human", surfaceTestTime);
    assert.equal(again.status, "existing");
    assert.ok("identity" in again);
    assert.equal(again.identity.id, f.identityId);
    await f.sql("update member_identities set user_id = $1 where id = $2", [
      f.tenant.userId + "-member",
      f.identityId,
    ]);
    assert.deepEqual(
      await f.pilot.mapIdentity(f.authority, "Pilot human", surfaceTestTime),
      refusal("identity_conflict"),
    );
    const rows = await f.sql("select user_id from member_identities where id = $1", [f.identityId]);
    assert.equal(rows.rows[0]?.["user_id"], f.tenant.userId + "-member");
  });

  it("refuses to map for a non-owner, an inactive profile or the app actor", async () => {
    const f = await fixture();
    const before = (await f.sql("select id from member_identities")).rowCount;
    const stranger = { ...f.authority, humanProviderUserId: randomUUID() };
    await f.sql("update interactive_session_profiles set created_by_user_id = $1 where id = $2", [
      f.tenant.userId + "-member",
      f.profile.id,
    ]);
    assert.deepEqual(
      await f.pilot.mapIdentity(stranger, "Someone", surfaceTestTime),
      refusal("owner_mismatch"),
    );
    await f.sql("update interactive_session_profiles set created_by_user_id = $1 where id = $2", [
      f.tenant.userId,
      f.profile.id,
    ]);
    await f.sql("update interactive_session_profiles set status = 'disabled' where id = $1", [
      f.profile.id,
    ]);
    assert.deepEqual(
      await f.pilot.mapIdentity(stranger, "Someone", surfaceTestTime),
      refusal("profile_unavailable"),
    );
    assert.deepEqual(
      await f.pilot.mapIdentity(
        { ...stranger, humanProviderUserId: f.authority.appUserId },
        "App",
        surfaceTestTime,
      ),
      refusal("invalid_input"),
    );
    assert.equal((await f.sql("select id from member_identities")).rowCount, before);
  });

  const unauthorized: [string, (f: Fixture) => Promise<void>, PilotRefusal][] = [
    [
      "profile owner changed",
      (f) =>
        f
          .sql("update interactive_session_profiles set created_by_user_id = $1 where id = $2", [
            f.tenant.userId + "-member",
            f.profile.id,
          ])
          .then(() => undefined),
      "owner_mismatch",
    ],
    [
      "owner demoted to member",
      (f) =>
        f
          .sql("update member set role = 'member' where organization_id = $1 and user_id = $2", [
            f.tenant.organizationId,
            f.tenant.userId,
          ])
          .then(() => undefined),
      "owner_mismatch",
    ],
    [
      "owner membership removed",
      (f) =>
        f
          .sql("delete from member where organization_id = $1 and user_id = $2", [
            f.tenant.organizationId,
            f.tenant.userId,
          ])
          .then(() => undefined),
      "owner_mismatch",
    ],
    [
      "profile disabled",
      (f) =>
        f
          .sql("update interactive_session_profiles set status = 'disabled' where id = $1", [
            f.profile.id,
          ])
          .then(() => undefined),
      "profile_unavailable",
    ],
    [
      "profile version moved on",
      (f) =>
        f
          .sql("update interactive_session_profiles set version = version + 1 where id = $1", [
            f.profile.id,
          ])
          .then(() => undefined),
      "profile_changed",
    ],
    [
      "session closed",
      (f) =>
        f
          .sql("update interactive_sessions set state = 'closed', closed_at = now()")
          .then(() => undefined),
      "session_unavailable",
    ],
    [
      "session is a web session",
      (f) =>
        f
          .sql("update interactive_sessions set origin = 'web', requester_identity_id = null")
          .then(() => undefined),
      "session_unavailable",
    ],
    [
      "session started by another member",
      (f) =>
        f
          .sql("update interactive_sessions set started_by_user_id = $1", [
            f.tenant.userId + "-member",
          ])
          .then(() => undefined),
      "session_unavailable",
    ],
    [
      "mapping removed",
      (f) =>
        f.sql("delete from member_identities where id = $1", [f.identityId]).then(() => undefined),
      "identity_unmapped",
    ],
    [
      "mapping moved to another user",
      (f) =>
        f
          .sql("update member_identities set user_id = $1 where id = $2", [
            f.tenant.userId + "-member",
            f.identityId,
          ])
          .then(() => undefined),
      "identity_conflict",
    ],
    [
      "connection removed",
      (f) =>
        f
          .sql("delete from linear_connections where id = $1", [f.authority.connectionId])
          .then(() => undefined),
      "access_lost",
    ],
    [
      "connection reauthorized to another app user",
      (f) =>
        f
          .sql("update linear_connections set app_user_id = $1 where id = $2", [
            randomUUID(),
            f.authority.connectionId,
          ])
          .then(() => undefined),
      "access_lost",
    ],
    [
      "connection reauthorized to another application",
      (f) =>
        f
          .sql("update linear_connections set provider_application_id = 'other' where id = $1", [
            f.authority.connectionId,
          ])
          .then(() => undefined),
      "access_lost",
    ],
  ];

  for (const [name, change, reason] of unauthorized) {
    it(`refuses admission and writes nothing when the ${name}`, async () => {
      const f = await fixture();
      const session = await f.startSession();
      await change(f);
      const native = f.origin();
      assert.deepEqual(await f.admit(native, session.id), refusal(reason));
      assert.deepEqual((await f.rows()).length, 0);
    });

    it(`refuses a stored pilot binding when the ${name}`, async () => {
      const f = await fixture();
      const session = await f.startSession();
      const native = f.origin();
      assert.equal((await f.admit(native, session.id)).status, "created");
      await change(f);
      const found = await f.pilot.find(f.authority, native);
      assert.deepEqual(found, refusal(reason));
      assert.deepEqual((await f.admit(native, session.id)).status, "refused");
      assert.equal((await f.rows()).length, 1);
    });
  }

  it("refuses a different actor, an actor that is not the session requester, and out-of-scope teams", async () => {
    const f = await fixture(["team", "other-team"]);
    const session = await f.startSession();
    const native = f.origin();
    assert.deepEqual(
      await f.pilot.admit(f.authority, {
        ...native,
        actorProviderUserId: randomUUID(),
        sessionId: session.id,
        now: surfaceTestTime,
      }),
      refusal("actor_mismatch"),
    );
    assert.deepEqual(
      await f.admit(f.origin({ teamId: "elsewhere" }), session.id),
      refusal("team_out_of_scope"),
    );
    const second = await root.database.createSurfaceIdentity({
      organizationId: f.authority.organizationId,
      workspaceId: f.authority.workspaceId,
      providerUserId: randomUUID(),
      userId: f.authority.ownerUserId,
      label: "Second human",
      now: surfaceTestTime,
    });
    assert.ok(second);
    const foreign = await f.startSession(second.id);
    assert.deepEqual(await f.admit(native, foreign.id), refusal("actor_mismatch"));
    assert.equal((await f.rows()).length, 0);
    const shrunk = { ...f.authority, teamIds: ["other-team"] };
    assert.equal((await f.admit(native, session.id)).status, "created");
    assert.deepEqual(await f.pilot.find(shrunk, native), refusal("team_out_of_scope"));
  });

  it("refuses reconnects, mismatched history and tampered rows without changing them", async () => {
    const f = await fixture(["team", "other-team"]);
    const session = await f.startSession();
    const native = f.origin();
    const created = await f.admit(native, session.id);
    assert.ok("binding" in created);
    const snapshot = async () =>
      (await f.sql("select * from surface_bindings where id = $1", [created.binding.id])).rows;
    const before = await snapshot();

    assert.deepEqual(
      await f.admit(native, (await f.startSession()).id),
      refusal("reconnect_unqualified"),
    );
    assert.deepEqual(
      await f.admit({ ...native, issueId: "another" }, session.id),
      refusal("history_mismatch"),
    );
    assert.deepEqual(
      await f.admit({ ...native, teamId: "other-team" }, session.id),
      refusal("history_mismatch"),
    );
    assert.deepEqual(await f.admit(f.origin(), session.id), refusal("session_already_bound"));
    assert.deepEqual(await snapshot(), before);

    for (const [change, restore] of [
      ["generation = 2", "generation = 1"],
      ["superseded_at = now()", "superseded_at = null"],
      ["connection_id = gen_random_uuid()", `connection_id = '${f.authority.connectionId}'`],
    ] as const) {
      await f.sql(`update surface_bindings set ${change} where id = $1`, [created.binding.id]);
      assert.deepEqual(await f.admit(native, session.id), refusal("history_mismatch"), change);
      assert.deepEqual(
        await f.pilot.find(f.authority, native),
        refusal("history_mismatch"),
        change,
      );
      await f.sql(`update surface_bindings set ${restore} where id = $1`, [created.binding.id]);
    }
    await f.sql("update surface_bindings set superseded_at = now() where id = $1", [
      created.binding.id,
    ]);
    await f.sql(
      `insert into surface_bindings (organization_id, workspace_id, application_id, app_user_id,
         native_session_id, connection_id, issue_id, team_id, session_id, policy_revision, generation, superseded_at)
       select organization_id, workspace_id, application_id, app_user_id, native_session_id,
              connection_id, issue_id, team_id, session_id, policy_revision, 2, null
       from surface_bindings where id = $1`,
      [created.binding.id],
    );
    assert.deepEqual(await f.admit(native, session.id), refusal("history_mismatch"));
    assert.equal((await f.rows()).length, 2);
  });

  it("cannot adopt or replace a general binding", async () => {
    const f = await fixture();
    const policy = {
      ...policyInput(f.tenant, f.request),
      enabled: true,
      verifiedAppHandle: "paseo",
    };
    assert.ok(await root.database.saveSurfacePolicy(policy));
    const general = await f.startSession();
    const native = f.origin();
    const key = { ...installation(f.tenant), nativeSessionId: native.nativeSessionId };
    const generalBinding = await root.database.supersedeSurfaceBinding({
      ...key,
      connectionId: f.authority.connectionId,
      issueId: native.issueId,
      teamId: native.teamId,
      sessionId: general.id,
      policyRevision: 1,
      expectedGeneration: null,
      now: surfaceTestTime,
    });
    assert.ok(generalBinding);
    assert.deepEqual(await f.admit(native, (await f.startSession()).id), refusal("rolled_out"));
    assert.ok(
      await root.database.saveSurfacePolicy({
        ...policy,
        enabled: false,
        verifiedAppHandle: null,
        expectedRevision: 1,
      }),
    );
    const before = await f.rows();
    assert.deepEqual(
      await f.admit(native, (await f.startSession()).id),
      refusal("foreign_binding"),
    );
    assert.deepEqual(await f.admit(native, general.id), refusal("foreign_binding"));
    assert.deepEqual(
      await f.pilot.advance(f.authority, {
        ...native,
        expected: {
          bindingId: generalBinding.id,
          generation: 1,
          sessionId: general.id,
          sessionGeneration: 1,
          turn: 1,
          agentId: "agent",
          firstCommandId: randomUUID(),
        },
        nextSessionId: (await f.startSession()).id,
        now: surfaceTestTime,
      }),
      refusal("foreign_binding"),
    );
    assert.deepEqual(await f.pilot.find(f.authority, native), refusal("foreign_binding"));
    // The same Hub session already bound by the general path under another native session.
    assert.deepEqual(await f.admit(f.origin(), general.id), refusal("session_already_bound"));
    assert.deepEqual(await f.rows(), before);
    assert.deepEqual(
      (await root.database.findSurfaceBindingGeneration(key, 1))?.id,
      generalBinding.id,
    );
  });

  it("retires when a general policy is enabled and the general path can then supersede the pilot row", async () => {
    const f = await fixture();
    const session = await f.startSession();
    const native = f.origin();
    const created = await f.admit(native, session.id);
    assert.ok("binding" in created);
    const key = { ...installation(f.tenant), nativeSessionId: native.nativeSessionId };
    const policy = {
      ...policyInput(f.tenant, f.request),
      enabled: true,
      verifiedAppHandle: "paseo",
    };
    assert.ok(await root.database.saveSurfacePolicy(policy));
    assert.equal(await root.database.findSurfaceBinding(key), undefined);
    assert.deepEqual(await f.pilot.find(f.authority, native), refusal("rolled_out"));
    assert.deepEqual(await f.admit(native, session.id), refusal("rolled_out"));
    const next = await f.startSession();
    const superseded = await root.database.supersedeSurfaceBinding({
      ...key,
      connectionId: f.authority.connectionId,
      issueId: native.issueId,
      teamId: native.teamId,
      sessionId: next.id,
      policyRevision: 1,
      expectedGeneration: 1,
      now: surfaceTestTime,
    });
    assert.equal(superseded?.generation, 2);
    assert.equal((await root.database.findSurfaceBinding(key))?.id, superseded?.id);
    assert.deepEqual(await f.pilot.find(f.authority, native), refusal("rolled_out"));
  });

  it("advances a retired predecessor, replays its exact successor and follows a contiguous chain", async () => {
    const f = await fixture();
    const { input, native, old, next } = await advanceFixture(f);
    assert.deepEqual(await f.pilot.find(f.authority, native), refusal("session_unavailable"));
    assert.deepEqual(await f.admit(native, old.id), refusal("session_unavailable"));
    const second = await f.pilot.advance(f.authority, input);
    assert.equal(second.status, "advanced");
    assert.equal(second.binding.generation, 2);
    assert.equal(second.binding.sessionId, next.id);
    assert.equal(second.binding.policyRevision, PILOT_POLICY_REVISION);
    const known = { status: "replayed", binding: second.binding };
    await f.sql("update interactive_sessions set state = 'running', turn = 1 where id = $1", [
      next.id,
    ]);
    assert.deepEqual(await f.pilot.advance(f.authority, input), known);
    assert.deepEqual(await f.pilot.find(f.authority, native), {
      status: "bound",
      binding: second.binding,
    });
    assert.deepEqual(await f.admit(native, next.id), known);
    const key = { ...installation(f.tenant), nativeSessionId: native.nativeSessionId };
    assert.equal(await root.database.findSurfaceBinding(key), undefined);

    const retirement = await markRetired(f, next.id);
    const thirdSession = await f.startSession();
    const third = await f.pilot.advance(f.authority, {
      ...input,
      expected: { bindingId: second.binding.id, sessionId: next.id, generation: 2, ...retirement },
      nextSessionId: thirdSession.id,
    });
    assert.equal(third.status, "advanced");
    assert.equal(third.binding.generation, 3);
    const rows = await f.sql(
      `select session_id, generation, superseded_at from surface_bindings
       where native_session_id = $1 order by generation`,
      [native.nativeSessionId],
    );
    assert.deepEqual(rows.rows, [
      { session_id: old.id, generation: 1, superseded_at: surfaceTestTime },
      { session_id: next.id, generation: 2, superseded_at: surfaceTestTime },
      { session_id: thirdSession.id, generation: 3, superseded_at: null },
    ]);
    assert.equal((await f.pilot.advance(f.authority, input)).status, "refused");
    assert.deepEqual(await f.pilot.find(f.authority, native), {
      status: "bound",
      binding: third.binding,
    });
    const policy = {
      ...policyInput(f.tenant, f.request),
      enabled: true,
      verifiedAppHandle: "paseo",
    };
    assert.ok(await root.database.saveSurfacePolicy(policy));
    assert.equal(await root.database.findSurfaceBinding(key), undefined);
    assert.deepEqual(await f.pilot.advance(f.authority, input), refusal("rolled_out"));
    const generalBinding = await root.database.supersedeSurfaceBinding({
      ...key,
      connectionId: f.authority.connectionId,
      issueId: native.issueId,
      teamId: native.teamId,
      sessionId: (await f.startSession()).id,
      policyRevision: 1,
      expectedGeneration: 3,
      now: surfaceTestTime,
    });
    assert.equal(generalBinding?.generation, 4);
    assert.deepEqual(await root.database.findSurfaceBinding(key), generalBinding);
  });

  it("refuses gaps, split scope and a nonfinal current row in a pilot chain", async () => {
    const f = await fixture(["team", "other-team"]);
    const { input, native } = await advanceFixture(f);
    const second = await f.pilot.advance(f.authority, input);
    assert.equal(second.status, "advanced");
    for (const [update, revert, id] of [
      ["generation = 3", "generation = 2", second.binding.id],
      ["issue_id = 'other-issue'", "issue_id = 'issue'", input.expected.bindingId],
      ["team_id = 'other-team'", "team_id = 'team'", input.expected.bindingId],
      ["superseded_at = now()", "superseded_at = null", second.binding.id],
      [
        "policy_revision = 1",
        `policy_revision = ${PILOT_POLICY_REVISION}`,
        input.expected.bindingId,
      ],
    ] as const) {
      await f.sql(`update surface_bindings set ${update} where id = $1`, [id]);
      const { rows: before } = await f.sql(
        "select * from surface_bindings where native_session_id = $1 order by generation",
        [native.nativeSessionId],
      );
      assert.equal((await f.pilot.find(f.authority, native)).status, "refused");
      assert.equal((await f.pilot.advance(f.authority, input)).status, "refused");
      assert.deepEqual(
        (
          await f.sql(
            "select * from surface_bindings where native_session_id = $1 order by generation",
            [native.nativeSessionId],
          )
        ).rows,
        before,
      );
      await f.sql(`update surface_bindings set ${revert} where id = $1`, [id]);
    }
  });

  it("refuses a missing current binding, wrong expected tuple, issue or team without writes", async () => {
    const f = await fixture(["team", "other-team"]);
    const { input } = await advanceFixture(f);
    const before = await f.rows();
    for (const wrong of [
      { nativeSessionId: randomUUID() },
      { expected: { ...input.expected, bindingId: randomUUID() } },
      { expected: { ...input.expected, generation: 2 } },
      { expected: { ...input.expected, sessionId: randomUUID() } },
      { issueId: "other-issue" },
      { teamId: "other-team" },
      { teamId: "out-of-scope" },
      { actorProviderUserId: "other-actor" },
    ]) {
      assert.equal((await f.pilot.advance(f.authority, { ...input, ...wrong })).status, "refused");
    }
    assert.deepEqual(await f.rows(), before);
    const committed = await f.pilot.advance(f.authority, input);
    assert.equal(committed.status, "advanced");
    const after = await f.rows();
    for (const wrong of [
      { expected: { ...input.expected, bindingId: randomUUID() } },
      { expected: { ...input.expected, sessionId: randomUUID() } },
      { nextSessionId: (await f.startSession()).id },
      { issueId: "other-issue" },
    ]) {
      assert.equal((await f.pilot.advance(f.authority, { ...input, ...wrong })).status, "refused");
    }
    assert.deepEqual(await f.rows(), after);
  });

  it("refuses a predecessor without the exact retired closure or current requester authority", async () => {
    const f = await fixture();
    const { input, old } = await advanceFixture(f);
    const before = await f.rows();
    for (const state of ["idle", "running", "closed"]) {
      await f.sql(
        `update interactive_sessions set state = $1, state_reason = 'closed_by_person',
             closed_at = case when $1 = 'closed' then $2::timestamptz else null end
         where id = $3`,
        [state, surfaceTestTime, old.id],
      );
      assert.deepEqual(await f.pilot.advance(f.authority, input), refusal("session_unavailable"));
    }
    await markRetired(f, old.id);
    await f.sql("update interactive_sessions set closed_by_user_id = $1 where id = $2", [
      f.tenant.userId,
      old.id,
    ]);
    assert.deepEqual(await f.pilot.advance(f.authority, input), refusal("session_unavailable"));
    await markRetired(f, old.id);
    await f.sql("update interactive_sessions set requester_identity_id = $1 where id = $2", [
      randomUUID(),
      old.id,
    ]);
    assert.deepEqual(await f.pilot.advance(f.authority, input), refusal("actor_mismatch"));
    assert.deepEqual(await f.rows(), before);
  });

  it("requires the exact retired Hub generation, turn, agent and delivered initial command", async () => {
    const f = await fixture();
    const { input } = await advanceFixture(f);
    const before = await f.rows();
    for (const wrong of [
      { sessionGeneration: 2 },
      { turn: 2 },
      { agentId: "other-agent" },
      { firstCommandId: randomUUID() },
    ]) {
      assert.equal(
        (
          await f.pilot.advance(f.authority, {
            ...input,
            expected: { ...input.expected, ...wrong },
          })
        ).status,
        "refused",
      );
    }
    for (const [column, changed, original] of [
      ["ordinal", 2, 1],
      ["generation", 2, 1],
      ["status", "unknown", "delivered"],
      ["failure_code", "delivery_unconfirmed", null],
      ["settled_at", null, surfaceTestTime],
      ["author_user_id", f.tenant.userId + "-member", f.tenant.userId],
    ] as const) {
      await f.sql(`update interactive_session_commands set ${column} = $1 where id = $2`, [
        changed,
        input.expected.firstCommandId,
      ]);
      assert.equal((await f.pilot.advance(f.authority, input)).status, "refused", column);
      await f.sql(`update interactive_session_commands set ${column} = $1 where id = $2`, [
        original,
        input.expected.firstCommandId,
      ]);
    }
    assert.deepEqual(await f.rows(), before);
  });

  it("refuses a nonfresh or previously bound successor without changing the retired binding", async () => {
    const f = await fixture();
    const { input, next } = await advanceFixture(f);
    const before = await f.rows();
    for (const [column, changed, original] of [
      ["state", "running", "starting"],
      ["generation", 2, 1],
      ["turn", 1, 0],
      ["command_seq", 2, 1],
      ["daemon_agent_id", "agent", null],
      ["daemon_workspace_id", "workspace", null],
      ["state_reason", "launch_failed", null],
    ] as const) {
      await f.sql(`update interactive_sessions set ${column} = $1 where id = $2`, [
        changed,
        next.id,
      ]);
      assert.deepEqual(
        await f.pilot.advance(f.authority, input),
        refusal("session_unavailable"),
        column,
      );
      await f.sql(`update interactive_sessions set ${column} = $1 where id = $2`, [
        original,
        next.id,
      ]);
    }
    assert.deepEqual(await f.rows(), before);
    const elsewhere = f.origin();
    const taken = await f.admit(elsewhere, next.id);
    assert.ok("binding" in taken);
    await f.sql("update surface_bindings set superseded_at = $1 where id = $2", [
      surfaceTestTime,
      taken.binding.id,
    ]);
    const withHistory = await f.rows();
    assert.deepEqual(await f.pilot.advance(f.authority, input), refusal("session_already_bound"));
    assert.deepEqual(await f.rows(), withHistory);
  });

  it("refuses an advance or exact replay after installation or owner authority changes", async () => {
    const f = await fixture();
    const { input } = await advanceFixture(f);
    const before = await f.rows();
    await f.sql("update member set role = 'member' where organization_id = $1", [
      f.tenant.organizationId,
    ]);
    assert.deepEqual(await f.pilot.advance(f.authority, input), refusal("owner_mismatch"));
    assert.deepEqual(await f.rows(), before);
    await f.sql("update member set role = 'owner' where organization_id = $1 and user_id = $2", [
      f.tenant.organizationId,
      f.tenant.userId,
    ]);
    assert.equal((await f.pilot.advance(f.authority, input)).status, "advanced");
    const after = await f.rows();
    await f.sql("update linear_connections set app_user_id = $1 where id = $2", [
      randomUUID(),
      f.authority.connectionId,
    ]);
    assert.deepEqual(await f.pilot.advance(f.authority, input), refusal("access_lost"));
    assert.deepEqual(await f.rows(), after);
  });

  async function backend(hooks: Parameters<typeof observedRuntime>[1] = {}) {
    const bundle = await postgresDatabaseRuntime(container.getConnectionUri(), { max: 1 });
    const {
      rows: [row],
    } = await bundle.runtime.query<{ pid: number }>("select pg_backend_pid() as pid");
    return {
      runtime: bundle.runtime,
      pid: row!.pid,
      pilot: new PilotBindings(observedRuntime(bundle.runtime, hooks), bundle.locks, root.database),
    };
  }

  async function raceBehindBarrier<First, Second>(
    pauseAfter: string,
    start: (
      first: PilotBindings,
      second: Awaited<ReturnType<typeof backend>>,
    ) => [Promise<First>, () => Promise<Second>],
  ) {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = await backend({
      async afterQuery(sql) {
        if (sql.includes(pauseAfter)) {
          held.resolve();
          await release.promise;
        }
      },
    });
    const waiter = await backend();
    let one: Promise<First> | undefined;
    let two: Promise<Second> | undefined;
    try {
      const [first, second] = start(holder.pilot, waiter);
      one = first;
      await Promise.race([
        held.promise,
        one.then(() => assert.fail("holder never reached its barrier")),
      ]);
      two = second();
      let waiterFinished = false;
      const settleWaiter = () => {
        waiterFinished = true;
        return undefined;
      };
      void two.then(settleWaiter, settleWaiter);
      const deadline = performance.now() + 5_000;
      while (true) {
        const {
          rows: [row],
        } = await root.runtime.query<{ blocked: boolean }>(
          "select $1 = any(pg_blocking_pids($2)) as blocked",
          [holder.pid, waiter.pid],
        );
        if (row?.blocked) break;
        assert.ok(!waiterFinished, "second transaction finished before the holder committed");
        assert.ok(performance.now() < deadline, "second transaction did not wait on the first");
        await delay(5);
      }
      release.resolve();
      return [await one, await two] as const;
    } finally {
      release.resolve();
      await Promise.allSettled([one, two]);
      await Promise.all([holder.runtime.close(), waiter.runtime.close()]);
    }
  }

  it("blocks a concurrent role-only demotion until the binding transaction commits", async () => {
    const f = await fixture();
    const session = await f.startSession();
    const native = f.origin();
    const [admitted, demoted] = await raceBehindBarrier("from member where", (holder, waiter) => [
      f.admit(native, session.id, holder),
      () =>
        waiter.runtime.query(
          "update member set role = 'member' where organization_id = $1 and user_id = $2",
          [f.tenant.organizationId, f.tenant.userId],
        ),
    ]);
    assert.equal(admitted.status, "created");
    assert.equal(demoted.rowCount, 1);
    assert.deepEqual(await f.pilot.find(f.authority, native), refusal("owner_mismatch"));
    assert.equal((await f.rows()).length, 1);
  });

  it("serializes different successors racing the same expected binding across backends", async () => {
    const f = await fixture();
    const { input } = await advanceFixture(f);
    const other = await f.startSession();
    const [one, two] = await raceBehindBarrier("insert into surface_bindings", (holder, waiter) => [
      holder.advance(f.authority, input),
      () => waiter.pilot.advance(f.authority, { ...input, nextSessionId: other.id }),
    ]);
    assert.equal(one.status, "advanced");
    assert.equal(two.status, "refused");
    assert.deepEqual(
      (await f.rows()).map(({ generation }) => generation),
      [1, 2],
    );
  });

  it("settles a concurrent exact retry as one advance and one replay across backends", async () => {
    const f = await fixture();
    const { input } = await advanceFixture(f);
    const [one, two] = await raceBehindBarrier("insert into surface_bindings", (holder, waiter) => [
      holder.advance(f.authority, input),
      () => waiter.pilot.advance(f.authority, input),
    ]);
    assert.equal(one.status, "advanced");
    assert.deepEqual(two, { status: "replayed", binding: one.binding });
    assert.deepEqual(
      (await f.rows()).map(({ generation }) => generation),
      [1, 2],
    );
  });

  it("serializes different native sessions competing for the same unbound successor", async () => {
    const f = await fixture();
    const { input } = await advanceFixture(f);
    const { input: other } = await advanceFixture(f);
    const [one, two] = await raceBehindBarrier("insert into surface_bindings", (holder, waiter) => [
      holder.advance(f.authority, input),
      () => waiter.pilot.advance(f.authority, { ...other, nextSessionId: input.nextSessionId }),
    ]);
    assert.equal(one.status, "advanced");
    assert.deepEqual(two, refusal("session_already_bound"));
    assert.equal(
      (await f.sql("select 1 from surface_bindings where session_id = $1", [input.nextSessionId]))
        .rowCount,
      1,
    );
  });

  it("rolls back predecessor supersession on failure and reports a lost commit acknowledgement", async () => {
    const f = await fixture();
    const { input } = await advanceFixture(f);
    const { rows: before } = await f.sql("select * from surface_bindings where id = $1", [
      input.expected.bindingId,
    ]);
    const failed = new Error("injected insert failure");
    const observer = await backend({
      async afterQuery(sql) {
        if (sql.includes("insert into surface_bindings")) throw failed;
      },
    });
    try {
      await assert.rejects(observer.pilot.advance(f.authority, input), (error) => error === failed);
      assert.deepEqual(
        (
          await f.sql("select * from surface_bindings where native_session_id = $1", [
            input.nativeSessionId,
          ])
        ).rows,
        before,
      );
    } finally {
      await observer.runtime.close();
    }

    const unknown = new Error("injected connection loss after commit");
    const runtime: DatabaseRuntime = {
      ...observedRuntime(root.runtime, {}),
      async transaction(operation) {
        await root.runtime.transaction(operation);
        throw unknown;
      },
    };
    const disconnected = new PilotBindings(runtime, root.locks, root.database);
    await assert.rejects(disconnected.advance(f.authority, input), (error) => error === unknown);
    assert.deepEqual(
      (await f.rows()).map(({ generation }) => generation),
      [1, 2],
    );
    assert.equal((await f.pilot.advance(f.authority, input)).status, "replayed");
    assert.deepEqual(
      (await f.rows()).map(({ generation }) => generation),
      [1, 2],
    );
  });

  it("serializes concurrent inserts for one native session across backends with an observed lock wait", async () => {
    const f = await fixture();
    const [first, second] = [await f.startSession(), await f.startSession()];
    const native = f.origin();
    const [one, two] = await raceBehindBarrier("insert into surface_bindings", (holder, waiter) => [
      f.admit(native, first.id, holder),
      () => f.admit(native, second.id, waiter.pilot),
    ]);
    assert.equal(one.status, "created");
    assert.deepEqual(two, refusal("reconnect_unqualified"));
    assert.deepEqual(
      (await f.rows(native.nativeSessionId)).map((row) => row.generation),
      [1],
    );
  });

  it("serializes two native sessions racing for one Hub session with an observed lock wait", async () => {
    const f = await fixture();
    const shared = await f.startSession();
    const [one, two] = await raceBehindBarrier("session_id = $2 limit 1", (holder, waiter) => [
      f.admit(f.origin(), shared.id, holder),
      () => f.admit(f.origin(), shared.id, waiter.pilot),
    ]);
    assert.equal(one.status, "created");
    assert.deepEqual(two, refusal("session_already_bound"));
    assert.equal(
      (await f.sql("select 1 from surface_bindings where session_id = $1", [shared.id])).rowCount,
      1,
    );
  });

  it("settles an unbarriered same-session replay race to one row", async () => {
    const f = await fixture();
    const [left, right] = [await backend(), await backend()];
    try {
      const session = await f.startSession();
      const native = f.origin();
      const same = await Promise.all([
        f.admit(native, session.id, left.pilot),
        f.admit(native, session.id, right.pilot),
      ]);
      assert.deepEqual(same.map((result) => result.status).sort(), ["created", "replayed"]);
      assert.equal((await f.rows(native.nativeSessionId)).length, 1);
    } finally {
      await Promise.all([left.runtime.close(), right.runtime.close()]);
    }
  });

  it("advances within 16 statements after 2,000 unrelated binding rows", async () => {
    const f = await fixture();
    const { input } = await advanceFixture(f);
    await f.sql(
      `insert into surface_bindings
        (organization_id, workspace_id, application_id, app_user_id, native_session_id,
         connection_id, issue_id, team_id, session_id, policy_revision, generation)
       select organization_id, workspace_id, application_id, app_user_id, 'noise-' || n,
              connection_id, issue_id, team_id, session_id, policy_revision, generation
       from surface_bindings cross join generate_series(1, 2000) n where id = $1`,
      [input.expected.bindingId],
    );
    const statements: string[] = [];
    const observer = await backend({
      async beforeQuery(sql) {
        statements.push(sql);
      },
    });
    try {
      const started = performance.now();
      assert.equal((await observer.pilot.advance(f.authority, input)).status, "advanced");
      assert.ok(statements.length <= 16, `advance used ${statements.length} statements`);
      assert.ok(performance.now() - started < 2_000);
      process.stdout.write(
        `Pilot advance used ${statements.length} statements after 2,000 unrelated rows.\n`,
      );
    } finally {
      await observer.runtime.close();
    }
  });

  it("stays within a statement bound and finds one row after 2,000 out-of-scope rows", async () => {
    const f = await fixture();
    const session = await f.startSession();
    const native = f.origin();
    const statements: string[] = [];
    const observer = await backend({
      async beforeQuery(sql) {
        statements.push(sql);
      },
    });
    try {
      const created = await f.admit(native, session.id, observer.pilot);
      assert.equal(created.status, "created");
      assert.ok(statements.length <= 14, `admit used ${statements.length} statements`);
      await f.sql(
        `insert into surface_bindings
          (organization_id, workspace_id, application_id, app_user_id, native_session_id,
           connection_id, issue_id, team_id, session_id, policy_revision, generation)
         select organization_id, workspace_id, application_id, app_user_id, 'noise-' || n,
                connection_id, issue_id, team_id, session_id, policy_revision, generation
         from surface_bindings cross join generate_series(1, 2000) n where native_session_id = $1`,
        [native.nativeSessionId],
      );
      await f.sql("analyze surface_bindings");
      statements.length = 0;
      const started = performance.now();
      assert.equal((await f.admit(native, session.id, observer.pilot)).status, "replayed");
      assert.equal((await observer.pilot.find(f.authority, native)).status, "bound");
      assert.ok(statements.length <= 22, `replay and find used ${statements.length} statements`);
      assert.ok(performance.now() - started < 2_000);
      const plan = await f.sql(
        `explain (analyze) select b.id from surface_bindings b
         where b.workspace_id = $1 and b.application_id = $2 and b.app_user_id = $3 and b.native_session_id = $4
         order by b.generation`,
        [
          f.authority.workspaceId,
          f.authority.applicationId,
          f.authority.appUserId,
          native.nativeSessionId,
        ],
      );
      assert.match(
        plan.rows.map((row) => String(row["QUERY PLAN"])).join("\n"),
        /Index (?:Only )?Scan using surface_bindings_(?:current|generation)_unique/u,
      );
    } finally {
      await observer.runtime.close();
    }
  });
});
