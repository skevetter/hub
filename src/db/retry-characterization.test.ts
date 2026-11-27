import { expect, it } from "vitest";
import { RetryExhaustedError, retryWithBackoff } from "./retry.js";

const failure = new Error("busy");

it("reports full jitter before waiting and stops when a retry succeeds", async () => {
  const trace: unknown[] = [];
  const result = await retryWithBackoff(
    async (attempt) => {
      trace.push(attempt);
      if (attempt < 3) throw failure;
      return "ok";
    },
    {
      policy: { baseMs: 10, factor: 3, capMs: 20, maxAttempts: 4 },
      random: () => 0.25,
      isRetryable: () => true,
      onRetry: (retry) => trace.push(retry),
      sleep: async (delay) => {
        trace.push(delay);
      },
    },
  );
  expect(result).toBe("ok");
  expect(trace).toEqual([
    1,
    { attempt: 1, delayMs: 2.5, error: failure },
    2.5,
    2,
    { attempt: 2, delayMs: 5, error: failure },
    5,
    3,
  ]);
  expect(JSON.stringify(trace[1])).toBe('{"attempt":1,"delayMs":2.5,"error":{}}');
});

it("does not wait on non-retryable or exhausted failures", async () => {
  const sleep = async () => {
    throw new Error("unexpected wait");
  };
  const operation = async () => {
    throw failure;
  };
  await expect(retryWithBackoff(operation, { sleep })).rejects.toBe(failure);
  await expect(
    retryWithBackoff(operation, {
      isRetryable: () => true,
      policy: { baseMs: 10, factor: 2, capMs: 20, maxAttempts: 1 },
      sleep,
    }),
  ).rejects.toThrow("busy (gave up after 1 attempts)");
  expect(new RetryExhaustedError(1, failure).cause).toBe(failure);
});
