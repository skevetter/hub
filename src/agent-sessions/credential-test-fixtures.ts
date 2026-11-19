import { parseConnectionTemplate } from "../config/connection-template.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";

const reference = "${{ paseo.connections.installation.token }}";

export type SessionSelection = "continued" | "created" | "error";

interface CredentialHistory {
  key: string;
  intents: readonly (object | null)[];
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
    intents: [{ environment: { env: { TOKEN: reference } } }],
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

export function upgradedSelection(history: CredentialHistory): SessionSelection {
  return history.key === "null" ? "created" : history.build14;
}
