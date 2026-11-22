import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, it } from "vitest";
import { createDatabase } from "../db/pg.js";
import { postgresDatabaseRuntime } from "../db/runtime/index.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import {
  observedRuntime,
  type TimelineQueryHooks,
} from "../db/test-utils/run-timeline-postgres.js";
import {
  prepareBinding,
  startFixtureSession,
  surfaceStoreContract,
  surfaceTenant,
  type SurfaceTenant,
} from "./store.contract.js";

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
  await root?.runtime.query(
    'delete from "user" where id = any($1::text[]) or id = any($2::text[])',
    [used.map(({ userId }) => userId), used.map(({ userId }) => userId + "-member")],
  );
});

async function restoreConnection({ connection }: SurfaceTenant) {
  await root.runtime.query(
    `insert into linear_connections
    (id, organization_id, linear_organization_id, provider_application_id, slug,
     linear_organization_name, app_user_id, access_token)
    values ($1, $2, $3, $4, $3, $5, $6, $7)`,
    [
      connection.id,
      connection.organizationId,
      connection.linearOrganizationId,
      connection.providerApplicationId,
      connection.linearOrganizationName,
      connection.appUserId,
      connection.accessToken,
    ],
  );
}

async function createTenant(tenant: SurfaceTenant) {
  tenants.push(tenant);
  const { organizationId, userId } = tenant;
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
  await restoreConnection(tenant);
}

surfaceStoreContract("PostgreSQL", async (fixtures) => {
  for (const tenant of fixtures) await createTenant(tenant);
  return {
    database: root.database,
    async removeMember({ organizationId, userId }) {
      await root.runtime.query("delete from member where organization_id = $1 and user_id = $2", [
        organizationId,
        userId,
      ]);
    },
    async removeConnection({ organizationId, connection }) {
      await root.runtime.query(
        "delete from linear_connections where organization_id = $1 and id = $2",
        [organizationId, connection.id],
      );
    },
    restoreConnection,
  };
});

async function connect(hooks: TimelineQueryHooks = {}) {
  const bundle = await postgresDatabaseRuntime(container.getConnectionUri(), { max: 1 });
  const {
    rows: [row],
  } = await bundle.runtime.query<{ pid: number }>("select pg_backend_pid() as pid");
  return {
    runtime: bundle.runtime,
    pid: row!.pid,
    database: createDatabase(observedRuntime(bundle.runtime, hooks), bundle.locks),
  };
}

it("stores only binding metadata in the surface binding table", async () => {
  const { rows } = await root.runtime.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_schema = current_schema() and table_name = 'surface_bindings'
     order by ordinal_position`,
  );
  assert.deepEqual(
    rows.map(({ column_name }) => column_name),
    [
      "id",
      "organization_id",
      "workspace_id",
      "application_id",
      "app_user_id",
      "native_session_id",
      "connection_id",
      "issue_id",
      "team_id",
      "session_id",
      "policy_revision",
      "generation",
      "created_at",
      "superseded_at",
    ],
  );
});

it("selects one exact binding with zero added statements after 2,000 out-of-scope rows", async () => {
  const tenant = surfaceTenant();
  await createTenant(tenant);
  const { binding } = await prepareBinding(root.database, tenant);
  const expected = await root.database.supersedeSurfaceBinding(binding);
  assert.ok(expected);
  const statements: { sql: string; params: readonly unknown[] }[] = [];
  const observer = await connect({
    async beforeQuery(sql, params) {
      statements.push({ sql, params });
    },
  });
  try {
    assert.deepEqual(await observer.database.findSurfaceBinding(binding), expected);
    const baseline = statements.length;
    assert.equal(baseline, 1);
    const inserted = await root.runtime.query(
      `insert into surface_bindings
        (organization_id, workspace_id, application_id, app_user_id, native_session_id,
         connection_id, issue_id, team_id, session_id, policy_revision, generation)
       select organization_id, workspace_id, application_id, app_user_id, 'noise-' || n,
              connection_id, issue_id, team_id, session_id, policy_revision, generation
       from surface_bindings cross join generate_series(1, 2000) n where id = $1`,
      [expected.id],
    );
    assert.equal(inserted.rowCount, 2_000);
    await root.runtime.query("analyze surface_bindings");
    statements.length = 0;
    assert.deepEqual(await observer.database.findSurfaceBinding(binding), expected);
    assert.equal(statements.length - baseline, 0);
    const [statement] = statements;
    assert.ok(statement);
    const { sql, params } = statement;
    const query = await observer.runtime.query(sql, params);
    assert.equal(query.rowCount, 1);
    const plan = await observer.runtime.query<{ "QUERY PLAN": string }>(
      "explain (analyze) " + sql,
      params,
    );
    assert.match(
      plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
      /Index Scan using surface_bindings_(?:current|generation)_unique on surface_bindings b [^\n]+rows=1 loops=1/u,
    );
  } finally {
    await observer.runtime.close();
  }
});

it("serializes supersede across two PostgreSQL backends with an observed lock wait", async () => {
  const tenant = surfaceTenant();
  await createTenant(tenant);
  const { binding, request } = await prepareBinding(root.database, tenant);
  const initial = await root.database.supersedeSurfaceBinding(binding);
  assert.ok(initial);
  const replacement = await startFixtureSession(root.database, request);
  const contender = await startFixtureSession(root.database, request);
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = await connect({
    async afterQuery(sql) {
      if (sql.includes("update surface_bindings")) {
        held.resolve();
        await release.promise;
      }
    },
  });
  const waiter = await connect();
  let first: ReturnType<typeof root.database.supersedeSurfaceBinding> | undefined;
  let second: typeof first;
  try {
    first = holder.database.supersedeSurfaceBinding({
      ...binding,
      expectedGeneration: 1,
      sessionId: replacement.id,
    });
    await Promise.race([
      held.promise,
      first.then(() => assert.fail("first writer did not reach its barrier")),
    ]);
    second = waiter.database.supersedeSurfaceBinding({
      ...binding,
      expectedGeneration: 1,
      sessionId: contender.id,
    });
    const deadline = performance.now() + 2_000;
    while (true) {
      const {
        rows: [row],
      } = await root.runtime.query<{ blocked: boolean }>(
        "select $1 = any(pg_blocking_pids($2)) as blocked",
        [holder.pid, waiter.pid],
      );
      if (row?.blocked) break;
      assert.ok(performance.now() < deadline, "second writer did not wait on the first writer");
      await delay(5);
    }
    release.resolve();
    assert.equal((await first)?.sessionId, replacement.id);
    assert.equal(await second, undefined);
    assert.equal((await root.database.findSurfaceBinding(binding))?.generation, 2);
    assert.equal((await root.database.findSurfaceBindingGeneration(binding, 1))?.id, initial.id);
    const { rowCount } = await root.runtime.query(
      "select id from surface_bindings where organization_id = $1 and superseded_at is null",
      [tenant.organizationId],
    );
    assert.equal(rowCount, 1);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    await Promise.all([holder.runtime.close(), waiter.runtime.close()]);
  }
});
