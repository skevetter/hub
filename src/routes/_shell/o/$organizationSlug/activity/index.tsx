import { createFileRoute, redirect } from "@tanstack/react-router";
import { TriggerActivityPanel } from "../../../../../triggers/activity-panel.js";
import {
  activityPageKey,
  activityPageRequest,
  activitySearchSchema,
} from "../../../../../triggers/activity-query.js";
import { triggerActivityPage } from "../../../../../triggers/functions.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity/")({
  validateSearch: activitySearchSchema,
  // The pager stays on screen while the next page loads, so there is no pending surface to show.
  pendingMs: Number.POSITIVE_INFINITY,
  beforeLoad: ({ location, params, search }) => {
    const typed: Record<string, unknown> = location.search;
    const normalized = activitySearchSchema.parse(search);
    const values: Record<string, unknown> = normalized;
    const clean = Object.keys(typed).every((key) => typed[key] === values[key]);
    if (clean) return;
    throw redirect({
      to: "/o/$organizationSlug/activity",
      params: { organizationSlug: params.organizationSlug },
      search: normalized,
      replace: true,
    });
  },
  loaderDeps: ({ search }) => activitySearchSchema.parse(search),
  // The page is read before the route changes, so the panel never swaps to a skeleton mid-paging
  // and a cursor the server could not use is dropped from the address instead of kept stale.
  loader: async ({ context, deps, params }) => {
    const result = await triggerActivityPage({
      data: activityPageRequest(params.organizationSlug, deps),
    });
    if (result.status !== "ok") return;
    context.queryClient.setQueryData(activityPageKey(params.organizationSlug, deps), result.data);
    if (deps.cursor !== undefined && result.data.previousCursor === null) {
      throw redirect({
        to: "/o/$organizationSlug/activity",
        params: { organizationSlug: params.organizationSlug },
        search: { ...deps, cursor: undefined },
        replace: true,
      });
    }
  },
  component: TriggerActivityPanel,
});
