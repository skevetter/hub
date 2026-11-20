import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { readInteractiveSession } from "../../../../../interactive-sessions/functions.js";
import {
  SessionDetailLoading,
  SessionDetailPanel,
} from "../../../../../interactive-sessions/ui/session-panel.js";
import { SessionRouteError } from "../../../../../interactive-sessions/ui/session-states.js";

const sessionId = z.uuid();

export const Route = createFileRoute("/_shell/o/$organizationSlug/sessions/$sessionId")({
  staticData: { breadcrumb: "Session" },
  loader: ({ params }) =>
    sessionId.safeParse(params.sessionId).success ? readInteractiveSession({ data: params }) : null,
  pendingComponent: SessionDetailLoading,
  errorComponent: SessionRouteError,
  component: SessionDetailRoute,
});

function SessionDetailRoute() {
  const { organizationSlug, sessionId: id } = Route.useParams();
  return (
    <SessionDetailPanel
      key={JSON.stringify([organizationSlug, id])}
      organizationSlug={organizationSlug}
      result={Route.useLoaderData()}
    />
  );
}
