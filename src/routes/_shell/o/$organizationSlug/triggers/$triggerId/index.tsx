import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyTriggerEditorHref } from "../../../../../../triggers/read-route.js";
import { TriggerReadPanel } from "../../../../../../triggers/read-view.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/triggers/$triggerId/")({
  staticData: { breadcrumb: "Trigger" },
  beforeLoad: ({ context, location, params }) => {
    const searchStr = context.rawSearch?.() ?? location.searchStr;
    const href = legacyTriggerEditorHref(
      { pathname: location.pathname, searchStr },
      params.triggerId,
    );
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
