import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { readDatabasePoolOptions } from "./pool-options.js";
import { createPool } from "./pool.js";

describe("database pool options", () => {
  it("keeps today's values when nothing is set", () => {
    assert.deepEqual(readDatabasePoolOptions({}), { max: 10, acquireTimeoutMs: 3_000 });
    assert.deepEqual(
      readDatabasePoolOptions({
        PASEO_HUB_DATABASE_POOL_MAX: " ",
        PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS: "",
      }),
      { max: 10, acquireTimeoutMs: 3_000 },
    );
  });

  it("reads both values and accepts the bounds", () => {
    assert.deepEqual(
      readDatabasePoolOptions({
        PASEO_HUB_DATABASE_POOL_MAX: "25",
        PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS: "15000",
      }),
      { max: 25, acquireTimeoutMs: 15_000 },
    );
    assert.equal(readDatabasePoolOptions({ PASEO_HUB_DATABASE_POOL_MAX: "1" }).max, 1);
    assert.equal(readDatabasePoolOptions({ PASEO_HUB_DATABASE_POOL_MAX: "100" }).max, 100);
    assert.equal(
      readDatabasePoolOptions({ PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS: "1000" }).acquireTimeoutMs,
      1_000,
    );
    assert.equal(
      readDatabasePoolOptions({ PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS: "60000" }).acquireTimeoutMs,
      60_000,
    );
  });

  it("fails with the variable name, the range and the value", () => {
    for (const [name, value, range] of [
      ["PASEO_HUB_DATABASE_POOL_MAX", "0", "1 to 100"],
      ["PASEO_HUB_DATABASE_POOL_MAX", "101", "1 to 100"],
      ["PASEO_HUB_DATABASE_POOL_MAX", "ten", "1 to 100"],
      ["PASEO_HUB_DATABASE_POOL_MAX", "2.5", "1 to 100"],
      ["PASEO_HUB_DATABASE_POOL_MAX", "-3", "1 to 100"],
      ["PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS", "999", "1000 to 60000"],
      ["PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS", "60001", "1000 to 60000"],
      ["PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS", "3s", "1000 to 60000"],
    ] as const) {
      assert.throws(
        () => readDatabasePoolOptions({ [name]: value }),
        new Error(`${name} must be a whole number from ${range}, got "${value}".`),
      );
    }
  });
});

describe("createPool", () => {
  const url = "postgresql://unused:unused@127.0.0.1:1/unused";

  it("keeps today's pool size and deadlines by default", async () => {
    const pool = createPool(url);
    assert.equal(pool.options.max, 10);
    assert.equal(pool.options.connectionTimeoutMillis, 3_000);
    assert.equal(pool.options.query_timeout, 3_000);
    assert.equal(pool.options.statement_timeout, 3_000);
    await pool.end();
  });

  it("applies the pool size and acquire timeout without touching the query deadlines", async () => {
    const pool = createPool(url, { max: 40, acquireTimeoutMs: 20_000 });
    assert.equal(pool.options.max, 40);
    assert.equal(pool.options.connectionTimeoutMillis, 20_000);
    assert.equal(pool.options.query_timeout, 3_000);
    assert.equal(pool.options.statement_timeout, 3_000);
    await pool.end();
  });
});
