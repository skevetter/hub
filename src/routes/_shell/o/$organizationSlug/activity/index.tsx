import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { TriggerActivityPanel } from "../../../../../triggers/activity-panel.js";
import { activityPageKey, activityPageRequest } from "../../../../../triggers/activity-query.js";
import { triggerActivityPage } from "../../../../../triggers/functions.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity/")({
  // `page` only labels the range on screen; the cursor is what positions the list.
  validateSearch: z.object({
    cursor: z.string().optional().catch(undefined),
    page: z.number().int().min(1).optional().catch(undefined),
  }),
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
