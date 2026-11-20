import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll } from "vitest";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { interactiveSessionStoreContract } from "./store.contract.js";

let container: StartedPostgreSqlContainer | undefined;
const organizations: string[] = [];
const outsideUsers: string[] = [];
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
  await root?.runtime.query("delete from organization where id = any($1::text[])", [
    organizations.splice(0),
  ]);
  await root?.runtime.query('delete from "user" where id = any($1::text[])', [
    outsideUsers.splice(0),
  ]);
});

interactiveSessionStoreContract("PostgreSQL", async ({ organizationId, users }) => {
  if (!root) throw new Error("PostgreSQL fixture is unavailable");
  organizations.push(organizationId);
  const { database, runtime } = root;
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
  return {
    database,
    async expireLease(command) {
      await runtime.query(
        "update interactive_session_commands set claim_expires_at = clock_timestamp() - interval '1 second' where organization_id = $1 and id = $2",
        [organizationId, command.id],
      );
    },
    async readAudit(sessionId) {
      const { rows } = await runtime.query<{
        action: string;
        actorIdentity: string;
        evidence: unknown;
      }>(
        'select action, actor_identity as "actorIdentity", evidence from audit_events where organization_id = $1 and subject_id = $2',
        [organizationId, sessionId],
      );
      return rows;
    },
    async insertEventForAnotherCommand(sessionId, commandId) {
      await runtime.query(
        "insert into interactive_session_events (session_id, organization_id, seq, kind, command_id, data, at) values ($1,$2,99,'message',$3,'{\"ordinal\":1}',now())",
        [sessionId, organizationId, commandId],
      );
    },
    async insertParticipantOutsideOrganization(sessionId) {
      const userId = randomUUID();
      outsideUsers.push(userId);
      await runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
        userId,
        userId + "@example.test",
      ]);
      await runtime.query(
        "insert into interactive_session_participants (session_id, organization_id, user_id, role) values ($1,$2,$3,'viewer')",
        [sessionId, organizationId, userId],
      );
    },
    async raceProfileSaveWithRevocation(input) {
      let saving: ReturnType<typeof database.saveSessionProfile> | undefined;
      try {
        await runtime.transaction(async (blocker) => {
          await blocker.query(
            "select id from interactive_session_profiles where organization_id = $1 and id = $2 for update",
            [organizationId, input.id],
          );
          const {
            rows: [holder],
          } = await blocker.query<{ pid: number }>("select pg_backend_pid() as pid");
          saving = database.saveSessionProfile(input);
          const deadline = performance.now() + 2_000;
          while (true) {
            const {
              rows: [waiter],
            } = await runtime.query<{ blocked: boolean }>(
              "select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as blocked",
              [holder!.pid],
            );
            if (waiter!.blocked) break;
            assert.ok(performance.now() < deadline, "profile save did not wait for its row");
            await delay(5);
          }
          assert.ok(await database.revokeDaemon(input.daemonId));
        });
      } finally {
        await saving?.catch(() => undefined);
      }
      assert.ok(saving);
      return saving;
    },
  };
});
