/** How many script steps may run at once. A step over a cap waits; it does not fail. */
export interface ScriptLimits {
  maxPerDaemon: number;
  maxPerTrigger: number;
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = { maxPerDaemon: 5, maxPerTrigger: 3 };

const PER_DAEMON_VARIABLE = "PASEO_HUB_SCRIPT_MAX_PER_DAEMON";
const PER_TRIGGER_VARIABLE = "PASEO_HUB_SCRIPT_MAX_PER_TRIGGER";

/**
 * Reads the caps from the environment. An unset or empty variable keeps its default. Anything
 * else must be a whole number from 1 to 50, so a typo stops startup instead of silently running
 * with a cap nobody chose.
 */
export function readScriptLimits(
  environment: Readonly<Record<string, string | undefined>>,
): ScriptLimits {
  return {
    maxPerDaemon: readInteger(environment, PER_DAEMON_VARIABLE, DEFAULT_SCRIPT_LIMITS.maxPerDaemon),
    maxPerTrigger: readInteger(
      environment,
      PER_TRIGGER_VARIABLE,
      DEFAULT_SCRIPT_LIMITS.maxPerTrigger,
    ),
  };
}

function readInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error(`${name} must be a whole number from 1 to 50, got "${raw}".`);
  }
  return value;
}
