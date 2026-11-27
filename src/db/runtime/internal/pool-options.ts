import { DEFAULT_ACQUIRE_TIMEOUT_MS, DEFAULT_POOL_MAX, type PostgresPoolOptions } from "./pool.js";

const POOL_MAX_VARIABLE = "PASEO_HUB_DATABASE_POOL_MAX";
const ACQUIRE_TIMEOUT_VARIABLE = "PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS";

/**
 * Reads the pool size and the connection wait from the environment. An unset or empty variable
 * keeps today's value. Anything else must be a whole number in range, so a typo stops startup
 * instead of silently running with the default.
 */
export function readDatabasePoolOptions(
  environment: Readonly<Record<string, string | undefined>>,
): Required<PostgresPoolOptions> {
  return {
    max: readInteger(environment, POOL_MAX_VARIABLE, {
      min: 1,
      max: 100,
      fallback: DEFAULT_POOL_MAX,
    }),
    acquireTimeoutMs: readInteger(environment, ACQUIRE_TIMEOUT_VARIABLE, {
      min: 1_000,
      max: 60_000,
      fallback: DEFAULT_ACQUIRE_TIMEOUT_MS,
    }),
  };
}

function readInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}".`);
  }
  return value;
}
