import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe } from "vitest";
import { createDatabase, createPostgresQueryRuntime } from "../db/test-utils/runtime.js";
import { registerTurnEndScenarios } from "./test-utils/turn-end-scenarios.js";

describe("daemon lifecycle with PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer;
  const opened: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(opened.map((database) => database.close()));
    await postgres.stop();
  }, 120_000);

  registerTurnEndScenarios(async () => {
    const url = new URL(postgres.getConnectionUri());
    url.pathname = `/turn_end_${randomUUID().replaceAll("-", "")}`;
    const database = await createDatabase(url.toString());
    opened.push(database);
    const organizationId = `org-${randomUUID()}`;
    const client = await createPostgresQueryRuntime(url.toString());
    await client.query("insert into organization (id, name, slug) values ($1, 'Turn end', $2)", [
      organizationId,
      organizationId,
    ]);
    await client.close();
    return { database, organizationId, eventLagMs: 60 };
  });
});
