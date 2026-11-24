import { createContext, useContext } from "react";
import type { ProjectDashboard } from "./dashboard.js";

type TenantContextValue = Awaited<ReturnType<ProjectDashboard["tenantContext"]>>;

export const ProjectTenantContext = createContext<TenantContextValue | null>(null);

export function useOptionalRouteTenant(): TenantContextValue | null {
  return useContext(ProjectTenantContext);
}

export function useRouteTenant(): TenantContextValue {
  const tenant = useOptionalRouteTenant();
  if (tenant === null) throw new Error("useRouteTenant used outside an organization route");
  return tenant;
}
