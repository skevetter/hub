import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { listInteractiveSessions } from "../../../../../interactive-sessions/functions.js";
import {
  SessionListPanel,
  SessionListLoading,
} from "../../../../../interactive-sessions/ui/session-list.js";
import { SessionRouteError } from "../../../../../interactive-sessions/ui/session-states.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/sessions/")({
  validateSearch: z.object({ filter: z.literal("all").optional().catch(undefined) }),
  loaderDeps: ({ search }) => ({ filter: search.filter ?? ("active" as const) }),
  loader: ({ params: { organizationSlug }, deps: { filter } }) =>
    listInteractiveSessions({ data: { organizationSlug, filter, cursor: null } }),
  pendingComponent: SessionListLoading,
  errorComponent: SessionRouteError,
  component: SessionListRoute,
});

function SessionListRoute() {
  const { organizationSlug } = Route.useParams();
  const { filter } = Route.useLoaderDeps();
  const result = Route.useLoaderData();
  return (
    <SessionListPanel
      key={JSON.stringify([organizationSlug, filter])}
      organizationSlug={organizationSlug}
      filter={filter}
      result={result}
    />
  );
}
