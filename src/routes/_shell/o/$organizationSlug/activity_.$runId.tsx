import { createFileRoute } from "@tanstack/react-router";
import { TriggerActivityRunPanel } from "../../../../triggers/activity-run-panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity_/$runId")({
  staticData: { breadcrumb: "Run detail", projectSection: "activity" },
  component: ActivityRunRoute,
});

function ActivityRunRoute() {
  const { runId } = Route.useParams();
  return <TriggerActivityRunPanel runId={runId} />;
}
