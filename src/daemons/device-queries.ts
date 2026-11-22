import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { listSessionProfiles } from "../interactive-sessions/functions.js";
import { useSnapshotQuery } from "../queries/index.js";
import { deviceProviders, deviceStatus, profilesByDaemon } from "./device-details.js";
import { daemonProviderSnapshot, type BrowserDaemon } from "./functions.js";

const PROVIDER_POLL_INTERVAL_MS = 2_000;
const MAX_PROVIDER_READS = 16;
const NO_LABELS: readonly string[] = [];

export function useDeviceProviders(
  daemon: BrowserDaemon,
  accountId: string,
  organizationSlug: string,
) {
  const read = useServerFn(daemonProviderSnapshot);
  const connected = deviceStatus(daemon) === "connected";
  const query = useQuery({
    queryKey: [
      "daemon-device-providers",
      accountId,
      organizationSlug,
      daemon.id,
      daemon.connectedAt,
    ],
    enabled: connected,
    queryFn: async ({ signal }) => {
      const result = await read({ data: { organizationSlug, daemonId: daemon.id }, signal });
      if (result.status === "error") throw new Error(result.error.message);
      return deviceProviders(result.data.entries);
    },
    refetchInterval: ({ state }) =>
      state.status === "success" &&
      state.data?.discovering === true &&
      state.dataUpdateCount < MAX_PROVIDER_READS
        ? PROVIDER_POLL_INTERVAL_MS
        : false,
  });
  const { data, isPending } = query;
  return useMemo(() => {
    if (!connected || isPending) return undefined;
    if (data === undefined)
      return { labels: NO_LABELS, message: "Provider information is unavailable." };
    return {
      labels: data.labels,
      message: data.discovering ? "The daemon is still checking for providers." : null,
    };
  }, [connected, data, isPending]);
}

export function useDeviceProfiles(enabled: boolean, accountId: string, organizationSlug: string) {
  const read = useServerFn(listSessionProfiles);
  const { data, status } = useSnapshotQuery({
    queryKey: ["daemon-device-profiles", accountId, organizationSlug],
    enabled,
    queryFn: ({ signal }) => read({ data: { organizationSlug, manage: true }, signal }),
  });
  return useMemo(() => {
    if (!enabled) return undefined;
    if (Array.isArray(data)) return { byDaemon: profilesByDaemon(data), message: null };
    return {
      byDaemon: null,
      message:
        status === "pending" ? "Loading session profiles..." : "Session profiles are unavailable.",
    };
  }, [data, enabled, status]);
}
