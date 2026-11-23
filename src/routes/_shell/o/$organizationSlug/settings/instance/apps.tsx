import { createFileRoute } from "@tanstack/react-router";
import { useRouteTenant } from "../../../../../../projects/context.js";
import { AppsPanel } from "../../../../../../provider-applications/panel.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/instance/apps")({
  staticData: { breadcrumb: "Apps" },
  component: InstanceApps,
});

function InstanceApps() {
  const { organization } = useRouteTenant();
  return <AppsPanel organizationId={organization.id} />;
}
