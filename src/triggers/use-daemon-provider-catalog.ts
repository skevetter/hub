import { useServerFn } from "@tanstack/react-start";

import { daemonProviderSnapshot } from "../daemons/functions.js";
import { useSnapshotQuery } from "../queries/index.js";

export function useDaemonProviderCatalog(
  organizationSlug: string,
  daemonId: string | undefined,
  cwd: string,
) {
  const load = useServerFn(daemonProviderSnapshot);
  const queryKey = ["daemon-provider-snapshot", organizationSlug, daemonId, cwd] as const;
  const enabled = daemonId !== undefined && cwd.trim() !== "";
  const query = useSnapshotQuery({
    queryKey,
    enabled,
    queryFn: () => {
      if (daemonId === undefined) throw new Error("A daemon is required to load providers.");
      return load({ data: { organizationSlug, daemonId, cwd: cwd.trim(), refresh: true } });
    },
  });
  const entries = query.data?.entries;
  const providerErrors = (entries ?? [])
    .filter((entry) => entry.status === "error")
    .map((entry) => `${entry.label ?? entry.provider}: ${entry.error ?? "unavailable"}`);
  const providerError = providerErrors.length > 0 ? providerErrors.join(" ") : undefined;
  return {
    entries,
    loading: query.isFetching,
    error:
      query.status === "error"
        ? (query.error ?? "Hub couldn't load this daemon's providers.")
        : providerError,
    refresh: query.refetch,
  };
}

export type DaemonProviderCatalog = ReturnType<typeof useDaemonProviderCatalog>;
