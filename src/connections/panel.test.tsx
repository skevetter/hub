import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ReactStart from "@tanstack/react-start";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrganizationConnectionsPanel } from "../projects/panels.js";
import type { ConnectionStatus } from "./functions.js";

const view = vi.hoisted(
  (): { snapshot?: unknown; status?: ConnectionStatus; operator?: boolean } => ({}),
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
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
  }) => <a href={search === undefined ? to : `${to}?${new URLSearchParams(search)}`}>{children}</a>,
}));
vi.mock("../projects/context.js", () => ({
  useRouteTenant: () => ({ account: { id: "user" }, organization: { id: "org", slug: "acme" } }),
}));
vi.mock("../auth/active-account.js", () => ({
  useActiveAccount: () => ({ isInstanceOperator: view.operator }),
}));
vi.mock("../queries/index.js", () => ({
  useSnapshotQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const data = queryKey[0] === "connection-status" ? view.status : view.snapshot;
    return data === undefined ? { status: "pending" } : { status: "success", data };
  },
}));

const noApps: ConnectionStatus = {
  canManage: true,
  linear: { status: "notConfigured" },
  github: { status: "notConfigured" },
  slack: { status: "notConfigured" },
  discord: { status: "notConfigured" },
};

const github = {
  id: "github-1",
  slug: "github-acme",
  accountLogin: "acme",
  installationId: 123,
  status: "active",
};
const linear = {
  id: "linear-1",
  slug: "linear-acme",
  linearOrganizationId: "W-ACME",
  linearOrganizationName: "Acme Workspace",
  grantedAccess: ["read workspace data", "post comments"],
  requiresReauthorization: true,
};
const connections = { github: [github], linear: [linear], slack: [], discord: [] };
const empty = { github: [], linear: [], slack: [], discord: [] };

function renderPanel({
  manage = true,
  operator = false,
  status = noApps,
  records = empty,
  pending = false,
}: {
  manage?: boolean;
  operator?: boolean;
  status?: ConnectionStatus;
  records?: typeof connections;
  pending?: boolean;
} = {}) {
  view.operator = operator;
  view.status = status;
  view.snapshot = pending
    ? undefined
    : {
        capabilities: { manageResources: manage },
        connections: records,
        droppedConnectionEvents: { linear: 2, github: 0, slack: 0, discord: 0 },
      };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <OrganizationConnectionsPanel />
    </QueryClientProvider>,
  );
}

function card(markup: string, name: string): string {
  const start = markup.indexOf(`aria-label="${name}"`);
  expect(start).toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf("</section>", start));
}

describe("Connections cards", () => {
  it("shows one Connected pill, installation name and row actions for a manager", () => {
    const markup = renderPanel({
      records: connections,
      status: { ...noApps, github: { status: "connected" } },
    });
    const rendered = card(markup, "GitHub");
    expect(rendered.match(/>Connected</gu)).toHaveLength(1);
    expect(rendered).toContain(">acme</span>");
    expect(rendered).toMatch(/font-mono[^>]*>installation 123</u);
    expect(rendered).toContain("Connect GitHub");
    expect(rendered).toContain("Actions for acme");
    expect(rendered).not.toContain("dropped events in the last 7 days");
  });

  it("shows reauthorization, named workspace, access and filtered dropped events on Linear", () => {
    const markup = renderPanel({
      records: connections,
      status: { ...noApps, linear: { status: "requiresReauthorization" } },
    });
    const rendered = card(markup, "Linear");
    expect(rendered.match(/>Needs authorization</gu)).toHaveLength(1);
    expect(rendered).toContain("Acme Workspace");
    expect(rendered).toContain("Reauthorize Linear");
    expect(rendered).toContain("read workspace data");
    expect(rendered).toContain("post comments");
    expect(rendered).toContain("2 dropped events in the last 7 days");
    expect(rendered).toMatch(/href="[^"]*view=dropped&amp;range=7d&amp;provider=linear"/u);
    expect(rendered).toContain("stay dropped after reconnecting");
  });

  it("shows a suspended installation as needing authorization with a Reconnect action", () => {
    const markup = renderPanel({
      records: { ...connections, github: [{ ...github, status: "suspended" }] },
      status: { ...noApps, github: { status: "suspended" } },
    });
    const rendered = card(markup, "GitHub");
    expect(rendered.match(/>Needs authorization</gu)).toHaveLength(1);
    expect(rendered).toContain("Reconnect GitHub");
  });

  it("offers a manager Connect for a configured app while hiding instance setup", () => {
    const markup = renderPanel({ status: { ...noApps, discord: { status: "disconnected" } } });
    expect(markup.match(/>Not set up</gu)).toHaveLength(4);
    expect(card(markup, "Discord")).toContain("Connect Discord");
    expect(card(markup, "Linear")).not.toMatch(/Set up the Linear app|Connect Linear/u);
  });

  it("offers an operator the app setup link when the instance app is missing", () => {
    const rendered = card(renderPanel({ operator: true }), "Linear");
    expect(rendered).toContain(">Not set up<");
    expect(rendered).toContain('href="/apps">Set up the Linear app');
  });

  it("shows all four cards in order without management actions for a member", () => {
    const markup = renderPanel({
      manage: false,
      operator: true,
      records: connections,
      status: { ...noApps, canManage: false, github: { status: "connected" } },
    });
    expect(markup).toMatch(
      /aria-label="Linear".*aria-label="GitHub".*aria-label="Slack".*aria-label="Discord"/u,
    );
    expect(card(markup, "GitHub")).toContain(">Connected<");
    expect(markup.match(/>Not set up</gu)).toHaveLength(3);
    expect(markup).not.toMatch(/<button|Set up the .* app/u);
  });

  it("says why a provider with no instance app cannot be connected yet", () => {
    const rendered = card(renderPanel(), "Linear");
    expect(rendered).toContain("This Hub has no Linear app yet.");
    expect(rendered).toContain("An instance operator sets one up before anyone can connect.");
    const operator = card(renderPanel({ operator: true }), "Linear");
    expect(operator).toContain("This Hub has no Linear app yet.");
    expect(operator).not.toContain("An instance operator sets one up");
  });

  it("tells a member without management rights who can connect a configured provider", () => {
    const markup = renderPanel({
      manage: false,
      status: { ...noApps, canManage: false, discord: { status: "disconnected" } },
    });
    expect(card(markup, "Discord")).toContain(
      "Someone who manages this organization can connect Discord.",
    );
    expect(card(markup, "Discord")).not.toContain("<button");
  });

  it("keeps four loading boxes", () => {
    const markup = renderPanel({ pending: true });
    expect(markup.match(/aria-busy="true"/gu)).toHaveLength(4);
    expect(markup).toMatch(/sm:grid-cols-2/u);
  });
});
