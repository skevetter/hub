import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_REVOKE_WATCHDOG_MS } from "../auth/revocation-budget.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createExecutionAuthority, type ExecutionAuthorityClock } from "./index.js";

// A different test-only deadline exposes a hardcoded 10 s watchdog.
vi.mock("../auth/revocation-budget.js", () => ({ TOKEN_REVOKE_WATCHDOG_MS: 12_000 }));

class TestClock implements ExecutionAuthorityClock {
  now(): number {
    return Date.now();
  }

  schedule = vi.fn((callback: () => Promise<void>, delayMs: number) => {
    const timer = setTimeout(() => void callback(), delayMs);
    return () => clearTimeout(timer);
  });
}

async function startRevocation() {
  const executionId = "watchdog";
  const clock = new TestClock();
  const database = createMemoryDatabase();
  const store = database.executionAuthority;
  const logger = { error: vi.fn(), warn: vi.fn() };
  const provider = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const revoke = vi.fn(() => {
    started.resolve();
    return provider.promise;
  });
  const authority = createExecutionAuthority({
    database,
    clock,
    logger,
    isExecutionActive: async () => true,
    connectionsForProject: () => async () => "unused",
    githubAuthority: {
      mint: async () => ({
        token: "watchdog-test-token",
        expiresAt: clock.now() + 60_000,
        botUserId: 1,
        botLogin: "paseo[bot]",
      }),
      revoke,
    },
  });
  await authority.materialize({
    executionId,
    projectId: "project-1",
    triggerContext: { provider: "manual" },
    github: {
      connection: "github",
      repositories: ["getpaseo/paseo"],
      permissions: { contents: "read" },
      durationMs: 60_000,
    },
  });
  clock.schedule.mockClear();
  const terminal = authority.onExecutionTerminal(executionId);
  await started.promise;
  return { clock, store, revocation: { logger, provider, revoke, terminal } };
}

describe("execution authority revoke watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps waiting past the old 10 s cutoff when the watchdog allows it", async () => {
    const { clock, store, revocation } = await startRevocation();
    const { logger, provider, terminal } = revocation;

    await vi.advanceTimersByTimeAsync(10_500);
    provider.resolve();
    await terminal;

    expect(logger.error).not.toHaveBeenCalled();
    expect(clock.schedule).not.toHaveBeenCalled();
    expect(await store.leases()).toEqual([]);
  });

  it("reports a timeout and schedules exactly one durable retry at the watchdog", async () => {
    const { clock, store, revocation } = await startRevocation();
    const { logger, provider, revoke, terminal } = revocation;

    await vi.advanceTimersByTimeAsync(TOKEN_REVOKE_WATCHDOG_MS - 1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(clock.schedule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await terminal;
    provider.resolve();

    expect(logger.error.mock.calls).toMatchObject([
      [
        {
          operation: "execution-authority.token.revoke",
          failureKind: "upstreamUnavailable",
          err: { message: "token revocation timed out" },
          diagnostic: { attempt: 1 },
        },
        "execution-authority.token.revoke failed",
      ],
    ]);
    expect(await store.leases()).toMatchObject([
      { revoking: true, attempts: 1, nextAttemptAt: clock.now() + 1_000 },
    ]);
    expect(clock.schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(clock.schedule).toHaveBeenCalledTimes(1);
    expect(await store.leases()).toEqual([]);
  });
});
