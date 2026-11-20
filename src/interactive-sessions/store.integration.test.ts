import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { interactiveSessionStoreContract } from "./store.contract.js";

let container: StartedPostgreSqlContainer | undefined;
let organization: string | undefined;
let root: Awaited<ReturnType<typeof createPostgresTestRuntime>> | undefined;

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
  if (organization === undefined) return;
  await root?.runtime.query("delete from organization where id = $1", [organization]);
  organization = undefined;
});

interactiveSessionStoreContract("PostgreSQL", async ({ organizationId, users }) => {
  if (!root) throw new Error("PostgreSQL fixture is unavailable");
  organization = organizationId;
  await root.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    organizationId,
  ]);
  for (const { userId, role } of users) {
    await root.runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
      userId,
      userId + "@example.test",
    ]);
    await root.runtime.query(
      "insert into member (id, organization_id, user_id, role) values ($1, $2, $3, $4)",
      [userId + "-membership", organizationId, userId, role],
    );
  }
  return root.database;
});
