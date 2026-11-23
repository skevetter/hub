export const LINEAR_PILOT_ENV = "PASEO_HUB_LINEAR_PILOT";

export interface LinearPilotConfig {
  readonly hubOrganizationId: string;
  readonly linearOrganizationId: string;
  readonly allowedHumanId: string;
  readonly profileId: string;
  readonly toolSteps?: boolean;
}

export type LinearPilotConfigResult =
  | { readonly status: "absent" }
  | { readonly status: "enabled"; readonly config: LinearPilotConfig }
  | { readonly status: "invalid"; readonly reason: LinearPilotConfigIssue };

export type LinearPilotConfigIssue =
  | "empty"
  | "too_large"
  | "escape_sequence"
  | "not_json"
  | "not_a_record"
  | "unknown_key"
  | "missing_key"
  | "duplicate_key"
  | "bad_value";

const KEYS = ["hubOrganizationId", "linearOrganizationId", "allowedHumanId", "profileId"] as const;
const OPTIONAL_KEY = "toolSteps";
const MAX_RAW_CHARS = 1024;
export const LINEAR_PILOT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

const invalid = (reason: LinearPilotConfigIssue): LinearPilotConfigResult => ({
  status: "invalid",
  reason,
});

/**
 * Startup-only parse of the single pilot record. Invalid input never degrades to a partial
 * config: the caller must treat `invalid` as a refusal to start the pilot. Values are never
 * echoed back, so an operator typo cannot leak through logs.
 */
export function parseLinearPilotConfig(raw: string | undefined): LinearPilotConfigResult {
  if (raw === undefined) return { status: "absent" };
  const issue = rawIssue(raw);
  if (issue !== undefined) return invalid(issue);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid("not_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid("not_a_record");
  }
  return parseRecord(raw, new Map<string, unknown>(Object.entries(parsed)));
}

function parseRecord(raw: string, record: ReadonlyMap<string, unknown>): LinearPilotConfigResult {
  if (
    [...record.keys()].some((key) => key !== OPTIONAL_KEY && !KEYS.some((known) => known === key))
  ) {
    return invalid("unknown_key");
  }
  if (KEYS.some((key) => !record.has(key))) return invalid("missing_key");
  const fields = readFields(record);
  if (fields === undefined) return invalid("bad_value");
  const toolSteps = record.get(OPTIONAL_KEY);
  if (toolSteps !== undefined && typeof toolSteps !== "boolean") return invalid("bad_value");
  // Values hold no quote or backslash, so a key name followed by a colon appearing twice can
  // only be a duplicate key that JSON.parse would silently resolve to the last one.
  if (hasDuplicateKeys(raw, record)) return invalid("duplicate_key");
  return {
    status: "enabled",
    config: Object.freeze({
      ...fields,
      ...(toolSteps === undefined ? {} : { toolSteps }),
    }),
  };
}

function readFields(record: ReadonlyMap<string, unknown>) {
  const hubOrganizationId = readId(record, "hubOrganizationId");
  const linearOrganizationId = readId(record, "linearOrganizationId");
  const allowedHumanId = readId(record, "allowedHumanId");
  const profileId = readUuid(record, "profileId");
  if (
    hubOrganizationId === undefined ||
    linearOrganizationId === undefined ||
    allowedHumanId === undefined ||
    profileId === undefined
  ) {
    return undefined;
  }
  return { hubOrganizationId, linearOrganizationId, allowedHumanId, profileId };
}

function hasDuplicateKeys(raw: string, record: ReadonlyMap<string, unknown>) {
  return [...record.keys()].some(
    (key) => [...raw.matchAll(new RegExp(`"${key}"\\s*:`, "gu"))].length !== 1,
  );
}

export function linearPilotConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): LinearPilotConfigResult {
  return parseLinearPilotConfig(env[LINEAR_PILOT_ENV]);
}

function readId(record: ReadonlyMap<string, unknown>, key: string): string | undefined {
  const value = record.get(key);
  return typeof value === "string" && LINEAR_PILOT_ID.test(value) ? value : undefined;
}

// The profile id is a database uuid. Lowercase it so later comparisons are exact.
function readUuid(record: ReadonlyMap<string, unknown>, key: string): string | undefined {
  const value = record.get(key);
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

function rawIssue(raw: string): LinearPilotConfigIssue | undefined {
  if (raw.trim().length === 0) return "empty";
  if (raw.length > MAX_RAW_CHARS) return "too_large";
  // An escaped key such as "\u0070rofileId" would defeat the duplicate-key check.
  if (raw.includes("\\")) return "escape_sequence";
  return undefined;
}
