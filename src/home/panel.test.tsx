import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ReactStart from "@tanstack/react-start";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, vi } from "vitest";
import type { HomeSnapshot } from "./dashboard.js";
import { HomePanel, runHint } from "./panel.js";

const view = vi.hoisted((): { snapshot?: HomeSnapshot; operator: boolean } => ({
  operator: true,
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("../projects/context.js", () => ({
  useRouteTenant: () => ({ account: { id: "user" }, organization: { id: "org", slug: "acme" } }),
}));
vi.mock("../auth/active-account.js", () => ({
  useActiveAccount: () => ({ isInstanceOperator: view.operator }),
}));
vi.mock("../queries/index.js", () => ({
  useSnapshotQuery: () => ({ status: "success", data: view.snapshot }),
}));

const ready: HomeSnapshot = {
  organization: { id: "org", name: "Acme", slug: "acme" },
  checklistCompletedAt: null,
  appsConfigured: true,
  connections: [{ provider: "slack", slug: "slack", label: "Acme" }],
  daemons: [{ id: "daemon", slug: "daemon", presence: "connected", canExecute: true }],
  triggers: [{ id: "trigger", name: "Deploy", event: "manual.run", enabled: true }],
  runs: [
    {
      id: "run",
      triggerName: "Deploy",
      provider: "manual",
      source: "manual.run",
      status: "succeeded",
      receivedAt: "2026-11-20T00:00:00.000Z",
      agent: null,
    },
  ],
  dropped: [],
  windowDays: 7,
};

function renderHome(snapshot: HomeSnapshot, operator = true) {
  view.snapshot = snapshot;
  view.operator = operator;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <HomePanel />
    </QueryClientProvider>,
  );
}

describe("Home checklist", () => {
  it("shows one Finish setup button after all four steps for an operator", () => {
    const markup = renderHome(ready);
    assert.match(markup, /You are all set/u);
    assert.equal([...markup.matchAll(/<button[^>]*>Finish setup<\/button>/gu)].length, 1);
    assert.doesNotMatch(markup, /Connect an app and a daemon/u);
  });

  it("shows the all-set state without the operator action for an ordinary member", () => {
    const markup = renderHome(ready, false);
    assert.match(markup, /You are all set/u);
    assert.doesNotMatch(markup, /Finish setup/u);
  });

  it("hides the checklist for members even when a derived step regresses", () => {
    const markup = renderHome(
      {
        ...ready,
        checklistCompletedAt: "2026-11-20T00:00:00.000Z",
        connections: [],
      },
      false,
    );
    assert.doesNotMatch(markup, /Get started|You are all set|Finish setup/u);
    assert.match(markup, /Recent runs/u);
  });
});

describe("manual trigger run hint", () => {
  it("names the webhook and manual dispatch endpoints", () => {
    const hint = runHint([
      { id: "manual", name: "build-finished", event: "manual.run", enabled: true },
    ]);
    assert.match(hint, /POST \/api\/v1\/hooks\/\{trigger\}/u);
    assert.match(hint, /POST \/api\/v1\/manual-runs/u);
    assert.match(hint, /API key/u);
  });
});
