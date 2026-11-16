import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { WebhookRateLimiter } from "./rate-limit.js";

describe("webhook rate limiter", () => {
  it("allows the burst and caps refills at the burst", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 60, burst: 2 }, () => now);
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });

    now = 100_000;
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
  });

  it("accumulates fractional refills across denied calls and rounds retry seconds up", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 24, burst: 1 }, () => now);
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 3 });
    now = 600;
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 2 });
    now = 2_499;
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
    now = 2_500;
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 3 });
  });

  it("returns at least one retry second even for fast refills", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 6_000, burst: 1 }, () => now);
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
    now = 9;
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
    now = 10;
    assert.deepEqual(limiter.take("key"), { allowed: true });
  });

  it("isolates buckets by key id", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 1, burst: 1 }, () => now);
    assert.deepEqual(limiter.take("first"), { allowed: true });
    assert.deepEqual(limiter.take("first"), { allowed: false, retryAfter: 60 });
    assert.deepEqual(limiter.take("second"), { allowed: true });
    now = 30_000;
    assert.deepEqual(limiter.take("first"), { allowed: false, retryAfter: 30 });
    assert.deepEqual(limiter.take("second"), { allowed: false, retryAfter: 30 });
    now = 60_000;
    assert.deepEqual(limiter.take("first"), { allowed: true });
    assert.deepEqual(limiter.take("second"), { allowed: true });
  });

  it("does not refill twice when the clock rolls backward and recovers", () => {
    let now = 10_000;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 60, burst: 1 }, () => now);
    assert.deepEqual(limiter.take("key"), { allowed: true });
    now = 9_000;
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
    now = 10_000;
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
    now = 10_500;
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
    now = 10_250;
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
    now = 11_000;
    assert.deepEqual(limiter.take("key"), { allowed: true });
    assert.deepEqual(limiter.take("key"), { allowed: false, retryAfter: 1 });
  });

  it("sweeps buckets idle more than ten minutes every thousand calls", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 1, burst: 30 }, () => now);
    for (let i = 0; i < 30; i += 1) {
      assert.equal(limiter.take("idle").allowed, true);
    }
    now = 600_001;
    for (let i = 0; i < 969; i += 1) limiter.take("driver");

    for (let i = 0; i < 30; i += 1) {
      assert.equal(limiter.take("idle").allowed, true);
    }
    assert.equal(limiter.take("idle").allowed, false);
    assert.equal(limiter.take("driver").allowed, false);
    now = 1_200_002;
    for (let i = 0; i < 968; i += 1) limiter.take("driver");
    for (let i = 0; i < 30; i += 1) {
      assert.equal(limiter.take("idle").allowed, true);
    }
    assert.equal(limiter.take("idle").allowed, false);
  });

  it("does not sweep early and preserves activity before the thousandth call", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 1, burst: 30 }, () => now);
    for (let i = 0; i < 30; i += 1) limiter.take("idle");
    now = 600_001;
    for (let i = 0; i < 968; i += 1) limiter.take("driver");

    for (let i = 0; i < 10; i += 1) {
      assert.equal(limiter.take("idle").allowed, true);
    }
    assert.equal(limiter.take("idle").allowed, false);
  });

  it("retains a bucket idle for exactly ten minutes during a sweep", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 1, burst: 30 }, () => now);
    for (let i = 0; i < 30; i += 1) limiter.take("idle");
    now = 600_000;
    for (let i = 0; i < 969; i += 1) limiter.take("driver");

    for (let i = 0; i < 10; i += 1) {
      assert.equal(limiter.take("idle").allowed, true);
    }
    assert.equal(limiter.take("idle").allowed, false);
  });

  it("caps buckets at ten thousand and evicts the least recently handled key", () => {
    let now = 0;
    const limiter = new WebhookRateLimiter({ ratePerMinute: 1, burst: 1 }, () => now);
    for (let i = 0; i < 10_000; i += 1) {
      now = i;
      assert.equal(limiter.take(`key-${i}`).allowed, true);
    }
    now = 10_000;
    assert.equal(limiter.take("key-0").allowed, false);
    now = 10_001;
    assert.equal(limiter.take("overflow").allowed, true);
    assert.equal(limiter.take("key-0").allowed, false);
    assert.equal(limiter.take("key-2").allowed, false);
    assert.equal(limiter.take("key-1").allowed, true);
  });
});
