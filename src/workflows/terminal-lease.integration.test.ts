import assert from "node:assert/strict";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import {
  seedTerminalNotification,
  TERMINAL_TEST_ORG,
} from "../db/test-utils/terminal-notification.js";
import { DurableWorkflowEngine } from "./engine.js";

const LEASE_MS = 300;

describe("Postgres terminal notification lease", () => {
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

  it("delivers once when renewals fail past the lease and a late renewal succeeds", async () => {
    const { database } = store;
    const runId = await seedTerminalNotification(database, new Date());
    const failUntil = Date.now() + LEASE_MS * 1.5;
    const real = database.renewWorkflowRunTerminalNotification.bind(database);
    const renew = vi.spyOn(database, "renewWorkflowRunTerminalNotification");
    const lateRenewal = Promise.withResolvers<boolean>();
    renew.mockImplementation(async (...args) => {
      if (Date.now() < failUntil) throw new Error("database blip");
      const renewed = await real(...args);
      lateRenewal.resolve(renewed);
      return renewed;
    });
    const handler = vi.fn(async () => {
      await lateRenewal.promise;
    });
    const engine = new DurableWorkflowEngine({
      database,
      entitlements: null,
      leaseMs: LEASE_MS,
      onWorkflowRunTerminal: handler,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    let delivered: Awaited<ReturnType<typeof database.findTriggerRunById>>;
    try {
      await engine.processAvailable();
      assert.equal(await lateRenewal.promise, true);
      delivered = await vi.waitFor(
        async () => {
          const run = await database.findTriggerRunById(runId);
          assert.ok(run?.outcome === "accepted" && run.terminalNotificationDeliveredAt !== null);
          return run;
        },
        { timeout: 5_000, interval: 25 },
      );
    } finally {
      renew.mockRestore();
      await engine.stop();
    }

    assert.equal(handler.mock.calls.length, 1);
    assert.equal(delivered?.outcome === "accepted" && delivered.terminalNotificationGeneration, 1);
    assert.equal(
      await database.claimPendingWorkflowRunTerminalNotification(new Date(), LEASE_MS),
      undefined,
    );
  });
});
