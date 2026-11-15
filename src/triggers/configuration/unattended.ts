/**
 * The providers a Hub run can use, and under which modes.
 *
 * Nobody is at the keyboard during a Hub run, so every tool call must run without a prompt. Two
 * mechanisms exist, and a provider supports one of them:
 *
 * - An exact MCP tool policy. Hub sends a `toolPolicy` that preapproves the Hub MCP tools
 *   (`hub.reply`, `hub.finish_execution`). A daemon accepts it only for providers whose contract
 *   supports exact MCP preapproval (`PROVIDER_CONTRACTS` in getpaseo/paseo
 *   `packages/server/src/server/agent/provider-registry.ts`) and refuses it for every other
 *   provider at launch with "cannot preapprove exact MCP tools for unattended execution".
 * - A mode that approves everything. `omp` has no tool policy, but its `full` mode runs every
 *   tool without a prompt, so Hub omits the policy and requires that mode. Its `write` and `ask`
 *   modes prompt, Hub never answers a prompt, and such a run would stall until its idle timeout.
 *
 * The daemon's provider snapshot carries neither fact, so Hub keeps this table and refuses at
 * save instead. Delete it once the snapshot says it per provider.
 */
interface UnattendedProvider {
  /** Modes that run without a prompt; `undefined` allows any mode the daemon offers. */
  readonly modes?: readonly string[];
  /** Whether the daemon accepts the exact MCP tool policy Hub sends with a run. */
  readonly toolPolicy: boolean;
  /** Why the modes are limited, said in the refusal. */
  readonly modeReason?: string;
}

const UNATTENDED_PROVIDERS: Readonly<Record<string, UnattendedProvider>> = {
  claude: { toolPolicy: true },
  codex: { toolPolicy: true },
  opencode: { toolPolicy: true },
  omp: {
    modes: ["full"],
    toolPolicy: false,
    modeReason: "it approves every tool call and Hub cannot answer approval prompts",
  },
};

function unattendedProvider(provider: string): UnattendedProvider | undefined {
  return Object.hasOwn(UNATTENDED_PROVIDERS, provider) ? UNATTENDED_PROVIDERS[provider] : undefined;
}

export function supportsUnattendedRuns(provider: string): boolean {
  return unattendedProvider(provider) !== undefined;
}

/** The modes a provider runs unattended in, or `undefined` when any mode the daemon offers will do. */
export function unattendedModes(provider: string): readonly string[] | undefined {
  return unattendedProvider(provider)?.modes;
}

/** Whether Hub sends the exact MCP tool policy to the daemon for this provider. */
export function sendsToolPolicy(provider: string): boolean {
  return unattendedProvider(provider)?.toolPolicy ?? true;
}

/** The daemon's own sentence, said before the run instead of after it. */
export function unattendedProviderRefusal(provider: string): string {
  return `Provider '${provider}' cannot run unattended Hub automations; select Claude, Codex, OpenCode, or omp.`;
}

/** The refusal for a mode that would stall, or `undefined` when the mode can run unattended. */
export function unattendedModeRefusal(
  provider: string,
  mode: string | undefined,
): string | undefined {
  const entry = unattendedProvider(provider);
  if (entry?.modes === undefined || (mode !== undefined && entry.modes.includes(mode))) {
    return undefined;
  }
  const allowed = entry.modes.map((allowedMode) => `'${allowedMode}'`).join(", ");
  const selected = mode === undefined ? "No mode is set" : `Mode '${mode}' is not allowed`;
  return `${selected}: provider '${provider}' runs unattended only in mode ${allowed}, because ${entry.modeReason ?? "other modes prompt for approval"}.`;
}
