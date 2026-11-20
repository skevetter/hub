import { createFileRoute } from "@tanstack/react-router";
import { listSessionProfiles } from "../../../../../interactive-sessions/functions.js";
import {
  NewSessionLoading,
  NewSessionPanel,
} from "../../../../../interactive-sessions/ui/new-session.js";
import { SessionRouteError } from "../../../../../interactive-sessions/ui/session-states.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/sessions/new")({
  staticData: { breadcrumb: "New session" },
  loader: ({ params }) => listSessionProfiles({ data: params }),
  pendingComponent: NewSessionLoading,
  errorComponent: SessionRouteError,
  component: NewSessionRoute,
});

function NewSessionRoute() {
  const { organizationSlug } = Route.useParams();
  return (
    <NewSessionPanel
      key={organizationSlug}
      organizationSlug={organizationSlug}
      profiles={Route.useLoaderData()}
    />
  );
}
