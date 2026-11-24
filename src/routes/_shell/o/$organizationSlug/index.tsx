import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/o/$organizationSlug/")({
  component: OrganizationLanding,
});

function OrganizationLanding() {
  const params = Route.useParams();
  return <Navigate to="/o/$organizationSlug/home" params={params} replace />;
}
