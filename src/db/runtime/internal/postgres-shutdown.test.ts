import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
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

// Timers armed by other files in the same fork land on the fake clock, so a global timer
// count is not reliable. Track only the deadline that close() arms.
type Timer = NodeJS.Timeout;
let setTimeoutSpy: MockInstance<(handler: () => void, delay?: number) => Timer>;
let clearTimeoutSpy: MockInstance<(timer?: Timer) => void>;

function closeWithDeadline(runtime: { close(): Promise<void> }) {
  const before = setTimeoutSpy.mock.results.length;
  const closing = runtime.close();
  const deadlines: Timer[] = [];
  for (const result of setTimeoutSpy.mock.results.slice(before)) {
    if (result.type === "return") deadlines.push(result.value);
  }
  expect(deadlines).toHaveLength(1);
  return { closing, deadline: deadlines[0] };
}

describe("PostgreSQL shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    vi.clearAllMocks();
    mocks.createPool.mockReset();
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("abandons a stuck pool after three seconds and observes a late rejection", async () => {
    const { runtime, runtimePool } = await setup();
    const ending = Promise.withResolvers<void>();
    runtimePool.end.mockReturnValue(ending.promise);
    let closed = false;
    const started = closeWithDeadline(runtime);
    const closing = started.closing.then(() => {
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
    expect(clearTimeoutSpy).toHaveBeenCalledWith(started.deadline);
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
    const { closing, deadline } = closeWithDeadline(runtime);
    await closing;
    expect(runtimePool.end).toHaveBeenCalledOnce();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(deadline);
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
    const { closing, deadline } = closeWithDeadline(runtime);
    await expect(closing).rejects.toBe(error);
    expect(mocks.reportFailure).toHaveBeenCalledWith(error, {
      operation: "database.postgres.close",
      component: "database",
    });
    expect(clearTimeoutSpy).toHaveBeenCalledWith(deadline);
    expect(mocks.info).toHaveBeenLastCalledWith(
      { stage: "database.close", event: "end", elapsedMs: 0, outcome: "error" },
      "Database close finished",
    );
  });
});
