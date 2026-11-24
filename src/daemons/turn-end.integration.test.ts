import { randomUUID } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe } from "vitest";
import { clonedPostgresDatabase } from "../db/test-utils/isolated-postgres.js";
import { createDatabase, createPostgresQueryRuntime } from "../db/test-utils/runtime.js";
import { startDaemonTestPostgres } from "./test-utils/postgres-container.js";
import { registerTurnEndScenarios } from "./test-utils/turn-end-scenarios.js";

describe("daemon lifecycle with PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer;
  const opened: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    postgres = await startDaemonTestPostgres();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(opened.map((database) => database.close()));
    await postgres.stop();
  }, 120_000);

  registerTurnEndScenarios(async () => {
    // Scenarios never close their database. They run one at a time, so release the previous
    // pool here or the server runs out of connections.
    await Promise.all(opened.splice(0).map((database) => database.close()));
    const { url } = await clonedPostgresDatabase(postgres);
    const database = await createDatabase(url);
    opened.push(database);
    const organizationId = `org-${randomUUID()}`;
    const client = await createPostgresQueryRuntime(url);
    await client.query("insert into organization (id, name, slug) values ($1, 'Turn end', $2)", [
      organizationId,
      organizationId,
    ]);
    await client.close();
    return { database, organizationId };
  });
});
