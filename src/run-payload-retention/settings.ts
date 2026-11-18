const MODE = "PASEO_HUB_RUN_PAYLOAD_EXPIRY";
const DAYS = "PASEO_HUB_RUN_PAYLOAD_RETENTION_DAYS";
const LIMIT = "PASEO_HUB_RUN_PAYLOAD_EXPIRY_MAX_RUNS_PER_PASS";
const TIMELINE_DAYS = "PASEO_HUB_TIMELINE_RETENTION_DAYS";

export interface RunPayloadRetentionSettings {
  mode: "off" | "count" | "on";
  retentionDays: number;
  maxRunsPerPass: number;
}

export function readRunPayloadRetentionSettings(
  env: Readonly<Record<string, string | undefined>>,
  timelineDays: number,
): RunPayloadRetentionSettings {
  const mode = env[MODE]?.trim() || "off";
  if (mode !== "off" && mode !== "count" && mode !== "on") {
    throw new Error(`${MODE} must be off, count, or on.`);
  }
  const settings: RunPayloadRetentionSettings = {
    mode,
    retentionDays: wholeNumber(env[DAYS], DAYS, 30, 365),
    maxRunsPerPass: wholeNumber(env[LIMIT], LIMIT, 50, Number.MAX_SAFE_INTEGER),
  };
  assertRunPayloadWindow(settings, timelineDays);
  return settings;
}

export function assertRunPayloadWindow(
  settings: RunPayloadRetentionSettings,
  timelineDays: number,
) {
  if (settings.mode === "on" && settings.retentionDays < timelineDays) {
    throw new Error(
      `${DAYS}=${settings.retentionDays} must be at least ${TIMELINE_DAYS}=${timelineDays} when ${MODE}=on.`,
    );
  }
}

function wholeNumber(raw: string | undefined, name: string, fallback: number, max: number) {
  const text = raw?.trim();
  if (text === undefined || text === "") return fallback;
  const value = /^\d+$/u.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}.`);
  }
  return value;
}
