import { useMatches } from "@tanstack/react-router";

import { deepestDestination, type NavigationDestination } from "./destination.js";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    breadcrumb?: string;
    tabs?: boolean;
    projectSection?: "overview" | "configuration" | "activity" | "settings";
  }
}

/** A breadcrumb names a route in the presented tree and says where that route lives. */
export interface Crumb {
  label: string;
  to: string;
}

/** Shared layout context comes from the routes TanStack is presenting, including pending UI. */
export function usePageContext() {
  return useMatches({
    select: (matches) => ({
      breadcrumbs: matches.flatMap(({ staticData, pathname }): Crumb[] =>
        staticData.breadcrumb === undefined ? [] : [{ label: staticData.breadcrumb, to: pathname }],
      ),
      tabs: matches.some(({ staticData }) => staticData.tabs === true),
      projectSection:
        matches
          .flatMap(({ staticData }) =>
            staticData.projectSection === undefined ? [] : [staticData.projectSection],
          )
          .at(-1) ?? "overview",
    }),
    structuralSharing: true,
  });
}

/** Parameters are already decoded by the router; never reconstruct tenant identity from a URL. */
export function usePresentedTenantScope():
  | { organizationSlug: string; projectSlug?: string }
  | undefined {
  return useMatches({
    select: (matches) => {
      const params = matches.at(-1)?.params;
      return params !== undefined && "organizationSlug" in params
        ? { organizationSlug: params.organizationSlug }
        : undefined;
    },
    structuralSharing: true,
  });
}

/** Links reflect the presented route tree, rather than the URL of an unfinished navigation. */
export function useActiveDestination(
  destinations: readonly NavigationDestination[],
): string | undefined {
  return useMatches({
    select: (matches) =>
      deepestDestination(
        destinations,
        matches.map((match) => match.pathname),
      ),
  });
}
