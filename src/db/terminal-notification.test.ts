import assert from "node:assert/strict";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { createPostgresTestRuntime } from "./test-utils/runtime.js";
import {
  seedTerminalNotification,
  TERMINAL_LEASE_MS,
  TERMINAL_TEST_ORG,
} from "./test-utils/terminal-notification.js";
import type { Database } from "./types.js";

const NOW = new Date();
const at = (offset: number) => new Date(NOW.getTime() + offset);

async function claim(database: Database) {
  const id = await seedTerminalNotification(database, NOW);
  const claimed = await database.claimPendingWorkflowRunTerminalNotification(
    NOW,
    TERMINAL_LEASE_MS,
  );
  assert.equal(claimed?.id, id);
  return { id, generation: claimed.terminalNotificationGeneration };
}

function renewalTests(getDatabase: () => Database) {
  it("extends a claim beyond its original expiry without changing generation", async () => {
    const database = getDatabase();
    const { id, generation } = await claim(database);
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation,
        at(10_000),
        TERMINAL_LEASE_MS,
      ),
      true,
    );
    assert.equal(
      await database.claimPendingWorkflowRunTerminalNotification(at(30_000), TERMINAL_LEASE_MS),
      undefined,
    );
    assert.equal(
      await database.ownsWorkflowRunTerminalNotification(id, generation, at(39_999)),
      true,
    );
    await database.markWorkflowRunTerminalNotificationDelivered(id, generation, at(39_999), null);
  });

  it("refuses a stale generation and leaves the lease unchanged", async () => {
    const database = getDatabase();
    const { id, generation } = await claim(database);
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation - 1,
        at(10_000),
        TERMINAL_LEASE_MS,
      ),
      false,
    );
    const replay = await database.claimPendingWorkflowRunTerminalNotification(
      at(30_000),
      TERMINAL_LEASE_MS,
    );
    assert.equal(replay?.id, id);
    assert.equal(replay.terminalNotificationGeneration, generation + 1);
    await database.markWorkflowRunTerminalNotificationDelivered(
      id,
      generation + 1,
      at(30_000),
      null,
    );
  });

  it("renews after expiry while nobody re-claimed, keeping the generation", async () => {
    const database = getDatabase();
    const { id, generation } = await claim(database);
    for (const offset of [30_000, 45_000]) {
      assert.equal(
        await database.renewWorkflowRunTerminalNotification(
          id,
          generation,
          at(offset),
          TERMINAL_LEASE_MS,
        ),
        true,
      );
    }
    assert.equal(
      await database.claimPendingWorkflowRunTerminalNotification(at(74_999), TERMINAL_LEASE_MS),
      undefined,
    );
    await database.markWorkflowRunTerminalNotificationDelivered(id, generation, at(60_000), null);
    assert.equal(
      await database.claimPendingWorkflowRunTerminalNotification(at(200_000), TERMINAL_LEASE_MS),
      undefined,
    );
  });

  it("fences out the old holder once an expired lease is re-claimed", async () => {
    const database = getDatabase();
    const { id, generation } = await claim(database);
    const replay = await database.claimPendingWorkflowRunTerminalNotification(
      at(30_000),
      TERMINAL_LEASE_MS,
    );
    assert.equal(replay?.terminalNotificationGeneration, generation + 1);
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation,
        at(31_000),
        TERMINAL_LEASE_MS,
      ),
      false,
    );
    await database.markWorkflowRunTerminalNotificationDelivered(id, generation, at(31_000), null);
    assert.equal(
      await database.ownsWorkflowRunTerminalNotification(id, generation + 1, at(31_000)),
      true,
    );
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation + 1,
        at(31_000),
        TERMINAL_LEASE_MS,
      ),
      true,
    );
    await database.markWorkflowRunTerminalNotificationDelivered(
      id,
      generation + 1,
      at(32_000),
      null,
    );
    assert.equal(
      await database.claimPendingWorkflowRunTerminalNotification(at(200_000), TERMINAL_LEASE_MS),
      undefined,
    );
  });

  it("refuses renewal after delivery or payload expiry", async () => {
    const database = getDatabase();
    const { id, generation } = await claim(database);
    await database.markWorkflowRunTerminalNotificationDelivered(id, generation, at(1_000), null);
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation,
        at(2_000),
        TERMINAL_LEASE_MS,
      ),
      false,
    );
    assert.equal(await database.expireRunPayloadChunk(id, at(60_000), at(60_000)), "expiring");
    assert.equal(await database.expireRunPayloadChunk(id, at(60_000), at(60_000)), "expiring");
    assert.equal(await database.expireRunPayloadChunk(id, at(60_000), at(60_000)), "expired");
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation,
        at(60_000),
        TERMINAL_LEASE_MS,
      ),
      false,
    );
  });
}

describe("memory terminal notification renewal", () => {
  renewalTests(() =>
    createMemoryDatabase({ organizationIds: [TERMINAL_TEST_ORG], now: () => NOW }),
  );
});

describe("Postgres terminal notification renewal", () => {
  let postgres: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
  let store: Awaited<ReturnType<typeof createPostgresTestRuntime>>;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    store = await createPostgresTestRuntime(postgres.getConnectionUri());
    await store.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
      TERMINAL_TEST_ORG,
    ]);
  }, 120_000);
  afterAll(async () => {
    await store?.runtime.close();
    await postgres?.stop();
  }, 120_000);

  renewalTests(() => store.database);

  it("checks delivery and payload expiry even when the lease is active", async () => {
    const { database, runtime } = store;
    const { id, generation } = await claim(database);
    await runtime.query(
      `update trigger_runs set payload_expiry_state = 'expiring',
         payload_expired_at = $2, payload_summary = '{}' where id = $1`,
      [id, at(1_000)],
    );
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation,
        at(1_000),
        TERMINAL_LEASE_MS,
      ),
      false,
    );
    await runtime.query(
      `update trigger_runs set payload_expiry_state = null, payload_expired_at = null,
         payload_summary = null, terminal_notification_delivered_at = $2 where id = $1`,
      [id, at(1_000)],
    );
    assert.equal(
      await database.renewWorkflowRunTerminalNotification(
        id,
        generation,
        at(2_000),
        TERMINAL_LEASE_MS,
      ),
      false,
    );
  });
});
