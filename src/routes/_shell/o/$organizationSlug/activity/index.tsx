import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { TriggerActivityPanel } from "../../../../../triggers/activity-panel.js";
import { activityPageKey, activityPageRequest } from "../../../../../triggers/activity-query.js";
import { triggerActivityPage } from "../../../../../triggers/functions.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity/")({
  validateSearch: z.object({ cursor: z.string().optional().catch(undefined) }),
  // The pager stays on screen while the next page loads, so there is no pending surface to show.
  pendingMs: Number.POSITIVE_INFINITY,
  // The address keeps only a usable cursor. Anything else a reader typed or bookmarked is dropped.
  beforeLoad: ({ location, params, search }) => {
    const typed: Record<string, unknown> = location.search;
    const clean =
      Object.keys(typed).every((key) => key === "cursor") && typed["cursor"] === search.cursor;
    if (clean) return;
    throw redirect({
      to: "/o/$organizationSlug/activity",
      params: { organizationSlug: params.organizationSlug },
      search: search.cursor === undefined ? {} : { cursor: search.cursor },
      replace: true,
    });
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  // The page is read before the route changes, so the panel never swaps to a skeleton mid-paging
  // and a cursor the server could not use is dropped from the address instead of kept stale.
  loader: async ({ context, deps, params }) => {
    const result = await triggerActivityPage({
      data: activityPageRequest(params.organizationSlug, deps.cursor),
    });
    if (result.status !== "ok") return;
    context.queryClient.setQueryData(
      activityPageKey(params.organizationSlug, deps.cursor),
      result.data,
    );
    if (deps.cursor !== undefined && result.data.previousCursor === null) {
      throw redirect({
        to: "/o/$organizationSlug/activity",
        params: { organizationSlug: params.organizationSlug },
        search: {},
        replace: true,
      });
    }
  },
  component: TriggerActivityPanel,
});
