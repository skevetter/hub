import { createFileRoute } from "@tanstack/react-router";
import { OperatorEntitlementsPage } from "../../../../../../operator/panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/instance/operator")({
  staticData: { breadcrumb: "Operator" },
  component: OperatorEntitlementsPage,
});
