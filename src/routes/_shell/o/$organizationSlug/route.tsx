import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  NotFoundPage,
  RouteErrorBoundary,
  useRouteHome,
} from "../../../../components/app/route-state.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug")({
  component: Outlet,
  notFoundComponent: OrganizationNotFound,
  errorComponent: RouteErrorBoundary,
});

function OrganizationNotFound() {
  return <NotFoundPage home={useRouteHome()} />;
}
