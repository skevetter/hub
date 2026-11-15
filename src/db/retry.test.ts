import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DatabaseUnavailableError, isTransientDatabaseError } from "./errors.js";
import {
  DEFAULT_BACKOFF,
  RetryExhaustedError,
  retryDiagnostic,
  retryWithBackoff,
} from "./retry.js";

const poolTimeout = () => new Error("timeout exceeded when trying to connect");

/** A sleep that records its argument and returns at once. */
function fakeSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };
}

describe("retryWithBackoff", () => {
  it("returns the first success without waiting", async () => {
    const { delays, sleep } = fakeSleep();
    assert.equal(await retryWithBackoff(async () => "ok", { sleep }), "ok");
    assert.deepEqual(delays, []);
  });

  it("succeeds after transient failures and passes the attempt number", async () => {
    const { delays, sleep } = fakeSleep();
    const attempts: number[] = [];
    const result = await retryWithBackoff(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 3) throw poolTimeout();
        return "done";
      },
      { sleep, random: () => 0.5 },
    );
    assert.equal(result, "done");
    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(delays, [125, 250]);
  });

  it("gives up after six attempts and reports the attempt count once", async () => {
    const { delays, sleep } = fakeSleep();
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(
        async () => {
          calls++;
          throw poolTimeout();
        },
        { sleep, random: () => 0.999 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof RetryExhaustedError);
        assert.equal(error.attempts, 6);
        assert.match(error.message, /timeout exceeded when trying to connect/u);
        assert.match(error.message, /gave up after 6 attempts/u);
        assert.deepEqual(retryDiagnostic(error), { attempts: 6 });
        return true;
      },
    );
    assert.equal(calls, 6);
    assert.equal(delays.length, 5);
  });

  it("fails fast on an error that is not transient", async () => {
    const { delays, sleep } = fakeSleep();
    let calls = 0;
    const failure = new Error("duplicate key value violates unique constraint");
    await assert.rejects(
      retryWithBackoff(
        async () => {
          calls++;
          throw failure;
        },
        { sleep },
      ),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(retryDiagnostic(failure), {});
  });

  it("stops retrying when the failure changes to one that is not transient", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    const final = new Error("relation does not exist");
    await assert.rejects(
      retryWithBackoff(
        async () => {
          calls++;
          throw calls === 1 ? poolTimeout() : final;
        },
        { sleep },
      ),
      (error: unknown) => error === final,
    );
    assert.equal(calls, 2);
  });

  it("draws each wait from zero to the ceiling: 250, 500, 1000, 2000, 4000 ms", async () => {
    for (const [random, scale] of [
      [0, 0],
      [0.5, 0.5],
      [0.999999, 0.999999],
    ] as const) {
      const { delays, sleep } = fakeSleep();
      await assert.rejects(
        retryWithBackoff(
          async () => {
            throw poolTimeout();
          },
          { sleep, random: () => random },
        ),
      );
      const ceilings = [250, 500, 1000, 2000, 4000];
      assert.deepEqual(
        delays,
        ceilings.map((ceiling) => ceiling * scale),
      );
    }
  });

  it("never lets the ceiling pass the cap", async () => {
    const { delays, sleep } = fakeSleep();
    await assert.rejects(
      retryWithBackoff(
        async () => {
          throw poolTimeout();
        },
        {
          sleep,
          random: () => 1,
          policy: { baseMs: 250, factor: 2, capMs: 5_000, maxAttempts: 10 },
        },
      ),
    );
    assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);
    assert.equal(DEFAULT_BACKOFF.capMs, 5_000);
  });

  it("reports each retry before it waits", async () => {
    const { sleep } = fakeSleep();
    const seen: { attempt: number; delayMs: number }[] = [];
    await retryWithBackoff(
      async (attempt) => {
        if (attempt < 3) throw poolTimeout();
      },
      {
        sleep,
        random: () => 1,
        onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
      },
    );
    assert.deepEqual(seen, [
      { attempt: 1, delayMs: 250 },
      { attempt: 2, delayMs: 500 },
    ]);
  });

  it("does not call the real timer when sleep is injected", async () => {
    const started = performance.now();
    await retryWithBackoff(
      async (attempt) => {
        if (attempt < 6) throw poolTimeout();
      },
      { sleep: async () => {}, random: () => 1 },
    );
    assert.ok(performance.now() - started < 200);
  });

  it("honors a custom retryable check", async () => {
    const { sleep } = fakeSleep();
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(
        async () => {
          calls++;
          throw poolTimeout();
        },
        { sleep, isRetryable: () => false },
      ),
    );
    assert.equal(calls, 1);
  });
});

describe("isTransientDatabaseError", () => {
  const coded = (code: string, message = "failure") => Object.assign(new Error(message), { code });

  it("accepts a pool acquire timeout, a reset or terminated connection, serialization and deadlock", () => {
    for (const error of [
      poolTimeout(),
      new DatabaseUnavailableError("database query timed out"),
      new Error("Connection terminated unexpectedly"),
      new Error("Connection terminated due to connection timeout"),
      coded("ECONNRESET", "read ECONNRESET"),
      coded("57P01", "terminating connection due to administrator command"),
      coded("08006"),
      coded("40001", "could not serialize access due to concurrent update"),
      coded("40P01", "deadlock detected"),
    ]) {
      assert.equal(isTransientDatabaseError(error), true, error.message);
    }
  });

  it("finds the cause under a wrapper such as a query error", () => {
    const wrapped = new Error("Failed query", { cause: coded("40001") });
    assert.equal(isTransientDatabaseError(wrapped), true);
  });

  it("rejects errors that a retry cannot fix", () => {
    for (const error of [
      coded("23505", "duplicate key value violates unique constraint"),
      coded("42P01", "relation does not exist"),
      new Error("workflow trigger not found"),
      new TypeError("cannot read properties of undefined"),
    ]) {
      assert.equal(isTransientDatabaseError(error), false, error.message);
    }
    assert.equal(isTransientDatabaseError("timeout exceeded when trying to connect"), false);
    assert.equal(isTransientDatabaseError(undefined), false);
  });

  it("does not retry an error that already used its attempts", () => {
    assert.equal(isTransientDatabaseError(new RetryExhaustedError(6, poolTimeout())), false);
  });
});
