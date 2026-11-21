import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactStart from "@tanstack/react-start";
import type * as ProjectContext from "../projects/context.js";
import type * as Queries from "../queries/index.js";
import type * as Functions from "./functions.js";
import { describe, it, vi } from "vitest";
import { summarizeTrigger } from "../projects/activity-summary.js";
import { routeTree } from "../routeTree.gen.js";
import { Route as RootRoute } from "../routes/__root.js";
import { Route as ShellRoute } from "../routes/_shell.js";

const state = vi.hoisted(() => ({
  snapshot: null as Record<string, unknown> | null,
  queryKeys: [] as unknown[],
  intervals: [] as (number | undefined)[],
  refreshFailure: null as { message: string | null } | null,
  failed: false,
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("../projects/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectContext>()),
  useRouteTenant: () => ({ account: { id: "account-1" }, organization: { slug: "acme team" } }),
}));

vi.mock("./functions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Functions>()),
  triggerActivityPage: () => Promise.resolve({ status: "ok", data: state.snapshot }),
}));

vi.mock("../queries/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Queries>()),
  useSnapshotQuery: ({
    queryKey,
    ...options
  }: {
    queryKey: readonly unknown[];
    refetchInterval?: number;
  }) => {
    state.intervals.push(options.refetchInterval);
    state.queryKeys.push(queryKey);
    const data =
      queryKey[0] === "run-detail"
        ? { sequence: 1, value: state.snapshot }
        : { triggers: [], startOffset: 0, ...state.snapshot };
    if (state.failed) return { status: "error", error: "Fixture unavailable" };
    return { status: "success", data, refetch: () => {}, refreshFailure: state.refreshFailure };
  },
}));

async function renderRoute(path: string) {
  const client = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: client },
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
        nextCursor: "older-cursor",
        previousCursor: null,
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
          (key) =>
            JSON.stringify(key) ===
            JSON.stringify(["activity", "acme team", { organizationSlug: "acme team", limit: 15 }]),
        ),
      );

      state.snapshot = {
        activity: [
          {
            id: "late-run",
            triggerName: "Late",
            repo: null,
            provider: "manual",
            source: "manual.run",
            status: "succeeded",
            receivedAt: "2025-12-31T00:00:00.000Z",
          },
        ],
        nextCursor: null,
        previousCursor: "newer-cursor",
      };
      const second = await renderRoute("/o/acme%20team/activity?cursor=older-cursor");
      assert.ok(
        state.queryKeys.some(
          (key) =>
            JSON.stringify(key) ===
            JSON.stringify([
              "activity",
              "acme team",
              { organizationSlug: "acme team", cursor: "older-cursor", limit: 15 },
            ]),
        ),
      );
      assert.equal(state.intervals.at(-1), undefined);
      assert.doesNotMatch(second, /out of date/u);
      state.refreshFailure = { message: "Hub is down" };
      const stale = await renderRoute("/o/acme%20team/activity?cursor=older-cursor");
      assert.match(stale, /Activity may be out of date/u);
      assert.match(stale, /Hub is down/u);
      state.refreshFailure = null;

      state.intervals = [];
      await renderRoute("/o/acme%20team/activity");
      assert.equal(state.intervals.at(-1), 5000);

      state.snapshot = { activity: [], nextCursor: null, previousCursor: null };
      assert.match(await renderRoute("/o/acme%20team/activity"), /No activity/u);
      const filtered = await renderRoute("/o/acme%20team/activity?status=failed&size=25");
      assert.match(filtered, /No runs match these filters/u);
      assert.match(filtered, /Clear filters/u);
      assert.match(filtered, /Rows per page/u);

      state.failed = true;
      assert.match(
        await renderRoute("/o/acme%20team/activity?status=failed"),
        /Activity unavailable/u,
      );
      state.failed = false;

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
      state.failed = false;
      if (rootComponent === undefined) delete RootRoute.options.component;
      else RootRoute.options.component = rootComponent;
      if (shellComponent === undefined) delete ShellRoute.options.component;
      else ShellRoute.options.component = shellComponent;
    }
  });
});
