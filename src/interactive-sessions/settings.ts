type Environment = Readonly<Record<string, string | undefined>>;

export interface InteractiveSessionSettings {
  enabled: boolean;
  maxActivePerDaemon: number;
  maxQueued: number;
}

export function readInteractiveSessionSettings(
  environment: Environment,
): InteractiveSessionSettings {
  const flag = "PASEO_HUB_INTERACTIVE_SESSIONS";
  const raw = environment[flag];
  if (raw !== undefined && raw !== "" && raw !== "true" && raw !== "false") {
    throw new Error(`${flag} must be true or false.`);
  }
  return {
    enabled: raw === "true",
    maxActivePerDaemon: readInteger(environment, "PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON", 4, 50),
    maxQueued: readInteger(environment, "PASEO_HUB_SESSION_MAX_QUEUED", 20, 100),
  };
}

function readInteger(
  environment: Environment,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = environment[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}.`);
  }
  return value;
}
