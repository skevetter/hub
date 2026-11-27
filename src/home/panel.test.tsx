import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ReactStart from "@tanstack/react-start";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, vi } from "vitest";
import type * as Alerts from "../components/app/failure-alert.js";
import type { Snapshot } from "../queries/index.js";
import type { HomeSnapshot } from "./dashboard.js";
import type { ProfileAvailability } from "./checklist.js";
import { HomePanel, runHint } from "./panel.js";

const view = vi.hoisted(
  (): {
    snapshot?: Snapshot<HomeSnapshot>;
    operator: boolean;
    sessionsEnabled: boolean;
    profiles: ProfileAvailability;
    onRetry?: () => void;
    refetch: ReturnType<typeof vi.fn>;
  } => ({
    operator: true,
    sessionsEnabled: false,
    profiles: 0,
    refetch: vi.fn(),
  }),
);

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStart>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    "aria-label": label,
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
    "aria-label"?: string;
  }) => (
    <a
      href={search === undefined ? to : `${to}?${new URLSearchParams(search).toString()}`}
      {...(label === undefined ? {} : { "aria-label": label })}
    >
      {children}
    </a>
  ),
}));
vi.mock("../projects/context.js", () => ({
  useRouteTenant: () => ({
    account: { id: "user" },
    organization: { id: "org", slug: "acme" },
    capabilities: { manageResources: true },
  }),
}));
vi.mock("../auth/active-account.js", () => ({
  useActiveAccount: () => ({
    account: { id: "user" },
    isInstanceOperator: view.operator,
    features: view.sessionsEnabled ? { interactiveSessions: true } : undefined,
  }),
}));
vi.mock("../queries/index.js", () => ({
  useSnapshotQuery: ({ queryKey }: { queryKey: readonly string[] }) => {
    if (queryKey[0] !== "session-profiles") {
      return { ...view.snapshot, refetch: view.refetch, isFetching: false };
    }
    if (view.profiles === "checking") return { status: "pending" };
    if (view.profiles === "unavailable") return { status: "error" };
    return {
      status: "success",
      data:
        view.profiles === null
          ? { outcome: "refused", code: "not_found" }
          : Array.from({ length: view.profiles }, () => ({ status: "active" })),
    };
  },
}));
vi.mock("../interactive-sessions/ui/new-session.js", () => ({
  sessionProfileQueryOptions: () => ({ queryKey: ["session-profiles"] }),
}));
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

const FIRST_DAY = Date.UTC(2026, 10, 13);

/** Fourteen days ending Nov 26; each entry is [days after the first, total, failed]. */
function runDays(
  totals: readonly [day: number, total: number, failed?: number][],
): HomeSnapshot["runDays"] {
  return Array.from({ length: 14 }, (_, index) => {
    const entry = totals.find(([day]) => day === index);
    return {
      day: new Date(FIRST_DAY + index * 86_400_000).toISOString().slice(0, 10),
      total: entry?.[1] ?? 0,
      failed: entry?.[2] ?? 0,
    };
  });
}

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
  runDays: runDays([[0, 0]]),
  stoppedTriggers: [],
  triggerRuns: [
    {
      triggerId: "trigger",
      total: 3,
      failed: 1,
      latest: { id: "run", status: "succeeded", startedAt: "2026-11-20T00:00:00.000Z" },
    },
  ],
  sessionStarted: null,
  windowDays: 7,
};
const fresh: HomeSnapshot = {
  ...ready,
  connections: [],
  daemons: [],
  triggers: [],
  triggerRuns: [],
  runs: [],
};

/** The text of the figure with this unit, as a reader would scan it. */
function figure(markup: string, unit: string): string {
  const block = markup
    .split('data-slot="figure"')
    .slice(1)
    .find((candidate) => candidate.includes(`>${unit}<`));
  assert.ok(block, `no figure with the unit ${unit}`);
  return block
    .slice(block.indexOf(">") + 1, block.indexOf("</div>"))
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\s([,.])/gu, "$1")
    .replaceAll("&#x27;", "'")
    .trim();
}

function renderHome(snapshot: HomeSnapshot, operator = true, profiles: ProfileAvailability = 0) {
  view.profiles = profiles;
  return renderHomeQuery(
    { status: "success", data: snapshot, error: null },
    operator,
    snapshot.sessionStarted !== null,
  );
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
    assert.match(markup, /role="group"[^>]*aria-busy="true"[^>]*aria-label="Loading Home"/u);
  });

  it("reserves four figures while it loads", () => {
    const markup = renderHomeQuery({ status: "pending", data: undefined, error: null });
    assert.match(markup, /role="group"[^>]*aria-label="Loading overview"/u);
    assert.equal(markup.match(/border-t-2/gu)?.length, 4);
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
      sessionStarted: false,
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
    assert.match(markup, /Needs you/u);
  });
});

const failing: HomeSnapshot = {
  ...ready,
  triggers: [
    { id: "ok", name: "Deploy", event: "manual.run", enabled: true },
    { id: "old", name: "Audit", event: "schedule.tick", enabled: true },
    { id: "new", name: "Triage", event: "github.issue_comment_created", enabled: true },
    { id: "quiet", name: "Nightly", event: "schedule.tick", enabled: false },
  ],
  triggerRuns: [
    {
      triggerId: "ok",
      total: 5,
      failed: 0,
      latest: { id: "ok-run", status: "succeeded", startedAt: "2026-11-24T10:00:00.000Z" },
    },
    {
      triggerId: "old",
      total: 2,
      failed: 2,
      latest: { id: "older", status: "timed_out", startedAt: "2026-11-24T09:00:00.000Z" },
    },
    {
      triggerId: "new",
      total: 1,
      failed: 1,
      latest: { id: "newest", status: "failed", startedAt: "2026-11-24T11:00:00.000Z" },
    },
    { triggerId: "quiet", total: 0, failed: 0, latest: null },
  ],
};

describe("Home needs you", () => {
  it("reads every signal as zero when nothing needs a person", () => {
    const markup = renderHome(ready);
    assert.equal(figure(markup, "triggers failing"), "0 triggers failing Last runs all finished.");
    assert.equal(figure(markup, "apps to authorize"), "0 apps to authorize All apps authorized.");
    assert.equal(figure(markup, "daemons to check"), "0 daemons to check All daemons ready.");
    assert.equal(figure(markup, "stopped matching"), "0 stopped matching All triggers matching.");
    assert.doesNotMatch(markup, /text-attention-text/u);
    assert.doesNotMatch(
      markup.slice(markup.indexOf('aria-label="Needs you"')),
      /<a href="[^"]*"[^>]*>(Review runs|Open connections|View daemons|Open trigger)/u,
    );
  });

  it("counts triggers whose last run did not finish and links to those runs", () => {
    const markup = renderHome(failing);
    assert.equal(figure(markup, "triggers failing"), "2 triggers failing Review runs");
    assert.match(
      markup,
      /<a href="\/o\/acme\/activity\?status=unsuccessful"[^>]*>Review runs<\/a>/u,
    );
    assert.match(markup, /text-attention-text/u);
  });

  it("names the apps that need authorization and links to Connections", () => {
    const markup = renderHome({
      ...ready,
      connections: [
        { provider: "slack", slug: "slack", label: "Acme Slack", needsAuthorization: true },
        { provider: "github", slug: "gh", label: "acme-inc", needsAuthorization: false },
      ],
    });
    assert.equal(
      figure(markup, "app to authorize"),
      "1 app to authorize Acme Slack. Open connections",
    );
    assert.match(markup, /<a href="\/o\/acme\/connections"[^>]*>Open connections<\/a>/u);
  });

  it("counts offline daemons and daemons that cannot run agents, each daemon once", () => {
    const markup = renderHome({
      ...ready,
      daemons: [
        { id: "devbox", slug: "devbox", presence: "offline", canExecute: true },
        { id: "laptop", slug: "laptop", presence: "connected", canExecute: false },
        { id: "both", slug: "both", presence: "offline", canExecute: false },
        { id: "fine", slug: "fine", presence: "connected", canExecute: true },
      ],
    });
    assert.equal(
      figure(markup, "daemons to check"),
      "3 daemons to check 2 offline, 2 cannot run agents. View daemons",
    );
    assert.match(markup, /<a href="\/o\/acme\/daemons"[^>]*>View daemons<\/a>/u);
  });

  it("names a single stopped trigger and links to it", () => {
    const markup = renderHome({
      ...ready,
      stoppedTriggers: [{ id: "triage", name: "Triage", previousMatches: 4 }],
    });
    assert.equal(
      figure(markup, "stopped matching"),
      "1 stopped matching Triage matched 4 the week before and none since. Open trigger",
    );
    assert.match(markup, /<a href="\/o\/acme\/triggers\/triage"[^>]*>Open trigger<\/a>/u);
  });

  it("links several stopped triggers to the trigger list", () => {
    const markup = renderHome({
      ...ready,
      stoppedTriggers: [
        { id: "triage", name: "Triage", previousMatches: 4 },
        { id: "audit", name: "Audit", previousMatches: 2 },
      ],
    });
    assert.equal(
      figure(markup, "stopped matching"),
      "2 stopped matching Triage matched 4 the week before and none since, and 1 more. View triggers",
    );
    assert.match(markup, /<a href="\/o\/acme\/triggers"[^>]*>View triggers<\/a>/u);
  });

  it("drops the trigger list, the Recent runs link and where it runs", () => {
    const markup = renderHome(failing);
    assert.doesNotMatch(markup, /Trigger health|Recent runs|Where it runs|Daemons and apps/u);
    assert.doesNotMatch(markup, /Start a session<\/h2>/u);
  });
});

describe("Home runs", () => {
  const days = runDays([
    [1, 3, 1],
    [3, 5],
  ]);

  it("totals the days and counts the runs that did not finish", () => {
    const markup = renderHome({ ...ready, runDays: days });
    assert.equal(figure(markup, "runs"), "8 runs In 14 days.");
    assert.equal(figure(markup, "did not finish"), "1 did not finish 13% of runs.");
  });

  it("summarizes each day for a reader of the chart", () => {
    const markup = renderHome({ ...ready, runDays: days });
    assert.match(
      markup,
      /role="img" aria-label="Runs per day\. Nov 13: 0 runs, 0 did not finish;/u,
    );
    assert.match(markup, /Nov 14: 3 runs, 1 did not finish;/u);
    assert.match(markup, /Nov 16: 5 runs, 0 did not finish;/u);
    assert.match(markup, /Nov 26: 0 runs, 0 did not finish"/u);
    assert.match(markup, /Peak 5 a day/u);
  });

  it("says there are no runs yet and still draws the baseline", () => {
    const markup = renderHome({ ...ready, runDays: runDays([]) });
    assert.equal(figure(markup, "did not finish"), "0 did not finish No runs yet.");
    assert.match(markup, /Peak 0 a day/u);
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
    const markup = renderHome(
      {
        ...fresh,
        sessionStarted: false,
      },
      true,
      1,
    );
    assert.match(markup, /1 of 6 done/u);
    assert.match(markup, /Create a session profile<span class="sr-only"> Done<\/span>/u);
    assert.match(markup, /Start a session<span class="sr-only"> To do<\/span>/u);
    assert.match(markup, /<a href="\/o\/acme\/sessions\/new">New session<\/a>/u);
  });

  it("shows a checking profile step and omits it when profile access is refused", () => {
    const data = { ...fresh, sessionStarted: false };
    const checking = renderHome(data, true, "checking");
    assert.match(checking, /Create a session profile<span class="sr-only"> Checking profiles/u);
    assert.doesNotMatch(checking, /Create a session profile<span class="sr-only"> To do/u);
    const refused = renderHome(data, true, null);
    assert.doesNotMatch(refused, /Create a session profile|>Sessions<\/button>/u);
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
      sessionStarted: false,
    });
    assert.match(markup, /Sessions<\/button>/u);
  });
});

describe("manual trigger run hint", () => {
  it("does not tell the reader to fire a paused trigger or send an unrelated provider event", () => {
    assert.match(
      runHint([{ id: "paused", name: "run", event: "manual.run", enabled: false }]),
      /Enable a trigger/u,
    );
    assert.doesNotMatch(
      runHint([
        { id: "review", name: "review", event: "github.pull_request_synchronized", enabled: true },
      ]),
      /[Cc]omment on an issue/u,
    );
  });

  it("names the webhook and manual dispatch endpoints", () => {
    const hint = runHint([
      { id: "manual", name: "build-finished", event: "manual.run", enabled: true },
    ]);
    assert.match(hint, /POST \/api\/v1\/hooks\/\{trigger\}/u);
    assert.match(hint, /POST \/api\/v1\/manual-runs/u);
    assert.match(hint, /API key/u);
  });
});
