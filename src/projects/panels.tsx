import { DaemonsPanel } from "../daemons/account-daemons.js";
import { useRouteTenant } from "./context.js";
export { OrganizationConnectionsPanel } from "../connections/panel.js";

export function OrganizationDaemonsPanel() {
  const tenant = useRouteTenant();
  return (
    <DaemonsPanel
      accountId={tenant.account.id}
      organizationId={tenant.organization.id}
      organizationSlug={tenant.organization.slug}
    />
  );
}
