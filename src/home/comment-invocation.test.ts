import assert from "node:assert/strict";
import { it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import { createMemoryDatabase } from "../db/memory.js";
import { LINEAR_REQUIRED_SCOPES } from "../providers/linear/client.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { matchGitHubInvocations } from "../triggers/github/match.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { HomeDashboard } from "./dashboard.js";
import type { HomeSnapshot } from "./functions.js";
import { thingsToTry, type TrySurface } from "./things-to-try.js";

const cases = [
  [
    "input choices",
    'filters: { from_users: ["*"], pattern: "/paseo", contains: "count=1" }',
    "inputs:\n  count: { type: number, choices: [10] }",
    false,
  ],
  [
    "required input",
    'filters: { from_users: ["*"], pattern: "/paseo" }',
    "inputs:\n  count: { type: number, required: true }",
    false,
  ],
  ["plain prefix", 'filters: { from_users: ["*"], pattern: "/paseo" }', "", true],
  ["no text filters", 'filters: { from_users: ["*"] }', "", true],
  ["no filters", "", "", false],
  ["Linear before GitHub", 'filters: { from_users: ["*"], pattern: "/paseo" }', "", true, "first"],
  ["GitHub before Linear", 'filters: { from_users: ["*"], pattern: "/paseo" }', "", true, "last"],
] as const;

it.each(
  cases.map(([kind, filters, inputs, ready, linearPlacement]) => ({
    kind,
    filters,
    inputs,
    ready,
    linearPlacement,
  })),
)(
  "checks every offered comment against the real invocation for $kind",
  async ({ kind, filters, inputs, ready, linearPlacement }) => {
    const organizationId = "org-1";
    const userId = "user-1";
    const connectionId = "github-1";
    const db = createMemoryDatabase({
      memberships: [
        {
          userId,
          organizationId,
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "owner",
        },
      ],
      linearConnections: [
        {
          id: "linear",
          organizationId,
          slug: "linear",
          providerApplicationId: null,
          linearOrganizationId: "linear-org",
          linearOrganizationName: "Acme Linear",
          appUserId: "linear-app",
          accessToken: "fixture-only",
          refreshToken: null,
          accessTokenExpiresAt: null,
          scopes: [...LINEAR_REQUIRED_SCOPES],
        },
      ],
      githubConnections: [
        {
          id: connectionId,
          organizationId,
          slug: "fixture",
          installationId: 42,
          accountId: "7",
          accountLogin: "Fixture",
          accountType: "Organization",
          status: "active",
          providerApplicationId: null,
        },
      ],
    });
    await enrollTestDaemon(db, organizationId);
    const store = new OrganizationTriggerStore(db, organizationId, acceptingAgentValidator());
    const github = `  github.pull_request_comment_created: ${filters === "" ? "{}" : `\n    ${filters}`}`;
    const linear =
      '  linear.comment_created:\n    filters: { from_users: ["linear-person"], pattern: "/linear" }';
    const events = [
      linearPlacement === "first" && linear,
      github,
      linearPlacement === "last" && linear,
    ]
      .filter(Boolean)
      .join("\n");
    const yaml = `
name: review
on:
${events}
${inputs}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /repo }
  agent: { provider: codex, model: gpt-5.4, mode: full-access }
  prompt: Review this.
`;
    const auth: AuthServer = {
      handle: vi.fn(),
      resources: vi.fn(),
      resolveOrganizationAccess: vi.fn(),
      resolveAccount: async () => ({
        session: { id: "session-1", activeOrganizationId: organizationId },
        account: { id: userId, name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
      rejectCookieMutation: vi.fn(),
      close: vi.fn(),
    };
    const dashboard = new HomeDashboard(db, auth, () => true);
    const request = new Request("https://hub.test/o/acme/home");
    if (filters === "") {
      await assert.rejects(store.save({ userId, yaml }), /non-empty filters.from_users allowlist/u);
      const snapshot = await dashboard.snapshot(request, "acme");
      const surface = thingsToTry(snapshot).find(({ key }) => key === "github");
      assert.deepEqual(surface?.next, { label: "New trigger", path: "triggers/new" });
      assert.doesNotMatch(surface?.where ?? "", /Comment on/u);
      return;
    }
    const trigger = await store.save({ userId, yaml });
    const { normalizedConfiguration } = await store.activeRevision(trigger);
    const configuration = parseCompiledHubConfig(normalizedConfiguration);
    const snapshot = await dashboard.snapshot(request, "acme");
    const surface = thingsToTry(snapshot).find(({ key }) => key === "github");
    assert.ok(surface);
    const match = (text: string) =>
      matchGitHubInvocations(
        configuration,
        {
          id: "delivery-1",
          type: "issue_comment",
          repo: "fixture/repo",
          repositoryId: 7,
          installationId: 42,
          createdAt: "2026-11-22T08:00:00Z",
          payload: {
            action: "created",
            issue: {
              number: 12,
              title: "Fixture change",
              user: { login: "author" },
              pull_request: {},
            },
            comment: { id: 123, body: text, user: { login: "octocat" } },
            sender: { login: "octocat" },
          },
        },
        { source: "github.issue_comment", connectionId },
      );
    expectOfferedMatches(kind, surface, match);
    if (linearPlacement !== undefined) expectLinearBeforeOrAfter(snapshot, surface, trigger.id);
    expectReadySurface(surface, ready, trigger.id);
  },
);

function expectOfferedMatches(
  kind: string,
  surface: TrySurface,
  match: (text: string) => ReturnType<typeof matchGitHubInvocations>,
) {
  if (kind === "input choices") {
    const accepted = match("/paseo count=10 Review this pull request.");
    assert.ok(Array.isArray(accepted));
    assert.equal(accepted[0]?.invocation.status, "accepted");
  }
  for (const { prompt } of surface.examples) {
    const result = match(prompt);
    assert.ok(Array.isArray(result), JSON.stringify({ prompt, result }));
    assert.equal(result[0]?.invocation.status, "accepted", JSON.stringify({ prompt, result }));
  }
}

function expectLinearBeforeOrAfter(snapshot: HomeSnapshot, surface: TrySurface, triggerId: string) {
  assert.match(surface.where, /Comment on a pull request .* review is configured to run/u);
  const linearSurface = thingsToTry(snapshot).find(({ key }) => key === "linear");
  assert.equal(linearSurface?.where, "review only starts for comments that match its filters.");
  assert.equal(linearSurface.next?.path, `triggers/${triggerId}`);
  assert.equal(linearSurface.examples.length, 0);
}

function expectReadySurface(surface: TrySurface, ready: boolean, triggerId: string) {
  if (ready) {
    assert.equal(surface.examples.length, 3);
  } else {
    assert.equal(surface.examples.length, 0);
    assert.match(surface.where, /only starts for comments that match its filters/u);
    assert.equal(surface.next?.path, `triggers/${triggerId}`);
  }
}
