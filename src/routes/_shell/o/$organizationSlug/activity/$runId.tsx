import { createFileRoute } from "@tanstack/react-router";
import { RunDetailPanel } from "../../../../../triggers/run-detail.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/activity/$runId")({
  staticData: { breadcrumb: "Run detail", projectSection: "activity" },
  component: ActivityRunRoute,
});

function ActivityRunRoute() {
  const { runId } = Route.useParams();
  return <RunDetailPanel runId={runId} />;
}
