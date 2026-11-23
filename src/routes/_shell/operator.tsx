import { createFileRoute } from "@tanstack/react-router";
import { OperatorEntitlementsPage } from "../../operator/panel.js";
import { LegacyInstanceRoute } from "../../shell/legacy-instance-route.js";

export const Route = createFileRoute("/_shell/operator")({
  staticData: { breadcrumb: "Operator" },
  component: LegacyOperator,
});

function LegacyOperator() {
  return (
    <LegacyInstanceRoute to="/o/$organizationSlug/settings/instance/operator">
      <OperatorEntitlementsPage />
    </LegacyInstanceRoute>
  );
}
