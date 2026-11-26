import { isTransientDatabaseError } from "./errors.js";

export interface BackoffPolicy {
  /** Delay ceiling before the second attempt. */
  baseMs: number;
  /** The ceiling grows by this factor after each failed attempt. */
  factor: number;
  /** The ceiling never grows past this. */
  capMs: number;
  /** Total attempts, including the first. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 250,
  factor: 2,
  capMs: 5_000,
  maxAttempts: 6,
};

export interface RetryOptions {
  policy?: BackoffPolicy;
  /** Decides whether a failure may be tried again. Defaults to transient database errors. */
  isRetryable?: (error: unknown) => boolean;
  /** Injected in tests so no real time passes. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injected in tests. Must return a number from 0 up to, not including, 1. */
  random?: () => number;
  /** Called before each wait, with the attempt that just failed. */
  onRetry?: (retry: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** What a caller passes to make retries deterministic. */
export type RetryRuntime = Pick<RetryOptions, "policy" | "sleep" | "random">;

/** The last failure after every attempt was used. `cause` is that failure. */
export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${reason} (gave up after ${String(attempts)} attempts)`, { cause });
    this.name = "RetryExhaustedError";
  }
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * Runs `operation` again after a retryable failure, waiting a random time between zero and an
 * exponentially growing ceiling (full jitter) so many callers that failed together do not come
 * back together. The operation receives its attempt number, starting at 1. A failure that is not
 * retryable is thrown as it is, at once. When the attempts run out the last failure is thrown as
 * a `RetryExhaustedError`.
 *
 * The caller owns idempotency: only wrap work that is safe to run again.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { policy, isRetryable, sleep, random } = resolveRetryOptions(options);
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      if (attempt >= policy.maxAttempts) throw new RetryExhaustedError(attempt, error);
      const ceiling = Math.min(policy.capMs, policy.baseMs * policy.factor ** (attempt - 1));
      const delayMs = random() * ceiling;
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

function resolveRetryOptions(options: RetryOptions) {
  return {
    policy: options.policy ?? DEFAULT_BACKOFF,
    isRetryable: options.isRetryable ?? isTransientDatabaseError,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
  };
}

/** The attempt count to add to a failure report, when the failure used up its retries. */
export function retryDiagnostic(error: unknown): { attempts: number } | Record<string, never> {
  return error instanceof RetryExhaustedError ? { attempts: error.attempts } : {};
}
