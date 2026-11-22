import type { HubProviderSnapshotEntry } from "../hub/protocol.js";
import type { BrowserDaemon } from "./functions.js";

export type DaemonFilterStatus = "all" | "connected" | "offline";

export function deviceStatus(daemon: BrowserDaemon) {
  return daemon.status === "revoked" ? "revoked" : daemon.presence;
}

export function filterDaemons(
  daemons: readonly BrowserDaemon[],
  search: string,
  status: DaemonFilterStatus,
) {
  const name = search.trim().toLowerCase();
  return daemons.filter(
    (daemon) =>
      daemon.slug.toLowerCase().includes(name) &&
      (status === "all" || deviceStatus(daemon) === status),
  );
}

type ProviderEntry = Pick<HubProviderSnapshotEntry, "provider" | "label" | "status" | "enabled">;

export function deviceProviders(entries: readonly ProviderEntry[]) {
  return {
    labels: entries
      .filter(({ status, enabled }) => status === "ready" && enabled)
      .map(({ label, provider }) => label ?? provider),
    discovering: entries.some(({ status, enabled }) => status === "loading" && enabled),
  };
}

export interface DeviceProfileName {
  id: string;
  name: string;
}

export function profilesByDaemon(profiles: readonly (DeviceProfileName & { daemonId: string })[]) {
  const byDaemon = new Map<string, DeviceProfileName[]>();
  for (const { id, name, daemonId } of profiles) {
    const names = byDaemon.get(daemonId) ?? [];
    names.push({ id, name });
    byDaemon.set(daemonId, names);
  }
  return byDaemon;
}
