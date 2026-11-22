import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { routeTree } from "../../routeTree.gen.js";
import { Route as RootRoute } from "../../routes/__root.js";
import { Route as ShellRoute } from "../../routes/_shell.js";
import { profileSentence } from "./new-session.js";
import { profileSaveMessage } from "./session-profiles.js";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  profiles: vi.fn(),
  role: "owner",
  enabled: true,
}));

vi.mock("../functions.js", () => ({
  listInteractiveSessions: state.list,
  readInteractiveSession: state.read,
  listSessionProfiles: state.profiles,
  saveSessionProfile: vi.fn(),
}));
vi.mock("../../auth/active-account.js", () => ({
  useActiveAccount: () => ({
    features: state.enabled ? { interactiveSessions: true } : undefined,
    capabilities: { manageResources: state.role !== "member" },
  }),
}));

const rootComponent = RootRoute.options.component;
const shellComponent = ShellRoute.options.component;
const rootNotFound = RootRoute.options.notFoundComponent;
beforeEach(() => {
  RootRoute.options.component = Outlet;
  ShellRoute.options.component = Outlet;
  RootRoute.options.notFoundComponent = () => <p>Unknown route</p>;
  state.list.mockResolvedValue({ status: "ok", data: { sessions: [], nextCursor: null } });
  state.read.mockResolvedValue({ status: "ok", data: { outcome: "refused", code: "not_found" } });
  state.profiles.mockReset().mockImplementation(({ data }: { data: { manage?: boolean } }) =>
    Promise.resolve({
      status: "ok",
      data:
        !state.enabled || (data.manage === true && state.role === "member")
          ? { outcome: "refused", code: "not_found" }
          : [],
    }),
  );
  state.role = "owner";
  state.enabled = true;
});
afterEach(() => {
  if (rootComponent === undefined) delete RootRoute.options.component;
  else RootRoute.options.component = rootComponent;
  if (shellComponent === undefined) delete ShellRoute.options.component;
  else ShellRoute.options.component = shellComponent;
  if (rootNotFound === undefined) delete RootRoute.options.notFoundComponent;
  else RootRoute.options.notFoundComponent = rootNotFound;
});

async function renderRoute(path: string, pending = false) {
  const client = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: client },
  });
  if (pending) {
    const matches = router.matchRoutes(path);
    const match = matches.at(-1);
    const Pending = match && router.looseRoutesById[match.routeId]?.options.pendingComponent;
    return Pending === undefined ? "" : renderToStaticMarkup(<Pending />);
  }
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

it("shows a Sessions empty state with a scoped start link", async () => {
  const html = await renderRoute("/o/acme/sessions");
  expect(html).toContain("No sessions yet");
  expect(html).toContain('href="/o/acme/sessions/new"');
});

it("explains a session and keeps one New session control when the list is empty", async () => {
  for (const search of ["", "?filter=all"]) {
    const html = await renderRoute(`/o/acme/sessions${search}`);
    expect(html).toContain("live conversation with an agent");
    expect(html.match(/href="\/o\/acme\/sessions\/new"/g)).toHaveLength(1);
  }
});

it("keeps the header New session control when sessions exist", async () => {
  state.list.mockResolvedValue({
    status: "ok",
    data: {
      sessions: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          title: "Web workspace",
          state: "running",
          stateReason: null,
          daemon: { slug: "devbox" },
          startedBy: { name: "Ada Park" },
          lastActivityAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    },
  });
  const html = await renderRoute("/o/acme/sessions");
  expect(html.match(/href="\/o\/acme\/sessions\/new"/g)).toHaveLength(1);
  expect(html).toContain("Web workspace");
  expect(html).toContain("Ada Park on devbox");
});

it("shows the list and detail loading states", async () => {
  expect(await renderRoute("/o/acme/sessions", true)).toContain("Loading sessions");
  expect(
    await renderRoute("/o/acme/sessions/00000000-0000-4000-8000-000000000001", true),
  ).toContain("Loading session");
});

it("shows a retryable error on a failed session list request", async () => {
  state.list.mockResolvedValue({
    status: "error",
    error: { message: "Could not load the sessions." },
  });
  const html = await renderRoute("/o/acme/sessions");
  expect(html).toContain("Sessions unavailable");
  expect(html).toContain("Try again");
});

it("uses the same unavailable detail state for a missing or unshared session", async () => {
  const html = await renderRoute("/o/acme/sessions/00000000-0000-4000-8000-000000000001");
  expect(html).toContain("Session unavailable");
  expect(html).toContain("Back to sessions");
});

it.each(["owner", "admin"])(
  "shows profile management and the empty state to an %s",
  async (role) => {
    state.role = role;
    expect(await renderRoute("/o/acme/sessions")).toContain('href="/o/acme/sessions/profiles"');
    expect(await renderRoute("/o/acme/sessions/new")).toContain('href="/o/acme/sessions/profiles"');
    const html = await renderRoute("/o/acme/sessions/profiles");
    expect(html).toContain("No session profiles yet");
    expect(html).toContain("Create a profile");
    expect(state.profiles).toHaveBeenCalledWith({
      data: { organizationSlug: "acme", manage: true },
    });
  },
);

it("keeps profile management out of the member routes", async () => {
  state.role = "member";
  expect(await renderRoute("/o/acme/sessions")).not.toContain('href="/o/acme/sessions/profiles"');
  expect(await renderRoute("/o/acme/sessions/new")).toContain(
    "Ask an organization admin to create a session profile.",
  );
  const html = await renderRoute("/o/acme/sessions/profiles");
  expect(html).toContain("Sessions unavailable");
  expect(html).not.toContain("Create a profile");
});

it("shows no profile management with sessions disabled", async () => {
  state.enabled = false;
  expect(await renderRoute("/o/acme/sessions")).not.toContain('href="/o/acme/sessions/profiles"');
  const html = await renderRoute("/o/acme/sessions/profiles");
  expect(html).toContain("Sessions unavailable");
  expect(html).not.toContain("Create a profile");
});

it("shows loading and a retryable profiles error", async () => {
  expect(await renderRoute("/o/acme/sessions/profiles", true)).toContain(
    "Loading session profiles",
  );
  state.profiles.mockResolvedValue({
    status: "error",
    error: { message: "Profiles could not load." },
  });
  const html = await renderRoute("/o/acme/sessions/profiles");
  expect(html).toContain("Profiles could not load.");
  expect(html).toContain("Try again");
});

it.each([
  ["profile_changed", "This profile changed. Reload the page and try again."],
  ["version_conflict", "This profile changed. Reload the page and try again."],
  ["name_taken", "A profile with this name already exists."],
  ["daemon_unavailable", "The daemon is unavailable. Try again when it reconnects."],
  ["invalid_mode", "The daemon did not accept these provider settings."],
  ["invalid_profile", "Check the profile name and enter an absolute directory on the daemon."],
])("explains the %s save refusal", (code, message) => {
  expect(profileSaveMessage(code)).toBe(message);
});

it("says which daemon, folder and harness a profile uses", () => {
  const profile = { daemonSlug: "devbox", cwd: "/workspace/web", provider: "opencode" };
  expect(profileSentence(profile)).toBe("Runs opencode on devbox in /workspace/web.");
});

it("points a member with no profile at an admin", async () => {
  state.role = "member";
  const html = await renderRoute("/o/acme/sessions/new");
  expect(html).toContain("No active session profiles");
  expect(html).toContain("Ask an organization admin to create a session profile.");
});
