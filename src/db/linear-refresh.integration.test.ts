import assert from "node:assert/strict";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, it, vi } from "vitest";
import { resolveLinearPilotInstallation } from "../linear-pilot/installation.js";
import { createLinearAgentClient, LinearAgentError } from "../providers/linear/agent.js";
import { createLinearConnectionClient } from "../providers/linear/client.js";
import { appViewer, linearAgentBinding } from "../providers/linear/test-utils/agent.js";
import { prepareProfile } from "../surfaces/store.contract.js";
import { createDatabase } from "./pg.js";
import { postgresDatabaseRuntime } from "./runtime/index.js";
import type { DatabaseRuntimeBundle, QueryHandle, TransactionHandle } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";
import type { Database } from "./types.js";

const START_ACCESS = {
  sessionId: "session",
  userId: "operator",
  membershipId: "member",
  organizationId: "00000000-0000-4000-8000-000000000001",
  returnRoute: "/",
} as const;
const CALLBACK_ACCESS = { sessionId: "session", userId: "operator" };
const LINEAR_ORGANIZATION_ID = "linear-organization";
const LINEAR_EXTERNAL_LOCK_KEY = JSON.stringify([
  "paseo-connection",
  "linear",
  "external",
  LINEAR_ORGANIZATION_ID,
]);

describe("Linear token refresh persistence", () => {
  it("serializes an expired refresh with OAuth rebind on the canonical transaction lock", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const bundle = await postgresDatabaseRuntime(postgres.getConnectionUri());
    try {
      await seedAuthority(bundle);
      let sessionLockCalls = 0;
      let captureExternalLocks = false;
      const externalLockKeys: string[] = [];
      let markSecondExternalLock!: () => void;
      const secondExternalLock = new Promise<void>((resolve) => {
        markSecondExternalLock = resolve;
      });
      const locks: Locks = {
        tryTxLock: (transaction, key) => bundle.locks.tryTxLock(transaction, key),
        withLock: async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
          sessionLockCalls += 1;
          return bundle.locks.withLock(key, operation);
        },
        withTxLock: async (transaction: TransactionHandle, key: string): Promise<void> => {
          if (captureExternalLocks && key === LINEAR_EXTERNAL_LOCK_KEY) {
            externalLockKeys.push(key);
            if (externalLockKeys.length === 2) markSecondExternalLock();
          }
          await bundle.locks.withTxLock(transaction, key);
        },
      };
      // Separate database facades model independent Hub processes. Their only coordination is
      // the PostgreSQL transaction lock, not the client-local refresh promise map.
      const refreshDatabase = createDatabase(bundle.runtime, locks);
      const rebindDatabase = createDatabase(bundle.runtime, locks);

      await startLinearAttempt(rebindDatabase, "initial");
      await bindLinearConnection(rebindDatabase, "initial", {
        accessToken: "expired-access-token",
        refreshToken: "old-rotating-refresh-token",
        accessTokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      });
      await startLinearAttempt(rebindDatabase, "rebind");

      let releaseRefresh!: () => void;
      let markRefreshEntered!: () => void;
      const refreshEntered = new Promise<void>((resolve) => {
        markRefreshEntered = resolve;
      });
      const refreshReleased = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      captureExternalLocks = true;
      const refresh = refreshDatabase.withLinearConnectionRefresh(
        LINEAR_ORGANIZATION_ID,
        async (connection, updateTokens) => {
          assert.equal(connection?.accessToken, "expired-access-token");
          markRefreshEntered();
          await refreshReleased;
          await updateTokens({
            accessToken: "refreshed-access-token",
            refreshToken: "next-rotating-refresh-token",
            accessTokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
          });
        },
      );
      await refreshEntered;
      const rebind = bindLinearConnection(rebindDatabase, "rebind", {
        accessToken: "rebound-access-token",
        refreshToken: "rebound-refresh-token",
        accessTokenExpiresAt: new Date("2031-01-01T00:00:00.000Z"),
      });
      try {
        await settlesWithin(
          secondExternalLock,
          3_000,
          "OAuth rebind did not reach the Linear external-connection lock",
        );
      } finally {
        releaseRefresh();
        await Promise.all([refresh, rebind]);
      }

      assert.deepEqual(externalLockKeys, [LINEAR_EXTERNAL_LOCK_KEY, LINEAR_EXTERNAL_LOCK_KEY]);
      assert.equal(sessionLockCalls, 0);
      const connection = await rebindDatabase.findLinearConnection(LINEAR_ORGANIZATION_ID);
      assert.equal(connection?.accessToken, "rebound-access-token");
      assert.equal(connection?.refreshToken, "rebound-refresh-token");
      assert.deepEqual(connection?.accessTokenExpiresAt, new Date("2031-01-01T00:00:00.000Z"));
    } finally {
      await bundle.runtime.close();
      await postgres.stop();
    }
  }, 120_000);

  it("refuses pilot OAuth refresh after owner demotion while waiting for the workspace lock", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const bundle = await postgresDatabaseRuntime(postgres.getConnectionUri());
    const waiter = await postgresDatabaseRuntime(postgres.getConnectionUri(), { max: 1 });
    try {
      await seedAuthority(bundle);
      const database = createDatabase(bundle.runtime, bundle.locks);
      const expired = {
        accessToken: "expired-access-token",
        refreshToken: "old-rotating-refresh-token",
        accessTokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      };
      await startLinearAttempt(database, "pilot-initial");
      await bindLinearConnection(database, "pilot-initial", expired, [
        "read",
        "write",
        "comments:create",
        "app:assignable",
        "app:mentionable",
      ]);
      const connection = await database.findLinearConnection(LINEAR_ORGANIZATION_ID);
      assert.ok(connection);
      await waiter.runtime.query("set default_transaction_isolation = 'repeatable read'");
      const ordinaryDatabase = createDatabase(waiter.runtime, waiter.locks);
      await ordinaryDatabase.withLinearConnectionRefresh(
        LINEAR_ORGANIZATION_ID,
        async (_connection, _update, query) => {
          assert.ok(query);
          const { rows } = await query.query<{ transaction_isolation: string }>(
            "show transaction_isolation",
          );
          assert.equal(rows[0]?.transaction_isolation, "repeatable read");
        },
      );
      const { profile } = await prepareProfile(database, {
        organizationId: START_ACCESS.organizationId,
        userId: START_ACCESS.userId,
        connection,
      });
      const config = {
        hubOrganizationId: START_ACCESS.organizationId,
        linearOrganizationId: LINEAR_ORGANIZATION_ID,
        allowedHumanId: "synthetic-linear-owner",
        profileId: profile.id,
      };
      const authorize = async (query: QueryHandle) => {
        const installation = await resolveLinearPilotInstallation(query, config, "linear-app");
        return (
          installation?.connectionId === connection.id &&
          installation.appUserId === connection.appUserId &&
          installation.ownerUserId === START_ACCESS.userId &&
          installation.profileVersion === profile.version
        );
      };
      const blockedBackend = Promise.withResolvers<number>();
      const waiterDatabase = createDatabase(waiter.runtime, {
        withLock: (key, run) => waiter.locks.withLock(key, run),
        tryTxLock: (transaction, key) => waiter.locks.tryTxLock(transaction, key),
        async withTxLock(transaction, key) {
          assert.equal(key, LINEAR_EXTERNAL_LOCK_KEY);
          blockedBackend.resolve(await backendPid(transaction));
          await waiter.locks.withTxLock(transaction, key);
        },
      });
      const refresh = vi.fn(async () => ({
        accessToken: "synthetic-rotated-access-token",
        refreshToken: "synthetic-rotated-refresh-token",
        accessTokenExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
      }));
      const graphql = vi.fn<typeof fetch>(async () =>
        Response.json({ data: { viewer: appViewer(connection) } }),
      );
      const authorityBackend = vi.fn(async (query: QueryHandle) => {
        assert.equal(await backendPid(query), await blockedBackend.promise);
        return authorize(query);
      });
      const hubBaseUrl = "https://hub.example.test";
      const options = {
        binding: linearAgentBinding(connection),
        hubBaseUrl,
        pilotOperations: true as const,
        authorize: () => authorize(waiter.runtime),
        authorizeRefresh: authorityBackend,
        connectionForLinearOrganization: waiterDatabase.findLinearConnection.bind(waiterDatabase),
        withLinearConnectionRefresh:
          waiterDatabase.withLinearConnectionRefresh.bind(waiterDatabase),
        connectionClient: {
          ...createLinearConnectionClient({
            clientId: "linear-app",
            clientSecret: "synthetic-secret",
            publicBaseUrl: hubBaseUrl,
            fetch: graphql,
          }),
          refresh,
        },
        fetch: graphql,
      };
      const client = createLinearAgentClient(options);
      const locked = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const holder = bundle.runtime.transaction(async (transaction) => {
        await bundle.locks.withTxLock(transaction, LINEAR_EXTERNAL_LOCK_KEY);
        const { rowCount } = await transaction.query(
          "select id from linear_connections where id = $1 for update",
          [connection.id],
        );
        assert.equal(rowCount, 1);
        locked.resolve(await backendPid(transaction));
        await release.promise;
      });
      let outcome: Promise<unknown> | undefined;
      try {
        const holderPid = await settlesWithin(locked.promise, 2_000, "refresh holder never locked");
        outcome = client.readAppViewer().then(
          () => undefined,
          (error: unknown) => error,
        );
        const waiterPid = await settlesWithin(
          blockedBackend.promise,
          2_000,
          "refresh waiter never reached the lock",
        );
        await vi.waitFor(
          async () => {
            const {
              rows: [row],
            } = await bundle.runtime.query<{ blocked: boolean }>(
              "select $1 = any(pg_blocking_pids($2)) as blocked",
              [holderPid, waiterPid],
            );
            assert.equal(row?.blocked, true, "refresh waiter is not blocked by the holder");
          },
          { timeout: 2_000, interval: 10 },
        );
        const demoted = await bundle.runtime.query(
          "update member set role = 'member' where id = $1 and role = 'owner'",
          [START_ACCESS.membershipId],
        );
        assert.equal(demoted.rowCount, 1);
        release.resolve();
        await holder;
        const error = await outcome;
        assert.ok(error instanceof LinearAgentError);
        assert.equal(error.code, "policy_required");
        assert.equal(
          refresh.mock.calls.length,
          0,
          "queued refresh called OAuth after owner demotion",
        );
        assert.equal(graphql.mock.calls.length, 0);
        const stored = await database.findLinearConnection(LINEAR_ORGANIZATION_ID);
        assert.equal(stored?.accessToken, expired.accessToken);
        assert.equal(stored?.refreshToken, expired.refreshToken);
        assert.deepEqual(stored?.accessTokenExpiresAt, expired.accessTokenExpiresAt);
        assert.equal(authorityBackend.mock.calls.length, 1);

        const restored = await bundle.runtime.query(
          "update member set role = 'owner' where id = $1 and role = 'member'",
          [START_ACCESS.membershipId],
        );
        assert.equal(restored.rowCount, 1);
        await client.readAppViewer();
        assert.equal(authorityBackend.mock.calls.length, 2);
        assert.equal(refresh.mock.calls.length, 1);
        assert.equal(graphql.mock.calls.length, 1);
      } finally {
        release.resolve();
        await Promise.allSettled([holder, outcome]);
      }
    } finally {
      await waiter.runtime.close();
      await bundle.runtime.close();
      await postgres.stop();
    }
  }, 120_000);
});

async function startLinearAttempt(database: Database, stateVerifier: string): Promise<void> {
  await database.startConnectionAttempt({
    provider: "linear",
    stateVerifier,
    access: START_ACCESS,
    lifetimeMinutes: 10,
    configurationVersion: 0,
    providerApplicationId: "linear-app",
    callbackOrigin: "https://hub.example.test",
    configurationSnapshot: { provider: "linear" },
    expectedConfigurationVersion: null,
    activateConfiguration: false,
  });
}

function bindLinearConnection(
  database: Database,
  stateVerifier: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: Date;
  },
  scopes = ["read", "comments:create"],
): Promise<void> {
  return database.bindLinearConnection({
    stateVerifier,
    phase: "linear_authorization",
    access: CALLBACK_ACCESS,
    providerApplicationId: "linear-app",
    linearOrganizationId: LINEAR_ORGANIZATION_ID,
    linearOrganizationName: "Acme",
    appUserId: "linear-app-user",
    ...tokens,
    scopes,
  });
}

async function seedAuthority(bundle: DatabaseRuntimeBundle): Promise<void> {
  await bundle.runtime.migrate();
  await bundle.runtime.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                         must_change_password, is_instance_operator)
     values ('operator', 'Operator', 'operator@example.test', true, now(), now(), false, true)`,
  );
  await bundle.runtime.query(
    `insert into organization (id, name, slug) values ($1, 'Org', 'org')`,
    [START_ACCESS.organizationId],
  );
  await bundle.runtime.query(
    `insert into session (id, token, user_id, active_organization_id, expires_at)
     values ('session', 'token', 'operator', $1, now() + interval '1 hour')`,
    [START_ACCESS.organizationId],
  );
  await bundle.runtime.query(
    `insert into member (id, organization_id, user_id, role)
     values ('member', $1, 'operator', 'owner')`,
    [START_ACCESS.organizationId],
  );
  await bundle.runtime.query(
    `insert into runtime_provider_activation (provider, provider_application_id, configuration_version)
     values ('linear', 'linear-app', 0)`,
  );
}

async function backendPid(query: QueryHandle): Promise<number> {
  const {
    rows: [row],
  } = await query.query<{ pid: number }>("select pg_backend_pid() as pid");
  assert.ok(row);
  return row.pid;
}

async function settlesWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
