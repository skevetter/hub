import { matchQuery, notifyManager, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { ProjectDashboard } from "../projects/dashboard.js";
import type { ConnectionProvider } from "./result-contract.js";

type OrganizationSnapshot = Awaited<ReturnType<ProjectDashboard["organizationSnapshot"]>>;

export interface ConnectionIdentity {
  provider: ConnectionProvider;
  connectionId: string;
}

export interface ConnectionQueryKeys {
  snapshot: QueryKey;
  status: QueryKey;
  revocation: QueryKey;
}

export function cacheAcknowledgedRevocation(
  client: QueryClient,
  keys: ConnectionQueryKeys,
  removed: ConnectionIdentity,
) {
  const cache = client.getQueryCache();
  notifyManager.batch(() => {
    // A read that started before the revoke can still carry the deleted connection.
    void client.cancelQueries({ queryKey: keys.snapshot, exact: true });
    void client.cancelQueries({ queryKey: keys.status, exact: true });

    const marker = cache.build(client, { queryKey: keys.revocation, gcTime: Infinity });
    client.setQueryData(keys.revocation, removed);
    client.setQueryData<OrganizationSnapshot>(keys.snapshot, (current) =>
      current === undefined
        ? undefined
        : {
            ...current,
            connections: {
              ...current.connections,
              [removed.provider]: current.connections[removed.provider].filter(
                ({ id }) => id !== removed.connectionId,
              ),
            },
          },
    );

    const remaining = [keys.snapshot, keys.status];
    // Both server reads can settle while the Connections route is unmounted.
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "removed" && event.query === marker) {
        unsubscribe();
        return;
      }
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual)
        return;
      const index = remaining.findIndex((queryKey) =>
        matchQuery({ queryKey, exact: true }, event.query),
      );
      if (index < 0) return;
      remaining.splice(index, 1);
      if (remaining.length === 0) client.removeQueries({ queryKey: keys.revocation, exact: true });
    });
  });
}
