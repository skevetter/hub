import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "../components/app/toast-store.js";
import { useOptionalRouteTenant } from "../projects/route-tenant-context.js";
import { useSnapshotQuery } from "../queries/index.js";
import { actionableAttentionItems, withoutFailedRuns } from "./client-state.js";
import type { AttentionSnapshot } from "./contract.js";
import { attentionSnapshot, markFailedRunsSeen } from "./functions.js";

const ATTENTION_KEY = ["attention"] as const;
const MARK_SEEN_FAILURE = "Hub could not mark runs as seen. Try again.";

interface AttentionScope {
  organizationSlug: string;
  queryKey: readonly unknown[];
}

export function useAttention() {
  const tenant = useOptionalRouteTenant();
  const organizationSlug = tenant?.organization.slug;
  const queryKey = [...ATTENTION_KEY, tenant?.account.id, tenant?.organization.id];
  const load = useServerFn(attentionSnapshot);
  const snapshot = useSnapshotQuery({
    queryKey,
    queryFn: () => {
      if (organizationSlug === undefined) throw new Error("Attention requires an organization");
      return load({ data: { organizationSlug } });
    },
    enabled: tenant !== null,
    refetchInterval: 30_000,
  });
  const markSeen = useMarkFailedRunsSeen();
  return {
    snapshot,
    count: actionableAttentionItems(snapshot.data?.items ?? []).length,
    markSeenPending: markSeen.isPending,
    markFailedRunsSeen: () => {
      if (organizationSlug !== undefined) markSeen.mutate({ organizationSlug, queryKey });
    },
  };
}

function useMarkFailedRunsSeen() {
  const send = useServerFn(markFailedRunsSeen);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ organizationSlug }: AttentionScope) => {
      const result = await send({ data: { organizationSlug } });
      if (result.status === "error") throw new Error(MARK_SEEN_FAILURE);
    },
    onMutate: async ({ queryKey }) => {
      await queryClient.cancelQueries({ queryKey, exact: true });
      const previous = queryClient.getQueryData<AttentionSnapshot>(queryKey);
      if (previous !== undefined) queryClient.setQueryData(queryKey, withoutFailedRuns(previous));
      return previous;
    },
    onError: (_error, { organizationSlug, queryKey }, previous) => {
      if (previous !== undefined) queryClient.setQueryData(queryKey, previous);
      toast({ title: MARK_SEEN_FAILURE, scope: organizationSlug });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ATTENTION_KEY }),
  });
}
