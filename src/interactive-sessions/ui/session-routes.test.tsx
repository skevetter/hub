import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { routeTree } from "../../routeTree.gen.js";
import { Route as RootRoute } from "../../routes/__root.js";
import { Route as ShellRoute } from "../../routes/_shell.js";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
}));

vi.mock("../functions.js", () => ({
  listInteractiveSessions: state.list,
  readInteractiveSession: state.read,
}));
vi.mock("../../auth/active-account.js", () => ({
  useActiveAccount: () => ({ features: { interactiveSessions: true } }),
}));

const rootComponent = RootRoute.options.component;
const shellComponent = ShellRoute.options.component;
const rootNotFound = RootRoute.options.notFoundComponent;
beforeEach(() => {
  RootRoute.options.component = Outlet;
  ShellRoute.options.component = Outlet;
  RootRoute.options.notFoundComponent = () => <p>Unknown route</p>;
  state.list.mockResolvedValue({ status: "ok", data: { sessions: [], nextCursor: null } });
  state.read.mockResolvedValue({ status: "ok", data: { outcome: "refused", code: "not_found" } });
});
afterEach(() => {
  if (rootComponent === undefined) delete RootRoute.options.component;
  else RootRoute.options.component = rootComponent;
  if (shellComponent === undefined) delete ShellRoute.options.component;
  else ShellRoute.options.component = shellComponent;
  if (rootNotFound === undefined) delete RootRoute.options.notFoundComponent;
  else RootRoute.options.notFoundComponent = rootNotFound;
});

async function renderRoute(path: string, pending = false) {
  const client = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: client },
  });
  if (pending) {
    const matches = router.matchRoutes(path);
    const match = matches.at(-1);
    const Pending = match && router.looseRoutesById[match.routeId]?.options.pendingComponent;
    return Pending === undefined ? "" : renderToStaticMarkup(<Pending />);
  }
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

it("shows a Sessions empty state with a scoped start link", async () => {
  const html = await renderRoute("/o/acme/sessions");
  expect(html).toContain("No sessions yet");
  expect(html).toContain('href="/o/acme/sessions/new"');
});

it("shows the list and detail loading states", async () => {
  expect(await renderRoute("/o/acme/sessions", true)).toContain("Loading sessions");
  expect(
    await renderRoute("/o/acme/sessions/00000000-0000-4000-8000-000000000001", true),
  ).toContain("Loading session");
});

it("shows a retryable error on a failed session list request", async () => {
  state.list.mockResolvedValue({
    status: "error",
    error: { message: "Could not load the sessions." },
  });
  const html = await renderRoute("/o/acme/sessions");
  expect(html).toContain("Sessions unavailable");
  expect(html).toContain("Try again");
});

it("uses the same unavailable detail state for a missing or unshared session", async () => {
  const html = await renderRoute("/o/acme/sessions/00000000-0000-4000-8000-000000000001");
  expect(html).toContain("Session unavailable");
  expect(html).toContain("Back to sessions");
});
