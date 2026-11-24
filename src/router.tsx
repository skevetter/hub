import { createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { PanelSkeleton } from "./components/app/loading.js";
import { RouteErrorBoundary, RouteNotFound } from "./components/app/route-state.js";
import { resetQueriesOnReaderChange } from "./auth/reader-cache.js";
import { routeErrorAdapter } from "./ssr-errors.js";

// Start's own handler passes this option the same way: RouterConstructorOptions omits it although
// the router reads it for both dehydration and hydration.
const SERIALIZATION = { serializationAdapters: [routeErrorAdapter] };

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { networkMode: "always" } },
  });
  if (typeof window !== "undefined") resetQueriesOnReaderChange(queryClient);
  return createRouter({
    routeTree,
    scrollRestoration: true,
    ...SERIALIZATION,
    defaultPendingComponent: () => <PanelSkeleton label="Loading page" />,
    defaultErrorComponent: RouteErrorBoundary,
    defaultNotFoundComponent: RouteNotFound,
    context: { queryClient },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
