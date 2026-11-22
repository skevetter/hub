import { createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { PanelSkeleton } from "./components/app/loading.js";
import { resetQueriesOnReaderChange } from "./auth/reader-cache.js";

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { networkMode: "always" } },
  });
  if (typeof window !== "undefined") resetQueriesOnReaderChange(queryClient);
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPendingComponent: () => <PanelSkeleton label="Loading page" />,
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
