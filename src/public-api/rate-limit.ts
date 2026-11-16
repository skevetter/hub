import type { WebhookOptions } from "../webhook-config.js";

const IDLE_TIMEOUT_MS = 10 * 60_000;
const SWEEP_INTERVAL = 1_000;
const MAX_BUCKETS = 10_000;
const ALLOWED = Object.freeze({ allowed: true as const });

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

export class WebhookRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;
  private readonly burst: number;
  private callsSinceSweep = 0;
  private observedAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    options: Pick<WebhookOptions, "ratePerMinute" | "burst">,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.refillPerMs = options.ratePerMinute / 60_000;
    this.burst = options.burst;
  }

  take(keyId: string): { allowed: true } | { allowed: false; retryAfter: number } {
    const nowMs = Math.max(this.observedAtMs, this.now());
    this.observedAtMs = nowMs;
    this.callsSinceSweep += 1;
    if (this.callsSinceSweep === SWEEP_INTERVAL) {
      this.callsSinceSweep = 0;
      for (const [key, bucket] of this.buckets) {
        if (nowMs - bucket.updatedAtMs <= IDLE_TIMEOUT_MS) break;
        this.buckets.delete(key);
      }
    }

    let bucket = this.buckets.get(keyId);
    if (bucket) {
      bucket.tokens = Math.min(
        this.burst,
        bucket.tokens + (nowMs - bucket.updatedAtMs) * this.refillPerMs,
      );
      bucket.updatedAtMs = nowMs;
      this.buckets.delete(keyId);
    } else {
      if (this.buckets.size === MAX_BUCKETS) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      bucket = { tokens: this.burst, updatedAtMs: nowMs };
    }
    this.buckets.set(keyId, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return ALLOWED;
    }
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1_000)),
    };
  }
}
