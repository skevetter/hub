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
    children,
    "aria-label": label,
  }: {
    to: string;
    children: ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={to} {...(label === undefined ? {} : { "aria-label": label })}>
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
  HomeSessionStart: () => null,
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

/** The trigger rows in the order a reader sees them, as their names. */
function triggerNames(markup: string): string[] {
  const list = markup.slice(markup.indexOf('aria-label="Trigger health"'));
  return [...list.slice(0, list.indexOf("</ul>")).matchAll(/triggers\/([^"]+)">([^<]+)</gu)].map(
    (match) => match[2] ?? "",
  );
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

  it("reserves three figures while it loads", () => {
    const markup = renderHomeQuery({ status: "pending", data: undefined, error: null });
    assert.match(markup, /role="group"[^>]*aria-label="Loading overview"/u);
    assert.equal(markup.match(/border-t-2/gu)?.length, 3);
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
    assert.match(markup, /Trigger health/u);
  });
});

describe("Home figures", () => {
  it("counts enabled triggers and says how many are paused and running", () => {
    const markup = renderHome({
      ...ready,
      triggers: [
        ...ready.triggers,
        { id: "paused", name: "Nightly", event: "schedule.tick", enabled: false },
      ],
      triggerRuns: [
        {
          triggerId: "trigger",
          total: 1,
          failed: 0,
          latest: { id: "run", status: "running", startedAt: "2026-11-20T00:00:00.000Z" },
        },
      ],
    });
    assert.equal(figure(markup, "trigger on"), "1 trigger on 1 paused \u00b7 1 running");
  });

  it("says nothing is failing when no trigger's last run failed", () => {
    const markup = renderHome(ready);
    assert.equal(
      figure(markup, "triggers failing"),
      "0 triggers failing No trigger's last run failed.",
    );
    assert.doesNotMatch(markup, /text-attention-text/u);
  });

  it("puts the latest failed run under the failing figure and links to it", () => {
    const markup = renderHome(failing);
    assert.match(
      figure(markup, "triggers failing"),
      /^2 triggers failing Latest: Triage, failed /u,
    );
    assert.match(markup, /<a href="\/o\/acme\/activity\/newest"[^>]*>Triage<\/a>/u);
    assert.match(markup, /aria-label="View latest failed run for Triage"/u);
    assert.match(markup, /text-attention-text/u);
  });

  it("lists every trigger, so none of the failing ones is cut off", () => {
    const ids = Array.from({ length: 12 }, (_, position) => `t${String(position)}`);
    const markup = renderHome({
      ...ready,
      triggers: ids.map((id) => ({ id, name: `name-${id}`, event: "manual.run", enabled: true })),
      triggerRuns: ids.map((triggerId) => ({
        triggerId,
        total: 1,
        failed: 1,
        latest: { id: `run-${triggerId}`, status: "failed", startedAt: "2026-11-20T00:00:00.000Z" },
      })),
    });
    const list = markup.slice(markup.indexOf('aria-label="Trigger health"'));
    assert.equal(list.match(/href="\/o\/acme\/triggers\/t\d+"/gu)?.length, 12);
  });

  it("counts connected daemons and those that cannot run agents", () => {
    const markup = renderHome({
      ...ready,
      daemons: [
        { id: "devbox", slug: "devbox", presence: "offline", canExecute: true },
        { id: "laptop", slug: "laptop", presence: "connected", canExecute: false },
      ],
    });
    assert.equal(
      figure(markup, "daemon connected"),
      "1 daemon connected 2 enrolled \u00b7 1 cannot run agents",
    );
  });

  it("shows the same three figures with sessions on or off", () => {
    const markup = renderHome({ ...ready, sessionStarted: true }, true, 0);
    assert.doesNotMatch(markup, /Open sessions|open now/u);
    for (const unit of ["triggers failing", "trigger on", "daemon connected"])
      assert.equal(figure(markup, unit), figure(renderHome(ready), unit));
    assert.match(markup, /You started or joined a session/u);
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

describe("Home triggers", () => {
  it("lists triggers worst first with the state of each last run", () => {
    const markup = renderHome(failing);
    assert.deepEqual(triggerNames(markup), ["Triage", "Audit", "Deploy", "Nightly"]);
    const list = markup.slice(markup.indexOf('aria-label="Trigger health"'));
    assert.match(list, /Failed<\/span>/u);
    assert.match(list, /Timed out<\/span>/u);
    assert.match(list, /Disabled<\/span>/u);
  });

  it("shows the window's runs and failures, singular and plural", () => {
    const markup = renderHome(failing);
    assert.match(markup, /1 run in 7 days \u00b7 1 failed/u);
    assert.match(markup, /2 runs in 7 days \u00b7 2 failed/u);
    assert.match(markup, /5 runs in 7 days</u);
    assert.match(markup, /No runs in 7 days/u);
  });

  it("links each trigger and names its event beside when it last ran", () => {
    const markup = renderHome(failing);
    assert.match(markup, /<a href="\/o\/acme\/triggers\/new"[^>]*>Triage<\/a>/u);
    assert.match(markup, /GitHub issue comment created[^<]*\u00b7 last run <time/u);
  });

  it.each([
    ["manual.run", "Manual run"],
    ["webhook.received", "Manual run"],
    ["github.issue_created", "GitHub issue created"],
    ["linear.comment", "Linear comment created"],
    ["linear.issue", "Linear issue event"],
    ["external.unknown", "external.unknown"],
  ])("labels a trigger's event %s as %s", (event, label) => {
    const markup = renderHome({
      ...ready,
      triggers: [{ id: "trigger", name: "Deploy", event, enabled: true }],
    });
    const list = markup.slice(markup.indexOf('aria-label="Trigger health"'));
    assert.equal(/>([^<>]+) \u00b7 last run <time\b/u.exec(list)?.[1], label);
  });

  it("offers View all, and a first trigger when there is none", () => {
    assert.match(renderHome(ready), /<a href="\/o\/acme\/triggers">View all<\/a>/u);
    const markup = renderHome(fresh);
    assert.match(markup, /No triggers yet/u);
    assert.match(markup, /<a href="\/o\/acme\/triggers\/new\/edit">Create a trigger<\/a>/u);
  });

  it("keeps the run list off Home and leaves one link to Activity under the triggers", () => {
    const markup = renderHome(failing);
    assert.doesNotMatch(markup, /aria-label="Recent runs"/u);
    assert.equal(markup.match(/<a href="\/o\/acme\/activity">Recent runs<\/a>/gu)?.length, 1);
    const list = markup.indexOf('aria-label="Trigger health"');
    assert.ok(list > -1);
    assert.ok(markup.indexOf(">Recent runs<") > list);
  });

  it("offers no Activity link before there is a trigger", () => {
    assert.doesNotMatch(renderHome(fresh), /Recent runs/u);
  });
});

describe("Home where it runs", () => {
  it("lists daemons and apps with a state each", () => {
    const markup = renderHome({
      ...ready,
      connections: [
        { provider: "slack", slug: "slack", label: "Acme Slack", needsAuthorization: true },
        { provider: "github", slug: "gh", label: "acme-inc", needsAuthorization: false },
      ],
      daemons: [
        { id: "devbox", slug: "devbox", presence: "offline", canExecute: true },
        { id: "laptop", slug: "laptop", presence: "connected", canExecute: false },
      ],
    });
    const list = markup.slice(markup.indexOf('aria-label="Daemons and apps"'));
    assert.match(list, /Offline[\s\S]*devbox[\s\S]*Daemon/u);
    assert.match(list, /Cannot run agents[\s\S]*laptop/u);
    assert.match(list, /Needs authorization[\s\S]*Acme Slack[\s\S]*Slack/u);
    assert.match(list, /Connected[\s\S]*acme-inc[\s\S]*GitHub/u);
  });

  it("says nothing is connected on a fresh organization", () => {
    assert.match(renderHome(fresh), /Nothing connected yet/u);
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
