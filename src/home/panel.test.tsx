import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ReactStart from "@tanstack/react-start";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, vi } from "vitest";
import type * as Alerts from "../components/app/failure-alert.js";
import type { Snapshot } from "../queries/index.js";
import type { HomeSnapshot } from "./dashboard.js";
import { HomePanel, runHint } from "./panel.js";

const view = vi.hoisted(
  (): {
    snapshot?: Snapshot<HomeSnapshot>;
    operator: boolean;
    sessionsEnabled: boolean;
    onRetry?: () => void;
    refetch: ReturnType<typeof vi.fn>;
  } => ({
    operator: true,
    sessionsEnabled: false,
    refetch: vi.fn(),
  }),
);

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
  useActiveAccount: () => ({
    isInstanceOperator: view.operator,
    features: view.sessionsEnabled ? { interactiveSessions: true } : undefined,
  }),
}));
vi.mock("../queries/index.js", () => ({
  useSnapshotQuery: () => ({ ...view.snapshot, refetch: view.refetch }),
}));
vi.mock("../interactive-sessions/ui/new-session.js", () => ({ HomeSessionStart: () => null }));
vi.mock("../components/app/failure-alert.js", async (importOriginal) => {
  const alerts = await importOriginal<typeof Alerts>();
  return {
    ...alerts,
    FailureAlert: (props: Parameters<typeof alerts.FailureAlert>[0]) => {
      if (props.onRetry !== undefined) view.onRetry = props.onRetry;
      return <alerts.FailureAlert {...props} />;
    },
  };
});

const ready: HomeSnapshot = {
  organization: { id: "org", name: "Acme", slug: "acme" },
  checklistCompletedAt: null,
  appsConfigured: true,
  connections: [{ provider: "slack", slug: "slack", label: "Acme", needsAuthorization: false }],
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
  runCounts: {
    day: { total: 3, succeeded: 2, failed: 1 },
    month: { total: 41, succeeded: 30, failed: 9 },
  },
  sessions: null,
  dropped: [],
  windowDays: 7,
};
const fresh: HomeSnapshot = {
  ...ready,
  connections: [],
  daemons: [],
  triggers: [],
  runs: [],
  runCounts: {
    day: { total: 0, succeeded: 0, failed: 0 },
    month: { total: 0, succeeded: 0, failed: 0 },
  },
};

/** The text of the tile with this label, as a reader would scan it. */
function tile(markup: string, label: string): string {
  const start = markup.indexOf(`>${label}<`);
  assert.notEqual(start, -1, `no tile labelled ${label}`);
  return markup.slice(start, markup.indexOf("</section>", start)).replaceAll(/<[^>]+>/gu, " ");
}

function renderHome(snapshot: HomeSnapshot, operator = true) {
  return renderHomeQuery({ status: "success", data: snapshot, error: null }, operator);
}

function renderHomeQuery(
  snapshot: Snapshot<HomeSnapshot>,
  operator = true,
  sessionsEnabled = false,
) {
  view.snapshot = snapshot;
  view.operator = operator;
  view.sessionsEnabled = sessionsEnabled;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <HomePanel />
    </QueryClientProvider>,
  );
}

describe("Home query states", () => {
  it("keeps the heading and offers a retry after a failed read", () => {
    const markup = renderHomeQuery({ status: "error", data: undefined, error: null });
    assert.match(markup, /<h1[^>]*>Home<\/h1>/u);
    assert.match(markup, /role="alert"[\s\S]*Home unavailable/u);
    assert.match(markup, /<p>Hub could not load this organization/u);
    assert.match(markup, /<button[^>]*>Try again<\/button>/u);
    assert.doesNotMatch(markup, /Overview/u);
    assert.ok(view.onRetry);
    view.onRetry();
    assert.equal(view.refetch.mock.calls.length, 1);
  });

  it("keeps the Home heading and names its loading state", () => {
    const markup = renderHomeQuery({ status: "pending", data: undefined, error: null });
    assert.match(markup, /<h1[^>]*>Home<\/h1>/u);
    assert.match(markup, /aria-label="Loading Home"/u);
  });
});

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

  it("offers Finish setup alongside unfinished personal steps when sessions are on", () => {
    const markup = renderHome({
      ...ready,
      sessions: { profiles: 0, open: 0, openCapped: false, started: false },
    });
    assert.match(markup, /<button[^>]*>Finish setup<\/button>/u);
    assert.match(markup, /Start a session<span class="sr-only"> To do<\/span>/u);
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

describe("Home figures", () => {
  it("counts runs over 24 hours and 30 days with their outcomes", () => {
    const markup = renderHome(ready);
    assert.match(tile(markup, "Runs, 24 hours"), /3\s+2 succeeded \u00b7 1 failed/u);
    assert.match(tile(markup, "Runs, 30 days"), /41\s+30 succeeded \u00b7 9 failed/u);
  });

  it("counts enabled triggers and says how many are paused", () => {
    const markup = renderHome({
      ...ready,
      triggers: [
        ...ready.triggers,
        { id: "paused", name: "Nightly", event: "schedule.tick", enabled: false },
      ],
    });
    assert.match(tile(markup, "Active triggers"), /1\s+1 paused/u);
  });

  it("shows the reader's open sessions only while sessions are on", () => {
    assert.doesNotMatch(renderHome(ready), /Open sessions/u);
    const markup = renderHome({
      ...ready,
      sessions: { profiles: 1, open: 50, openCapped: true, started: true },
    });
    assert.match(tile(markup, "Open sessions"), /50\+\s+1 profile/u);
  });
});

describe("Home needs attention", () => {
  it("stays silent when nothing needs the reader", () => {
    assert.doesNotMatch(renderHome(ready), /role="alert"/u);
  });

  it("names a connection that needs authorization and links to connections", () => {
    const markup = renderHome({
      ...ready,
      connections: [{ provider: "slack", slug: "slack", label: "Acme", needsAuthorization: true }],
    });
    assert.match(markup, /Slack needs authorization/u);
    assert.match(markup, /Hub cannot use Acme until/u);
    assert.match(markup, /<a href="\/o\/acme\/connections">Open connections<\/a>/u);
  });

  it("warns that work is waiting when every daemon that may run agents is offline", () => {
    const markup = renderHome({
      ...ready,
      daemons: [{ id: "daemon", slug: "devbox", presence: "offline", canExecute: true }],
    });
    assert.match(markup, /Your daemon is offline/u);
    assert.match(markup, /devbox is not connected/u);
    assert.match(markup, /<a href="\/o\/acme\/daemons">View daemons<\/a>/u);
  });

  it("says when no enrolled daemon may run agents and names the other dropped events", () => {
    const markup = renderHome({
      ...ready,
      daemons: [{ id: "daemon", slug: "laptop", presence: "connected", canExecute: false }],
      dropped: [{ provider: "github", reason: "other", count: 1 }],
    });
    assert.match(markup, /No enrolled daemon may run agents yet\./u);
    assert.match(markup, /until one is allowed to run Hub automations/u);
    assert.match(markup, /Hub dropped events for other reasons/u);
  });

  it("does not warn about an offline daemon nothing depends on", () => {
    const markup = renderHome({
      ...ready,
      triggers: [],
      daemons: [{ id: "daemon", slug: "devbox", presence: "offline", canExecute: true }],
    });
    assert.doesNotMatch(markup, /is offline/u);
  });
});

describe("Home getting started", () => {
  it("lists the four automation steps with their progress while sessions are off", () => {
    const markup = renderHome(fresh);
    assert.match(markup, /Getting started/u);
    assert.match(markup, /0 of 4 done/u);
    assert.match(markup, /aria-valuetext="0 of 4 done"/u);
    assert.doesNotMatch(markup, /Create a session profile/u);
  });

  it("adds the session steps, with their links, while sessions are on", () => {
    const markup = renderHome({
      ...fresh,
      sessions: { profiles: 1, open: 0, openCapped: false, started: false },
    });
    assert.match(markup, /1 of 6 done/u);
    assert.match(markup, /Create a session profile<span class="sr-only"> Done<\/span>/u);
    assert.match(markup, /Start a session<span class="sr-only"> To do<\/span>/u);
    assert.match(markup, /<a href="\/o\/acme\/sessions\/new">New session<\/a>/u);
  });

  it("names a connection that needs authorization alongside a healthy connection", () => {
    const markup = renderHome({
      ...fresh,
      connections: [
        ...ready.connections,
        { provider: "slack", slug: "expired", label: "Expired", needsAuthorization: true },
      ],
    });
    assert.match(markup, /Connect an app<span class="sr-only"> Done<\/span>/u);
    assert.match(markup, /Expired needs authorization\./u);
  });
});

describe("Home things to try", () => {
  it("opens on Linear with three prompts and the one thing still missing", () => {
    const markup = renderHome(fresh);
    assert.match(markup, /Things to try/u);
    assert.match(markup, /role="radio" aria-checked="true"[^>]*>(?:<svg.*?<\/svg>)?Linear/u);
    assert.match(markup, /<ul aria-label="Linear examples"/u);
    assert.equal([...markup.matchAll(/Copy the prompt: /gu)].length, 3);
    assert.match(markup, /<a href="\/o\/acme\/connections">Connect Linear<\/a>/u);
  });

  it("offers a Sessions tab only while sessions are on", () => {
    assert.doesNotMatch(renderHome(fresh), />Sessions<\/button>/u);
    const markup = renderHome({
      ...fresh,
      sessions: { profiles: 0, open: 0, openCapped: false, started: false },
    });
    assert.match(markup, /Sessions<\/button>/u);
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
