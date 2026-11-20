import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useActiveAccount } from "../../../../auth/active-account.js";
import { SessionsUnavailable } from "../../../../interactive-sessions/ui/session-states.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/sessions")({
  staticData: { breadcrumb: "Sessions" },
  component: SessionsLayout,
});

function SessionsLayout() {
  const account = useActiveAccount();
  return account.features?.interactiveSessions === true ? <Outlet /> : <SessionsUnavailable />;
}
