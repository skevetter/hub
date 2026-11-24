import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RouteErrorBoundary, RouteNotFound } from "../../../../components/app/route-state.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug")({
  component: Outlet,
  notFoundComponent: RouteNotFound,
  errorComponent: RouteErrorBoundary,
});
