import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyTriggerEditorHref } from "../../../../../../triggers/read-route.js";
import { TriggerReadPanel } from "../../../../../../triggers/read-view.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/triggers/$triggerId/")({
  staticData: { breadcrumb: "Trigger" },
  beforeLoad: ({ location, params }) => {
    const href = legacyTriggerEditorHref(location, params.triggerId);
    if (href !== undefined) redirect({ href, replace: true, throw: true });
  },
  component: TriggerReadRoute,
});

function TriggerReadRoute() {
  const { organizationSlug, triggerId } = Route.useParams();
  return (
    <TriggerReadPanel key={triggerId} organizationSlug={organizationSlug} triggerId={triggerId} />
  );
}
