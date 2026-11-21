import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen.js";
import { Route as RootRoute } from "../routes/__root.js";
import { Route as ShellRoute } from "../routes/_shell.js";
import { triggerSearchSchema } from "./trigger-query.js";

const state = vi.hoisted(() => ({
  failed: false,
  data: { triggers: [], daemons: [], canManage: false, previousCursor: null, nextCursor: null },
}));

vi.mock("@tanstack/react-start", async (original) => ({
  ...(await original<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("../projects/context.js", async (original) => ({
  ...(await original<typeof import("../projects/context.js")>()),
  useRouteTenant: () => ({ account: { id: "fixture" }, organization: { slug: "acme" } }),
}));

vi.mock("./functions.js", async (original) => ({
  ...(await original<typeof import("./functions.js")>()),
  triggerListPage: async () => ({ status: "ok", data: state.data }),
}));

vi.mock("../queries/index.js", async (original) => ({
  ...(await original<typeof import("../queries/index.js")>()),
  useSnapshotQuery: () =>
    state.failed
      ? { status: "error", error: "Fixture unavailable" }
      : { status: "success", data: state.data, refreshFailure: null },
}));

describe("trigger list search", () => {
  it("accepts an explicitly cleared name filter", () => {
    assert.equal(triggerSearchSchema.parse({ q: undefined }).q, undefined);
  });

  it("normalizes filters and bounds literal search text", () => {
    const search = triggerSearchSchema.parse({
      q: "  SAMPLE_%! ",
      provider: "slack",
      state: "enabled",
      size: "50",
    });
    assert.deepEqual(search, { q: "sample_%!", provider: "slack", state: "enabled", size: 50 });
    assert.equal(triggerSearchSchema.parse({ q: 123 }).q, "123");
    const invalid = triggerSearchSchema.parse({
      q: "a".repeat(101),
      size: 16,
      provider: "unknown",
      state: "unknown",
    });
    assert.equal(invalid.q, undefined);
    assert.equal(invalid.size, 15);
    assert.equal(invalid.provider, undefined);
    assert.equal(invalid.state, undefined);
    assert.equal(triggerSearchSchema.parse({ q: "a\u0000b" }).q, undefined);
  });
});

describe("trigger list route", () => {
  const root = RootRoute.options.component;
  const shell = ShellRoute.options.component;

  beforeEach(() => {
    RootRoute.options.component = Outlet;
    ShellRoute.options.component = Outlet;
    state.failed = false;
  });
  afterEach(() => {
    if (root === undefined) delete RootRoute.options.component;
    else RootRoute.options.component = root;
    if (shell === undefined) delete ShellRoute.options.component;
    else ShellRoute.options.component = shell;
  });

  async function render(path: string) {
    const queryClient = new QueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
      context: { queryClient },
    });
    await router.load();
    for (let hop = 0; hop < 3 && router.state.redirect !== undefined; hop += 1) {
      await router.navigate({ ...router.state.redirect.options, replace: true });
    }
    return {
      search: { ...router.state.location.search },
      html: renderToStaticMarkup(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    };
  }

  it("shows a clearable empty filter state and drops an unusable cursor", async () => {
    const { html, search } = await render("/o/acme/triggers?q=absent&size=25&cursor=invalid");
    assert.deepEqual(search, { q: "absent", size: 25 });
    assert.match(html, /No triggers match these filters/u);
    assert.match(html, /Clear filters/u);
    assert.match(html, /<option value="25" selected="">25/u);
    assert.doesNotMatch(html, /<table/u);
  });

  it("distinguishes an unavailable list from a successful empty read", async () => {
    state.failed = true;
    const { html } = await render("/o/acme/triggers?state=disabled");
    assert.match(html, /Triggers unavailable/u);
    assert.doesNotMatch(html, /No triggers match these filters/u);
  });
});
