import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresRuntime } from "./postgres.js";
import type * as PoolModule from "./pool.js";
import type * as LoggerModule from "../../../logger.js";
import type * as FailuresModule from "../../../failures/index.js";

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  info: vi.fn(),
  reportFailure: vi.fn(),
}));

vi.mock("./pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PoolModule>()),
  createPool: mocks.createPool,
}));
vi.mock("../../../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LoggerModule>()),
  logger: { info: mocks.info },
}));
vi.mock("../../../failures/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof FailuresModule>()),
  reportFailure: mocks.reportFailure,
}));

function pool() {
  return {
    runQuery: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    options: {},
  };
}

async function setup() {
  const runtimePool = pool();
  mocks.createPool.mockReturnValueOnce(pool()).mockReturnValueOnce(runtimePool);
  const { runtime } = await createPostgresRuntime("postgresql://unused:unused@127.0.0.1:1/unused");
  return { runtime, runtimePool };
}

describe("PostgreSQL shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.createPool.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("abandons a stuck pool after three seconds and observes a late rejection", async () => {
    const { runtime, runtimePool } = await setup();
    const ending = Promise.withResolvers<void>();
    runtimePool.end.mockReturnValue(ending.promise);
    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
      return undefined;
    });
    expect(mocks.info).toHaveBeenCalledWith(
      { stage: "database.close", event: "start", elapsedMs: 0 },
      "Database close started",
    );
    await vi.advanceTimersByTimeAsync(2999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(runtimePool.end).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenLastCalledWith(
      { stage: "database.close", event: "end", elapsedMs: 3000, outcome: "deadline" },
      "Database close finished",
    );
    expect(mocks.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "PostgreSQL pool close exceeded the shutdown deadline" }),
      { operation: "database.postgres.close", component: "database" },
    );
    expect(vi.getTimerCount()).toBe(0);
    const lateError = new Error("late close failure");
    ending.reject(lateError);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.reportFailure).toHaveBeenCalledTimes(2);
    expect(mocks.reportFailure).toHaveBeenLastCalledWith(lateError, {
      operation: "database.postgres.close",
      component: "database",
    });
  });

  it("clears the deadline when the pool closes normally", async () => {
    const { runtime, runtimePool } = await setup();
    await runtime.close();
    expect(runtimePool.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.reportFailure).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenLastCalledWith(
      { stage: "database.close", event: "end", elapsedMs: 0, outcome: "closed" },
      "Database close finished",
    );
  });

  it("logs and propagates pool close errors and clears the timer", async () => {
    const { runtime, runtimePool } = await setup();
    const error = new Error("pool close failed");
    runtimePool.end.mockRejectedValue(error);
    await expect(runtime.close()).rejects.toBe(error);
    expect(mocks.reportFailure).toHaveBeenCalledWith(error, {
      operation: "database.postgres.close",
      component: "database",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.info).toHaveBeenLastCalledWith(
      { stage: "database.close", event: "end", elapsedMs: 0, outcome: "error" },
      "Database close finished",
    );
  });
});
