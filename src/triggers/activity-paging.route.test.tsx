import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type * as ReactStart from "@tanstack/react-start";
import type * as ProjectContext from "../projects/context.js";
import type * as Functions from "./functions.js";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { respondOk } from "../contract/respond.js";
import { routeTree } from "../routeTree.gen.js";
import { Route as RootRoute } from "../routes/__root.js";
import { Route as ShellRoute } from "../routes/_shell.js";
import { dashboardWithRuns } from "../test-utils/activity-dashboard.js";

const state = vi.hoisted(() => ({
  serve: null as null | ((cursor: string | undefined) => Promise<unknown>),
  requests: [] as (string | undefined)[],
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("../projects/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectContext>()),
  useRouteTenant: () => ({ organization: { slug: "acme" } }),
}));

vi.mock("./functions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Functions>()),
  triggerActivityPage: async ({ data }: { data: { cursor?: string } }) => {
    state.requests.push(data.cursor);
    return respondOk(await state.serve!(data.cursor));
  },
}));

const TOTAL = 60;

/** A node router reports a loader redirect where a browser would follow it, so follow it here. */
async function settled(router: AnyRouter) {
  for (let hops = 0; hops < 3 && router.state.redirect !== undefined; hops += 1) {
    await router.navigate({ ...router.state.redirect.options, replace: true });
  }
}

describe("activity paging through the router", () => {
  const originals = {
    root: RootRoute.options.component,
    shell: ShellRoute.options.component,
  };
  beforeEach(() => {
    RootRoute.options.component = Outlet;
    ShellRoute.options.component = Outlet;
    state.requests = [];
  });
  afterEach(() => {
    if (originals.root === undefined) delete RootRoute.options.component;
    else RootRoute.options.component = originals.root;
    if (originals.shell === undefined) delete ShellRoute.options.component;
    else ShellRoute.options.component = originals.shell;
  });

  async function setup() {
    const fixture = await dashboardWithRuns(TOTAL);
    const request = new Request("https://hub.test/o/acme/activity");
    state.serve = (cursor) =>
      fixture.dashboard.activityPage(request, "acme", {
        limit: 25,
        ...(cursor === undefined ? {} : { cursor }),
      });
    return { ...fixture, request };
  }

  async function open(path: string) {
    const client = new QueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
      context: { queryClient: client },
    });
    await router.load();
    await settled(router);
    const render = () =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    /** Follows the link the reader would press, then renders what the router settles on. */
    const follow = async (label: "Newer" | "Older") => {
      const href = linkTo(render(), label);
      assert.ok(href, `${label} should be a link`);
      await router.navigate({ href });
      await settled(router);
      return render();
    };
    return { router, render, follow };
  }

  const linkTo = (html: string, label: string) =>
    new RegExp(`href="([^"]+)"[^>]*>${label}</a>`, "u").exec(html)?.[1]?.replaceAll("&amp;", "&");
  const runIds = (html: string) =>
    [...html.matchAll(/\/activity\/([0-9a-f-]{36})"/gu)].map((match) => match[1]);
  const summary = (html: string) => /Showing[^<]*/u.exec(html)?.[0];

  it("follows Older and Newer across the whole list", async () => {
    const { dashboard, request } = await setup();
    const everything = (await dashboard.activityPage(request, "acme", { limit: 100 })).activity.map(
      ({ id }) => id,
    );
    const { follow, render } = await open("/o/acme/activity");
    const first = render();
    assert.equal(summary(first), "Showing the newest 25 runs");
    assert.deepEqual(runIds(first), everything.slice(0, 25));
    assert.match(first, /<button[^>]*disabled[^>]*>Newer/u);

    const second = await follow("Older");
    assert.equal(summary(second), "Showing 25 runs");
    assert.deepEqual(runIds(second), everything.slice(25, 50));

    const third = await follow("Older");
    assert.equal(summary(third), "Showing 10 runs");
    assert.deepEqual(runIds(third), everything.slice(50));
    assert.match(third, /<button[^>]*disabled[^>]*>Older/u);

    assert.deepEqual(runIds(await follow("Newer")), everything.slice(25, 50));
    const back = await follow("Newer");
    assert.deepEqual(runIds(back), everything.slice(0, 25));
  });

  it("reaches the rows next to page two with Newer after runs were inserted", async () => {
    const { dashboard, request, addRuns } = await setup();
    const before = (await dashboard.activityPage(request, "acme", { limit: 100 })).activity.map(
      ({ id }) => id,
    );
    const { follow, router } = await open("/o/acme/activity");
    const second = await follow("Older");
    assert.deepEqual(runIds(second), before.slice(25, 50));

    await addRuns(5);
    const newer = await follow("Newer");
    assert.deepEqual(runIds(newer), before.slice(0, 25));
    assert.equal(summary(newer), "Showing 25 runs");
    assert.equal(router.state.location.search.cursor !== undefined, true);

    const live = await follow("Newer");
    assert.equal(summary(live), "Showing the newest 25 runs");
    assert.deepEqual({ ...router.state.location.search }, {});
  });

  it("shows the same rows when a page address is reloaded", async () => {
    await setup();
    const { follow, router } = await open("/o/acme/activity");
    const second = await follow("Older");
    const reloaded = await open(router.state.location.href);
    assert.deepEqual(runIds(reloaded.render()), runIds(second));
    assert.equal(summary(reloaded.render()), "Showing 25 runs");
  });

  it("drops a cursor the server could not use and returns to the live first page", async () => {
    const { dashboard, request } = await setup();
    const page = await dashboard.activityPage(request, "acme", {});
    const newest = page.activity.map(({ id }) => id);
    const unusable = [
      "not-a-cursor",
      "a".repeat(600),
      "123",
      `${page.nextCursor}!!`,
      `${page.nextCursor}=`,
    ];
    for (const cursor of unusable) {
      const { router, render } = await open(`/o/acme/activity?cursor=${cursor}`);
      assert.deepEqual({ ...router.state.location.search }, {}, cursor);
      assert.deepEqual(runIds(render()), newest);
      assert.equal(summary(render()), "Showing the newest 25 runs");
    }
  });

  it("ignores a page number in the address", async () => {
    const { dashboard, request } = await setup();
    const newest = (await dashboard.activityPage(request, "acme", {})).activity.map(({ id }) => id);
    const { router, render } = await open("/o/acme/activity?page=2");
    assert.deepEqual({ ...router.state.location.search }, {});
    assert.deepEqual(runIds(render()), newest);
  });

  it("keeps the pager on screen, inert, while the next page loads", async () => {
    await setup();
    const { router, render } = await open("/o/acme/activity");
    const href = linkTo(render(), "Older")!;
    const serve = state.serve!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.serve = async (cursor) => {
      await held;
      return serve(cursor);
    };
    const pending = router.navigate({ href });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const during = render();
    assert.match(during, /<nav[^>]*aria-busy="true"/u);
    assert.match(during, /aria-disabled="true"[^>]*>Older/u);
    assert.equal(summary(during), "Showing the newest 25 runs");
    release();
    await pending;
    assert.match(render(), /<nav[^>]*aria-busy="false"/u);
  });
});
