import { createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { PanelSkeleton } from "./components/app/loading.js";
import { RouteErrorBoundary, RouteNotFound } from "./components/app/route-state.js";
import { resetQueriesOnReaderChange } from "./auth/reader-cache.js";
import { installRouteErrorGuard, routeErrorAdapter } from "./ssr-errors.js";

// Start's own handler passes this option the same way: RouterConstructorOptions omits it although
// the router reads it for both dehydration and hydration.
const SERIALIZATION = { serializationAdapters: [routeErrorAdapter] };

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { networkMode: "always" } },
  });
  if (typeof window !== "undefined") resetQueriesOnReaderChange(queryClient);
  const current: { router?: { history: { location: { search: string } } } } = {};
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    ...SERIALIZATION,
    defaultPendingComponent: () => <PanelSkeleton label="Loading page" />,
    defaultErrorComponent: RouteErrorBoundary,
    defaultNotFoundComponent: RouteNotFound,
    // The router re-serialises the query it parses; this keeps the bytes the visitor sent.
    context: { queryClient, rawSearch: () => current.router?.history.location.search ?? "" },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  current.router = router;
  installRouteErrorGuard(router);
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
