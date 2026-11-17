import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactStart from "@tanstack/react-start";
import type * as ProjectContext from "../projects/context.js";
import type * as Queries from "../queries/index.js";
import { describe, it, vi } from "vitest";
import { summarizeTrigger } from "../projects/activity-summary.js";
import { routeTree } from "../routeTree.gen.js";
import { Route as RootRoute } from "../routes/__root.js";
import { Route as ShellRoute } from "../routes/_shell.js";

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  queryKeys: [] as unknown[],
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("../projects/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectContext>()),
  useRouteTenant: () => ({ organization: { slug: "acme team" } }),
}));

vi.mock("../queries/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Queries>()),
  useSnapshotQuery: ({ queryKey }: { queryKey: unknown }) => {
    state.queryKeys.push(queryKey);
    return { status: "success", data: state.snapshot, refetch: () => {} };
  },
}));

async function renderRoute(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: new QueryClient() },
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("organization activity routes", () => {
  it("mounts the generated listing and missing-run routes with scoped links and query keys", async () => {
    const rootComponent = RootRoute.options.component;
    const shellComponent = ShellRoute.options.component;
    RootRoute.options.component = Outlet;
    ShellRoute.options.component = Outlet;
    state.queryKeys = [];
    try {
      state.snapshot = {
        activity: [
          {
            id: "run/one",
            triggerName: "Deploy",
            repo: "owner/repo",
            provider: "github",
            source: "push",
            status: "succeeded",
            receivedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "webhook-run",
            triggerName: "build-finished",
            repo: null,
            provider: "manual",
            source: "webhook.received",
            status: "succeeded",
            receivedAt: "2026-01-01T00:01:00.000Z",
            webhookSummary: summarizeTrigger("webhook.received", {
              actor: "ci-partner",
              trigger: "build-finished",
              input: `${"x".repeat(120)}private tail`,
            }),
          },
          {
            id: "manual-run",
            triggerName: "ordinary-manual",
            repo: null,
            provider: "manual",
            source: "manual.run",
            status: "succeeded",
            receivedAt: "2026-01-01T00:02:00.000Z",
          },
        ],
      };
      const listing = await renderRoute("/o/acme%20team/activity");
      assert.match(listing, /href="\/o\/acme%20team\/activity\/run%2Fone"/u);
      assert.match(listing, /Deploy/u);
      assert.match(listing, /Webhook from ci-partner/u);
      assert.match(listing, /build-finished/u);
      assert.match(listing, /lucide-webhook/u);
      assert.match(listing, /x{119}/u);
      assert.doesNotMatch(listing, /x{120}|private tail/u);
      assert.match(listing, /ordinary-manual/u);
      assert.match(listing, /manual.run/u);
      assert.match(listing, /lucide-terminal/u);
      assert.ok(
        state.queryKeys.some(
          (key) => JSON.stringify(key) === JSON.stringify(["triggers", "acme team"]),
        ),
      );

      state.snapshot = null;
      const missing = await renderRoute("/o/acme%20team/activity/missing-run");
      assert.match(missing, /Run unavailable/u);
      assert.match(missing, /This run is unavailable/u);
      assert.match(missing, /href="\/o\/acme%20team\/activity"/u);
      assert.match(missing, /Back to activity/u);
      assert.ok(
        state.queryKeys.some(
          (key) =>
            JSON.stringify(key) === JSON.stringify(["run-detail", "acme team", "missing-run"]),
        ),
      );
    } finally {
      if (rootComponent === undefined) delete RootRoute.options.component;
      else RootRoute.options.component = rootComponent;
      if (shellComponent === undefined) delete ShellRoute.options.component;
      else ShellRoute.options.component = shellComponent;
    }
  });
});
