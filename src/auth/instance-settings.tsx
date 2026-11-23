import { Outlet } from "@tanstack/react-router";
import { useMemo } from "react";
import { FailureAlert } from "../components/app/failure-alert.js";
import { TabNav } from "../components/app/tab-nav.js";
import { usePageContext } from "../navigation/index.js";
import { useRouteTenant } from "../projects/context.js";
import { useActiveAccount } from "./active-account.js";

export function instanceSettingsItems(slug: string) {
  const base = `/o/${slug}/settings/instance`;
  return [
    { to: `${base}/apps`, label: "Apps" },
    { to: `${base}/operator`, label: "Operator" },
  ];
}

export function InstanceSettingsLayout() {
  const account = useActiveAccount();
  const { organization } = useRouteTenant();
  const items = useMemo(() => instanceSettingsItems(organization.slug), [organization.slug]);
  const { breadcrumbs } = usePageContext();
  if (!account.isInstanceOperator) return <InstanceRefusal section={breadcrumbs.at(-1)} />;

  return (
    <>
      <TabNav label="Instance settings" items={items} />
      <Outlet />
    </>
  );
}

function InstanceRefusal({ section }: { section: string | undefined }) {
  const message =
    section === "Operator"
      ? "You don't have operator access."
      : "Only an instance operator can view app setup.";
  return (
    <FailureAlert title="Instance settings unavailable" error={undefined} fallback={message} />
  );
}
