import type { CompiledHubConfig } from "../config/compiler.js";
import type { OrganizationTriggerRoute, ProjectTriggerRoute } from "./types.js";

type LinearTriggerRoute = OrganizationTriggerRoute & ProjectTriggerRoute;

export function linearTriggerRoutesLock(organizationId: string): string {
  return JSON.stringify(["linear-trigger-routes", organizationId]);
}

export function linearRoutesForConnection(
  configuration: CompiledHubConfig,
  connectionId: string,
): LinearTriggerRoute[] {
  return configuration.triggers.flatMap(({ on, name, filters }) => {
    if (!on.startsWith("linear.")) return [];
    // A resolved route carries the exact connection chosen at save time.
    if (filters?.connectionId !== undefined) {
      if (filters.connectionId !== connectionId) return [];
    } else if (
      filters?.connection !== undefined ||
      filters?.project !== undefined ||
      filters?.resourceId !== undefined
    ) {
      return [];
    }
    return [
      {
        provider: "linear",
        connectionId,
        resourceId: filters?.resourceId ?? null,
        triggerName: name,
        configuredEventName: on,
      },
    ];
  });
}

export function organizationTriggerRoutesForSave(
  configuration: CompiledHubConfig,
  routes: readonly OrganizationTriggerRoute[],
  linearConnectionIds: readonly string[],
): OrganizationTriggerRoute[] {
  return [
    ...routes.filter(({ provider }) => provider !== "linear"),
    ...linearConnectionIds.flatMap((id) => linearRoutesForConnection(configuration, id)),
  ];
}
