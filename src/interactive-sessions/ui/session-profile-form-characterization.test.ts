import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProfileView } from "../functions.js";

const catalog = vi.hoisted(() => ({ entries: [] as unknown[], available: true }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("../../auth/active-account.js", () => ({
  useActiveAccount: () => ({ account: { id: "account" } }),
}));
vi.mock("../../components/app/form-dialog.js", () => ({
  FormDialog: ({
    title,
    submitLabel,
    children,
  }: {
    title: string;
    submitLabel: string;
    children: ReactNode;
  }) => createElement("form", { "data-title": title, "data-submit-label": submitLabel }, children),
}));
vi.mock("../../daemons/functions.js", () => ({
  daemonList: vi.fn(),
  daemonProviderSnapshot: vi.fn(),
}));
vi.mock("../../queries/index.js", () => ({
  useSnapshotQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data:
      queryKey[0] === "session-profile-daemons"
        ? {
            daemons: catalog.available
              ? [
                  {
                    id: "daemon",
                    slug: "devbox",
                    status: "active",
                    presence: "connected",
                    permissions: ["hub.execute"],
                  },
                ]
              : [],
          }
        : { entries: catalog.entries },
    status: "success",
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

const profile: ProfileView = {
  id: "profile",
  version: 2,
  name: "Example profile",
  daemonId: "daemon",
  daemonSlug: "devbox",
  cwd: "/repo",
  worktree: { mode: "branch-off", base: "main" },
  provider: "omp",
  model: "example",
  mode: "full",
  thinkingOptionId: "deep",
  fullAccessAcknowledged: true,
  status: "disabled",
};

interface FixtureFormProps {
  organizationSlug: string;
  profile: ProfileView | null;
  busy: boolean;
  close: () => void;
  save: () => Promise<string | null>;
}

function isProfileModule(
  value: unknown,
): value is { SessionProfileForm: ComponentType<FixtureFormProps> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "SessionProfileForm" in value &&
    typeof value.SessionProfileForm === "function"
  );
}

async function render(initialProfile: ProfileView | null, busy = false) {
  const path = "./session-profile-form.tsx";
  const module: unknown = await import(path);
  if (!isProfileModule(module)) throw new Error("Missing profile form");
  return renderToStaticMarkup(
    createElement(module.SessionProfileForm, {
      organizationSlug: "org",
      profile: initialProfile,
      busy,
      close: vi.fn(),
      save: vi.fn(),
    }),
  );
}

describe("session profile form defaults and controls", () => {
  it("keeps create defaults and section order when no daemon has been selected", async () => {
    catalog.available = false;
    const markup = await render(null);
    expect(markup).toContain('data-title="Create a profile"');
    expect(markup).toContain('data-submit-label="Create profile"');
    expect(markup.indexOf("Where it runs")).toBeLessThan(markup.indexOf("Agent settings"));
    expect(markup).toContain("Use a new branch per session");
    expect(markup).not.toContain("Base branch");
    expect(markup).not.toContain("Run every tool without asking");
    expect(markup).not.toContain("No providers available");
  });

  it("keeps the existing branch, mode and acknowledgement when editing", async () => {
    catalog.available = true;
    catalog.entries = [
      {
        provider: "omp",
        label: "OMP",
        status: "ready",
        enabled: true,
        defaultModeId: "full",
        modes: [{ id: "full", label: "Full" }],
        models: [
          { id: "example", label: "Example", thinkingOptions: [{ id: "deep", label: "Deep" }] },
        ],
      },
      { provider: "codex", status: "loading", enabled: true },
    ];
    const markup = await render(profile, true);
    expect(markup).toContain('data-title="Edit profile"');
    expect(markup).toContain('data-submit-label="Save changes"');
    expect(markup).toContain('value="Example profile"');
    expect(markup).toContain('value="main"');
    expect(markup).toContain("The agent can run tools without asking for permission.");
    expect(markup).toContain("Run every tool without asking");
    expect(markup).not.toContain("No providers available");
  });
});
