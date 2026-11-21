import { createFileRoute } from "@tanstack/react-router";
import { TriggerEditorPanel } from "../../../../../triggers/panel.js";
import { triggerSearchSchema } from "../../../../../triggers/trigger-query.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/triggers/$triggerId")({
  staticData: { breadcrumb: "Trigger editor" },
  validateSearch: triggerSearchSchema,
  component: TriggerEditorRoute,
});

function TriggerEditorRoute() {
  const { triggerId } = Route.useParams();
  return <TriggerEditorPanel triggerId={triggerId} />;
}
