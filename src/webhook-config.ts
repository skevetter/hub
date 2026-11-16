export interface WebhookOptions {
  readonly maxBytes: number;
  readonly ratePerMinute: number;
  readonly burst: number;
  readonly maxActiveRuns: number;
}

export const DEFAULT_WEBHOOK_OPTIONS: WebhookOptions = Object.freeze({
  maxBytes: 262_144,
  ratePerMinute: 120,
  burst: 30,
  maxActiveRuns: 25,
});

export function readWebhookOptions(
  env: Readonly<Record<string, string | undefined>>,
): WebhookOptions {
  return {
    maxBytes: readInteger(
      env,
      "PASEO_HUB_WEBHOOK_MAX_BYTES",
      1_024,
      1_048_576,
      DEFAULT_WEBHOOK_OPTIONS.maxBytes,
    ),
    ratePerMinute: readInteger(
      env,
      "PASEO_HUB_WEBHOOK_RATE_PER_MINUTE",
      1,
      6_000,
      DEFAULT_WEBHOOK_OPTIONS.ratePerMinute,
    ),
    burst: readInteger(env, "PASEO_HUB_WEBHOOK_BURST", 1, 1_000, DEFAULT_WEBHOOK_OPTIONS.burst),
    maxActiveRuns: readInteger(
      env,
      "PASEO_HUB_WEBHOOK_MAX_ACTIVE_RUNS",
      1,
      1_000,
      DEFAULT_WEBHOOK_OPTIONS.maxActiveRuns,
    ),
  };
}

function readInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (raw === undefined) return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}".`);
  }
  return value;
}
