import { createFileRoute, redirect } from "@tanstack/react-router";
import { triggerListPage } from "../../../../../triggers/functions.js";
import { TriggersPanel } from "../../../../../triggers/panel.js";
import { triggerPageKey, triggerSearchSchema } from "../../../../../triggers/trigger-query.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/triggers/")({
  validateSearch: triggerSearchSchema,
  pendingMs: Number.POSITIVE_INFINITY,
  beforeLoad: ({ location, params, search }) => {
    const normalized = triggerSearchSchema.parse(search);
    const typed: Record<string, unknown> = location.search;
    const values: Record<string, unknown> = normalized;
    if (Object.keys(typed).every((key) => typed[key] === values[key])) return;
    throw redirect({
      to: "/o/$organizationSlug/triggers",
      params,
      search: normalized,
      state: location.state,
      replace: true,
    });
  },
  loaderDeps: ({ search }) => triggerSearchSchema.parse(search),
  loader: async ({ context, deps, params, location }) => {
    const organizationSlug = params.organizationSlug;
    const result = await triggerListPage({ data: { organizationSlug, ...deps } });
    if (result.status !== "ok") return;
    context.queryClient.setQueryData(triggerPageKey(organizationSlug, deps), result.data);
    if (deps.cursor !== undefined && result.data.previousCursor === null) {
      throw redirect({
        to: "/o/$organizationSlug/triggers",
        params,
        search: { ...deps, cursor: undefined },
        state: location.state,
        replace: true,
      });
    }
  },
  component: TriggersPanel,
});
