import { Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { TabNav, type TabNavItem } from "../components/app/tab-nav.js";
import { billingConfigured } from "../server/capabilities.js";
import { useRouteTenant } from "../projects/context.js";
import { useActiveAccount } from "./active-account.js";

/**
 * Organization administration. Each section keeps its own `<h1>` and actions, so this contributes
 * only the strip that says which sections exist — the sidebar stops at "Settings" and this is
 * where the choice between Team, API keys, Usage, and Billing is made.
 */
export function OrganizationSettingsLayout() {
  const tenant = useRouteTenant();
  const { isInstanceOperator } = useActiveAccount();
  const sections = useOrganizationSettingsItems({
    slug: tenant.organization.slug,
    manageResources: tenant.capabilities.manageResources,
    isInstanceOperator,
  });
  return (
    <>
      <TabNav label="Organization settings" items={sections} />
      <Outlet />
    </>
  );
}

export interface SettingsAccess {
  slug: string;
  manageResources: boolean;
  isInstanceOperator: boolean;
}

export function useOrganizationSettingsItems({
  slug,
  manageResources,
  isInstanceOperator,
}: SettingsAccess) {
  const base = `/o/${slug}/settings`;
  const load = useServerFn(billingConfigured);
  const billing = useQuery({
    queryKey: ["billing-configured"],
    queryFn: () => load(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const billingShown = billing.data?.configured === true;
  return useMemo<TabNavItem[]>(
    () => [
      { to: `${base}/team`, label: "Team" },
      ...(manageResources ? [{ to: `${base}/api-keys`, label: "API keys" }] : []),
      { to: `${base}/usage`, label: "Usage" },
      ...(billingShown ? [{ to: `${base}/billing`, label: "Billing" }] : []),
      ...(isInstanceOperator ? [{ to: `${base}/instance`, label: "Instance", subtree: true }] : []),
    ],
    [base, billingShown, isInstanceOperator, manageResources],
  );
}
