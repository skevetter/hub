import { parseConnectionTemplate } from "../config/connection-template.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";

const reference = "${{ paseo.connections.installation.token }}";
const credentialedEnvironment = { environment: { env: { TOKEN: reference } } };
const nullEnvironmentValue = { environment: { env: { VALUE: null } } };

export type SessionSelection = "continued" | "created" | "error";
export type LegacyLaunchIntent = object | string | null;

export interface CredentialHistory {
  key: string;
  intents: readonly LegacyLaunchIntent[];
  build14: SessionSelection;
  migrated: readonly (boolean | null)[];
  backfilled: readonly (boolean | null)[];
}

export const credentialHistories: readonly CredentialHistory[] = [
  {
    key: "plain",
    intents: [{ environment: {} }],
    build14: "continued",
    migrated: [false],
    backfilled: [false],
  },
  {
    key: "github",
    intents: [{ environment: {}, github: {} }],
    build14: "created",
    migrated: [true],
    backfilled: [true],
  },
  {
    key: "base",
    intents: [credentialedEnvironment],
    build14: "created",
    migrated: [null],
    backfilled: [true],
  },
  {
    key: "override",
    intents: [{ environment: { env: { TOKEN: reference } }, env: { TOKEN: "plain" } }],
    build14: "continued",
    migrated: [false],
    backfilled: [false],
  },
  {
    key: "execution",
    intents: [{ environment: {}, env: { TOKEN: reference } }],
    build14: "created",
    migrated: [null],
    backfilled: [true],
  },
  {
    key: "mixed",
    intents: [{ environment: {} }, { environment: {}, env: { TOKEN: reference } }],
    build14: "created",
    migrated: [false, null],
    backfilled: [false, true],
  },
  {
    key: "null",
    intents: [null],
    build14: "continued",
    migrated: [null],
    backfilled: [null],
  },
  {
    key: "empty-env-array",
    intents: [{ environment: { env: [] } }],
    build14: "continued",
    migrated: [null],
    backfilled: [false],
  },
  {
    key: "null-env-map",
    intents: [{ environment: { env: null } }],
    build14: "continued",
    migrated: [null],
    backfilled: [false],
  },
  {
    key: "nested-env-array",
    intents: [{ environment: { env: { LEGACY: [reference] } } }],
    build14: "continued",
    migrated: [null],
    backfilled: [false],
  },
  {
    key: "invalid-template",
    intents: [{ environment: { env: { TOKEN: "${{ invalid }}" } } }],
    build14: "error",
    migrated: [null],
    backfilled: [null],
  },
  {
    key: "missing-environment",
    intents: [{ prompt: "unknown-content" }],
    build14: "error",
    migrated: [null],
    backfilled: [null],
  },
  {
    key: "nested-null",
    intents: [nullEnvironmentValue],
    build14: "error",
    migrated: [null],
    backfilled: [null],
  },
  {
    key: "nested-null-overridden",
    intents: [{ ...nullEnvironmentValue, env: { VALUE: reference } }],
    build14: "created",
    migrated: [null],
    backfilled: [true],
  },
  {
    key: "array-map",
    intents: [{ environment: { env: [reference] } }],
    build14: "created",
    migrated: [null],
    backfilled: [true],
  },
  {
    key: "execution-array-map",
    intents: [{ environment: { env: { "0": reference } }, env: ["plain"] }],
    build14: "continued",
    migrated: [null],
    backfilled: [false],
  },
  {
    key: "nested-object",
    intents: [{ environment: { env: { VALUE: { TOKEN: reference } } } }],
    build14: "continued",
    migrated: [null],
    backfilled: [false],
  },
  {
    key: "github-null-presence",
    intents: [{ github: null }],
    build14: "created",
    migrated: [true],
    backfilled: [true],
  },
  {
    key: "three-owners",
    intents: [{ environment: {} }, { environment: { env: null } }, credentialedEnvironment],
    build14: "created",
    migrated: [false, null, null],
    backfilled: [false, false, true],
  },
  {
    key: "mixed-credential-first",
    intents: [credentialedEnvironment, nullEnvironmentValue],
    build14: "created",
    migrated: [null, null],
    backfilled: [true, null],
  },
  {
    key: "mixed-malformed-first",
    intents: [nullEnvironmentValue, credentialedEnvironment],
    build14: "error",
    migrated: [null, null],
    backfilled: [null, true],
  },
  {
    key: "top-level-array",
    intents: [["github"]],
    build14: "error",
    migrated: [null],
    backfilled: [null],
  },
  {
    key: "top-level-string",
    intents: ["github"],
    build14: "error",
    migrated: [null],
    backfilled: [null],
  },
  {
    key: "string-env-map",
    intents: [{ environment: { env: reference } }],
    build14: "continued",
    migrated: [null],
    backfilled: [false],
  },
];

export function build14Selection(
  intents: readonly (LaunchMachineIntent | null)[],
): SessionSelection {
  try {
    return intents.some(
      (intent) =>
        intent !== null &&
        (intent.github !== undefined ||
          Object.values({ ...intent.environment.env, ...intent.env }).some(
            (value) => parseConnectionTemplate(value).length > 0,
          )),
    )
      ? "created"
      : "continued";
  } catch {
    return "error";
  }
}

export function upgradedSelection(history: CredentialHistory): Exclude<SessionSelection, "error"> {
  return history.key !== "null" && history.build14 === "continued" ? "continued" : "created";
}
