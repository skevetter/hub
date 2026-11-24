import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/instance/")({
  component: InstanceLanding,
});

function InstanceLanding() {
  const params = Route.useParams();
  return <Navigate to="/o/$organizationSlug/settings/instance/apps" params={params} replace />;
}
