import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo } from "react";
import { listSessionProfiles } from "../interactive-sessions/functions.js";
import { useSnapshotQuery } from "../queries/index.js";
import { deviceProviders, deviceStatus, profilesByDaemon } from "./device-details.js";
import { daemonProviderSnapshot, type BrowserDaemon } from "./functions.js";
import { ProviderReadTimeout, type ProviderReadLimiter } from "./provider-read-limiter.js";

const PROVIDER_POLL_INTERVAL_MS = 2_000;
const MAX_PROVIDER_READS = 16;
const NO_LABELS: readonly string[] = [];

export function useDeviceProviders(
  daemon: BrowserDaemon,
  accountId: string,
  organizationSlug: string,
  limiter: ProviderReadLimiter,
) {
  const read = useServerFn(daemonProviderSnapshot);
  const queryClient = useQueryClient();
  const connected = deviceStatus(daemon) === "connected";
  const query = useQuery<ReturnType<typeof deviceProviders>>({
    queryKey: [
      "daemon-device-providers",
      accountId,
      organizationSlug,
      daemon.id,
      daemon.connectedAt,
    ],
    enabled: ({ state }) => connected && !(state.error instanceof ProviderReadTimeout),
    retry: (failures, error) => !(error instanceof ProviderReadTimeout) && failures < 3,
    queryFn: ({ signal, queryKey }) =>
      limiter.schedule(
        daemon.id,
        signal,
        async (requestSignal) => {
          const result = await read({
            data: { organizationSlug, daemonId: daemon.id },
            signal: requestSignal,
          });
          if (result.status === "error") throw new Error(result.error.message);
          return deviceProviders(result.data.entries);
        },
        () => {
          void queryClient.cancelQueries({ queryKey, exact: true });
        },
      ),
    refetchInterval: ({ state }) =>
      state.status === "success" &&
      state.data?.discovering === true &&
      state.dataUpdateCount < MAX_PROVIDER_READS
        ? PROVIDER_POLL_INTERVAL_MS
        : false,
  });
  const { data, error, isFetching, isPending, refetch } = query;
  const retry = useCallback(() => {
    void refetch({ cancelRefetch: false });
  }, [refetch]);
  return useMemo(() => {
    if (!connected || isPending) return undefined;
    if (error instanceof ProviderReadTimeout) {
      if (isFetching) return undefined;
      return { labels: NO_LABELS, message: error.message, onRetry: retry };
    }
    if (data === undefined)
      return { labels: NO_LABELS, message: "Provider information is unavailable." };
    return {
      labels: data.labels,
      message: data.discovering ? "The daemon is still checking for providers." : null,
    };
  }, [connected, data, error, isFetching, isPending, retry]);
}

export function useDeviceProfiles(enabled: boolean, accountId: string, organizationSlug: string) {
  const read = useServerFn(listSessionProfiles);
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["daemon-device-profiles", accountId, organizationSlug],
    [accountId, organizationSlug],
  );
  useEffect(() => {
    if (!enabled) queryClient.removeQueries({ queryKey, exact: true });
  }, [enabled, queryClient, queryKey]);
  const { data, status } = useSnapshotQuery({
    queryKey,
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
