import { createFileRoute } from "@tanstack/react-router";
import { useActiveAccount } from "../../auth/active-account.js";
import { AppsPanel } from "../../provider-applications/panel.js";
import { LegacyInstanceRoute } from "../../shell/legacy-instance-route.js";

export const Route = createFileRoute("/_shell/apps")({
  staticData: { breadcrumb: "Apps" },
  component: LegacyApps,
});

function LegacyApps() {
  const { organization } = useActiveAccount();
  return (
    <LegacyInstanceRoute to="/o/$organizationSlug/settings/instance/apps">
      <AppsPanel organizationId={organization.id} />
    </LegacyInstanceRoute>
  );
}
