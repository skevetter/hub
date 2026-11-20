import { createFileRoute } from "@tanstack/react-router";
import { listSessionProfiles } from "../../../../../interactive-sessions/functions.js";
import {
  SessionProfilesLoading,
  SessionProfilesPanel,
} from "../../../../../interactive-sessions/ui/session-profiles.js";
import { SessionRouteError } from "../../../../../interactive-sessions/ui/session-states.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/sessions/profiles")({
  staticData: { breadcrumb: "Profiles" },
  loader: ({ params: { organizationSlug } }) =>
    listSessionProfiles({ data: { organizationSlug, manage: true } }),
  pendingComponent: SessionProfilesLoading,
  errorComponent: SessionRouteError,
  component: SessionProfilesRoute,
});

function SessionProfilesRoute() {
  const { organizationSlug } = Route.useParams();
  return (
    <SessionProfilesPanel
      key={organizationSlug}
      organizationSlug={organizationSlug}
      result={Route.useLoaderData()}
    />
  );
}
