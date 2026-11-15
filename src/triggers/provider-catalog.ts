import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import { splitAgentId } from "./configuration/editor.js";
import { supportsUnattendedRuns, unattendedModes } from "./configuration/unattended.js";

export function selectedProviderModel(
  entries: HubProviderSnapshotEntry[] | undefined,
  agent: string,
) {
  let selection: { provider: string; model?: string } | undefined;
  try {
    selection = agent === "" ? undefined : splitAgentId(agent);
  } catch {
    selection = undefined;
  }
  const entry = entries?.find((candidate) => candidate.provider === selection?.provider);
  return {
    entry,
    model: entry?.models?.find(
      (candidate) =>
        candidate.id === selection?.model || candidate.aliases?.includes(selection?.model ?? ""),
    ),
  };
}

/**
 * The models a trigger can run unattended. A provider that cannot is not offered: the daemon
 * refuses Hub's tool policy for it at launch, and Hub has no other way to approve its tool calls.
 */
export function unattendedAgentOptions(entries: HubProviderSnapshotEntry[] | undefined) {
  return (entries ?? []).flatMap((entry) =>
    entry.status !== "ready" || !entry.enabled || !supportsUnattendedRuns(entry.provider)
      ? []
      : (entry.models ?? [])
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({
            value: `${entry.provider}/${model.id}`,
            label: model.label,
            detail: `${entry.label ?? entry.provider} · ${entry.provider}/${model.id}`,
            keywords: [model.label, entry.label ?? entry.provider, model.id],
          })),
  );
}

/**
 * The modes offered for the selected provider. A provider that approves tool calls only in some
 * modes offers just those: Hub never answers a prompt, so any other mode would stall the run.
 */
export function unattendedModeOptions(entry: HubProviderSnapshotEntry | undefined) {
  const allowed = entry === undefined ? undefined : unattendedModes(entry.provider);
  return (entry?.modes ?? [])
    .filter((mode) => allowed === undefined || allowed.includes(mode.id))
    .map((mode) => ({ value: mode.id, label: mode.label }));
}
