import { Navigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { useActiveAccount } from "../auth/active-account.js";

export function LegacyInstanceRoute({
  to,
  children,
}: {
  to:
    | "/o/$organizationSlug/settings/instance/apps"
    | "/o/$organizationSlug/settings/instance/operator";
  children: ReactNode;
}) {
  const { isInstanceOperator, organization } = useActiveAccount();
  const params = useMemo(() => ({ organizationSlug: organization.slug }), [organization.slug]);
  if (!isInstanceOperator) return children;
  return <Navigate to={to} params={params} search hash replace />;
}
