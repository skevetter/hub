import { useServerFn } from "@tanstack/react-start";
import type { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { FailureAlert } from "../components/app/failure-alert.js";
import type { Result } from "../contract/respond.js";
import { useSnapshotQuery } from "../queries/index.js";
import { useRouteTenant } from "./context.js";
import type { ProjectDashboard } from "./dashboard.js";
import { organizationSnapshot } from "./functions.js";

/**
 * The load/command plumbing the organization panels share: one snapshot query per scope and the
 * failure a command leaves behind.
 */

export type OrganizationSnapshot = Awaited<ReturnType<ProjectDashboard["organizationSnapshot"]>>;

export function useOrganizationSnapshot() {
  const tenant = useRouteTenant();
  const load = useServerFn(organizationSnapshot);
  const queryKey = useMemo(
    () => ["organization", tenant.account.id, tenant.organization.id],
    [tenant.account.id, tenant.organization.id],
  );
  const query = useSnapshotQuery({
    queryKey,
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
  });
  return { ...query, queryKey };
}

export function CommandError({
  mutations,
}: {
  mutations: Array<{ data: Result<unknown> | undefined; isError: boolean }>;
}) {
  const failed = mutations.find(
    (mutation) => mutation.isError || mutation.data?.status === "error",
  );
  if (failed === undefined) return null;
  return (
    <FailureAlert
      page
      title="The last action didn't complete"
      error={failed.data}
      fallback="Hub did not receive the project action result. Check your connection and reload the current project state."
    />
  );
}

async function invalidateScope(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: { organizationSlug: string },
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["attention"] }),
    queryClient.invalidateQueries({ queryKey: ["organization"] }),
    queryClient.invalidateQueries({ queryKey: ["project"] }),
    queryClient.invalidateQueries({ queryKey: ["tenant", scope.organizationSlug] }),
  ]);
}

export async function invalidateOrganization(
  queryClient: ReturnType<typeof useQueryClient>,
  organizationSlug: string,
) {
  await invalidateScope(queryClient, { organizationSlug });
}
