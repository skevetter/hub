import { createFileRoute } from "@tanstack/react-router";
import { AppsPanel } from "../../../../../../provider-applications/panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/instance/apps")({
  staticData: { breadcrumb: "Apps" },
  component: AppsPanel,
});
