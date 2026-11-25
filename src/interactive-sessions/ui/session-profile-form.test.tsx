import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ReactStartModule from "@tanstack/react-start";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { respondOk } from "../../contract/respond.js";
import { HubHarness } from "../../daemons/test-utils/hub-harness.js";
import type { HubProviderSnapshot } from "../../hub/protocol.js";
import { getApplication } from "../../server/runtime.js";
import type { ProfileView } from "../functions.js";
import { SessionProfileForm } from "./session-profile-form.js";

const { loadProviders } = vi.hoisted(() => ({ loadProviders: vi.fn() }));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactStartModule>()),
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("../../auth/active-account.js", () => ({
  useActiveAccount: () => ({ account: { id: "account" } }),
}));
vi.mock("../../components/app/form-dialog.js", () => ({
  FormDialog: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../daemons/functions.js", () => ({
  daemonList: vi.fn(),
  daemonProviderSnapshot: loadProviders,
}));

const cwd = "/workspace/cold";
const loading = { provider: "codex", status: "loading", enabled: true } as const;
const ready = { ...loading, status: "ready" } as const;
const unavailable = { ...loading, status: "unavailable" } as const;
const warning = "No providers available";
const loadingMessage = "Loading provider settings...";

let harness: HubHarness;
let daemonId: string;
let client: QueryClient;
let profile: ProfileView;
let entries: HubProviderSnapshot["entries"][] = [];

beforeAll(async () => {
  harness = await HubHarness.start();
  daemonId = await harness.connectDaemon(undefined, ["hub.execute"], () =>
    entries.length > 1 ? (entries.shift() ?? []) : (entries[0] ?? []),
  );
  const connection = (await getApplication()).hub.connectionForDaemon(daemonId);
  if (connection === undefined) throw new Error("Missing daemon connection");
  loadProviders.mockImplementation(async ({ data }: { data: { cwd: string } }) =>
    respondOk(await connection.getProviderSnapshot({ cwd: data.cwd })),
  );
  profile = {
    id: "profile",
    version: 1,
    daemonSlug: "devbox",
    daemonId,
    cwd,
    name: "Cold directory",
    worktree: null,
    provider: "codex",
    model: null,
    mode: null,
    thinkingOptionId: null,
    fullAccessAcknowledged: false,
    status: "active",
  };
}, 120_000);

afterAll(async () => {
  await harness?.stop();
});

beforeEach(() => {
  vi.useFakeTimers();
  loadProviders.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["session-profile-daemons", "acme", "account"], {
    daemons: [
      {
        id: daemonId,
        slug: "devbox",
        status: "active",
        presence: "connected",
        permissions: ["hub.execute"],
      },
    ],
  });
});

afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

function renderForm() {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SessionProfileForm
        organizationSlug="acme"
        profile={profile}
        busy={false}
        close={vi.fn()}
        save={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function catalogQuery() {
  renderForm();
  const query = client.getQueryCache().find({
    queryKey: ["session-profile-catalog", "acme", "account", daemonId, cwd],
  });
  if (query === undefined) throw new Error("Missing profile catalog query");
  return query;
}

it("groups profile settings and explains the controls", () => {
  const html = renderForm();
  expect(html).toContain(">Where it runs</h2>");
  expect(html).toContain(">Agent settings</h2>");
  expect(html).toContain("An absolute folder on the daemon. The agent starts here.");
  expect(html).toContain("Controls the agent&#x27;s permission mode.");
  expect(html).toContain("Choose a thinking setting if the model supports one.");
});

async function awaitRead(count: number) {
  expect(loadProviders).toHaveBeenCalledTimes(count);
  await loadProviders.mock.results[count - 1]?.value;
}

it("shows loading between reads and stops polling when a provider becomes ready", async () => {
  entries = [[loading], [ready, { ...loading, provider: "claude" }]];
  const request = catalogQuery().fetch();
  await awaitRead(1);
  const html = renderForm();
  expect(html).toContain(loadingMessage);
  expect(html).not.toContain(warning);
  await vi.advanceTimersByTimeAsync(1999);
  expect(loadProviders).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await awaitRead(2);
  await expect(request).resolves.toMatchObject({ entries: [ready, { provider: "claude" }] });
  expect(renderForm()).not.toContain(loadingMessage);
  expect(renderForm()).not.toContain(warning);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(loadProviders).toHaveBeenCalledTimes(2);
});

it("warns immediately if all providers are unavailable", async () => {
  entries = [[unavailable, { ...unavailable, provider: "claude" }]];
  await catalogQuery().fetch();
  const html = renderForm();
  expect(html).toContain(warning);
  expect(html).not.toContain(loadingMessage);
  expect(html).not.toContain(">Retry</button>");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(loadProviders).toHaveBeenCalledTimes(1);
});

it("stops polling after 30 seconds and offers a retry", async () => {
  entries = [[loading]];
  const query = catalogQuery();
  const request = query.fetch();
  await awaitRead(1);
  for (let read = 2; read <= 15; read++) {
    await vi.advanceTimersByTimeAsync(2000);
    await awaitRead(read);
  }
  await vi.advanceTimersByTimeAsync(1999);
  expect(renderForm()).toContain(loadingMessage);
  await vi.advanceTimersByTimeAsync(1);
  await request;
  const html = renderForm();
  expect(html).toContain(warning);
  expect(html).toContain(">Retry</button>");
  expect(html).not.toContain(loadingMessage);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(loadProviders).toHaveBeenCalledTimes(15);

  entries = [[loading], [ready]];
  const retry = query.fetch();
  await awaitRead(16);
  await vi.advanceTimersByTimeAsync(2000);
  await awaitRead(17);
  await expect(retry).resolves.toMatchObject({ entries: [ready] });
  expect(renderForm()).not.toContain(warning);
});
