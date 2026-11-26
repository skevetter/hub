import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, vi } from "vitest";
import { embeddedDatabaseRuntime, TransactionRollback, type DatabaseRuntime } from "../index.js";
import { createPostgresRuntime } from "./postgres.js";

const createPool = vi.hoisted(() => vi.fn());
vi.mock("./pool.js", () => ({ createPool }));

async function assertRollbackResult(runtime: DatabaseRuntime): Promise<void> {
  const payload = { status: "cancelled" };
  const result = await runtime.transaction(async (transaction) => {
    try {
      transaction.rollback(payload);
    } catch (error) {
      assert.ok(error instanceof TransactionRollback);
      assert.ok(error instanceof Error);
      assert.equal(error.result, payload);
      throw error;
    }
  });
  assert.equal(result, payload);
}

it("returns the original rollback payload from a PostgreSQL transaction", async () => {
  const release = vi.fn();
  const client = { release };
  const runQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const pool = {
    runQuery,
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined),
    options: {},
  };
  createPool.mockReturnValue(pool);
  const { runtime } = await createPostgresRuntime("postgresql://127.0.0.1/test");
  await assertRollbackResult(runtime);
  expectQueries(runQuery.mock.calls, client);
  assert.equal(release.mock.calls.length, 1);
});

function expectQueries(calls: readonly unknown[], client: object): void {
  assert.deepEqual(calls, [
    [undefined, "select 1", []],
    [client, "begin", []],
    [client, "rollback", []],
  ]);
}

it("returns the original rollback payload from an embedded transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-transaction-rollback-"));
  try {
    const { runtime } = await embeddedDatabaseRuntime(directory);
    try {
      await assertRollbackResult(runtime);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
