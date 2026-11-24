import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  defaultParseSearch,
  Outlet,
} from "@tanstack/react-router";
import { afterEach, beforeEach, expect, it } from "vitest";
import { routeTree } from "../routeTree.gen.js";
import { Route as RootRoute } from "../routes/__root.js";
import { Route as ShellRoute } from "../routes/_shell.js";

const rootComponent = RootRoute.options.component;
const shellComponent = ShellRoute.options.component;
beforeEach(() => {
  RootRoute.options.component = Outlet;
  ShellRoute.options.component = Outlet;
});
afterEach(() => {
  if (rootComponent === undefined) delete RootRoute.options.component;
  else RootRoute.options.component = rootComponent;
  if (shellComponent === undefined) delete ShellRoute.options.component;
  else ShellRoute.options.component = shellComponent;
});

/** Follows the router's own redirects, as a browser would, and returns where they end. */
async function follow(start: string): Promise<string[]> {
  const visited = [start];
  let path = start;
  for (let hops = 0; hops < 4; hops += 1) {
    const history = createMemoryHistory({ initialEntries: [path] });
    const router = createRouter({
      routeTree,
      history,
      context: { queryClient: new QueryClient(), rawSearch: () => history.location.search },
    });
    await router.load();
    const next = router.state.redirect?.options.href;
    if (next === undefined) return visited;
    path = next;
    visited.push(path);
  }
  throw new Error(`too many redirects from ${start}`);
}

async function settle(start: string): Promise<URL> {
  const visited = await follow(start);
  return new URL(visited.at(-1) ?? start, "http://hub.test");
}

const QUERIES = [
  "q=Sample%20value&extra=1",
  "q=a&q=b&state=enabled",
  "q=a&q=b&q=c",
  "q=a+b&extra=1&extra=2",
  "q=1.0&size=1e1",
  "q=%221.0%22&cursor=00123",
  "provider=github&size=50&cursor=abc%2Bdef&unknown=%E2%9C%93",
  "q=%7B%22a%22%3A1%7D&state=disabled",
  "q&cursor=%27x%27",
];

it.each(QUERIES)("sends a legacy editor link with %s to the same editor state", async (query) => {
  const legacy = await settle(`/o/acme/triggers/t1?${query}`);
  const direct = await settle(`/o/acme/triggers/t1/edit?${query}`);
  expect(legacy.pathname).toBe("/o/acme/triggers/t1/edit");
  expect(defaultParseSearch(legacy.search)).toEqual(defaultParseSearch(direct.search));
  expect(legacy.search).toBe(direct.search);
});

it.each(QUERIES)("keeps the query bytes of a legacy editor link: %s", async (query) => {
  const [, first] = await follow(`/o/acme/triggers/t1?${query}`);
  expect(first).toBe(`/o/acme/triggers/t1/edit?${query}`);
});

it("sends the old create URL to the create editor with its query", async () => {
  const legacy = await settle("/o/acme/triggers/new?provider=slack");
  expect(legacy.pathname).toBe("/o/acme/triggers/new/edit");
  expect(legacy.searchParams.get("provider")).toBe("slack");
});

it("keeps the read view for a trigger link without editor params", async () => {
  const location = await settle("/o/acme/triggers/t1?extra=1");
  expect(location.pathname).toBe("/o/acme/triggers/t1");
});
