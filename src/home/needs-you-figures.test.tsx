import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type * as Router from "@tanstack/react-router";
import type { ReactNode } from "react";
import type * as ReactStart from "@tanstack/react-start";
import { describe, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen.js";
import type * as Functions from "../triggers/functions.js";
import type { HomeSnapshot } from "./dashboard.js";
import { HomeNeedsYou } from "./needs-you-figures.js";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));
const links = vi.hoisted(
  () => [] as { to: string; search?: Record<string, string>; children: ReactNode }[],
);

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  Link: (props: { to: string; search?: Record<string, string>; children: ReactNode }) => {
    links.push(props);
    return <a href={props.to}>{props.children}</a>;
  },
}));
vi.mock("../triggers/functions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Functions>()),
  triggerActivityPage: () =>
    Promise.resolve({
      status: "ok",
      data: { activity: [], nextCursor: null, previousCursor: null },
    }),
}));

const failing: HomeSnapshot = {
  organization: { id: "org", name: "Acme", slug: "acme" },
  checklistCompletedAt: null,
  appsConfigured: true,
  connections: [],
  daemons: [],
  triggers: [{ id: "deploy", name: "Deploy", event: "manual.run", enabled: true }],
  runs: [],
  runDays: [],
  stoppedTriggers: [],
  triggerRuns: [
    {
      triggerId: "deploy",
      total: 1,
      failed: 1,
      latest: {
        id: "run",
        status: "failed",
        startedAt: "2026-11-24T11:00:00.000Z",
      },
    },
  ],
  sessionStarted: null,
  windowDays: 7,
};

describe("Home Review runs link on the real router", () => {
  it("passes the route and the filter apart, and Activity opens filtered from them", async () => {
    links.length = 0;
    renderToStaticMarkup(<HomeNeedsYou data={failing} base="/o/acme" />);
    const review = links.find(({ children }) => children === "Review runs");
    assert.equal(review?.to, "/o/acme/activity");
    assert.deepEqual(review?.search, { status: "unsuccessful" });

    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/o/acme"] }),
      context: { queryClient: new QueryClient() },
    });
    await router.navigate({
      to: "/o/$organizationSlug/activity",
      params: { organizationSlug: "acme" },
      search: { status: "unsuccessful" },
    });

    assert.equal(router.state.location.pathname, "/o/acme/activity");
    assert.equal(router.state.location.href, "/o/acme/activity?status=unsuccessful");
    assert.equal(router.state.matches.at(-1)?.routeId, "/_shell/o/$organizationSlug/activity/");
  });
});
