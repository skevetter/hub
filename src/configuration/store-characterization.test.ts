import assert from "node:assert/strict";
import { dump } from "js-yaml";
import { describe, it } from "vitest";
import { compiledConfigurationHash, parseCompiledHubConfig } from "../config/compiler.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { ProjectTriggerRoute } from "../db/types.js";
import { configurationBundleFixture } from "../test-utils/configuration-bundle.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { ProjectConfigurationStore, validateHubBundleForOrganization } from "./store.js";

const organizationId = "org_1";
const userId = "user-1";
const githubId = "00000000-0000-4000-8000-000000000001";
const slackId = "00000000-0000-4000-8000-000000000002";
const discordId = "00000000-0000-4000-8000-000000000003";
const linearId = "00000000-0000-4000-8000-000000000004";
const secondId = "00000000-0000-4000-8000-000000000005";
const connection = { organizationId, providerApplicationId: null };
const github = {
  ...connection,
  id: githubId,
  slug: "github-main",
  installationId: 12,
  accountId: "12",
  accountLogin: "acme",
  accountType: "Organization",
  status: "active" as const,
};
const slack = {
  ...connection,
  id: slackId,
  slug: "slack-main",
  teamId: "T123",
  teamName: "Main team",
  botUserId: "U123",
  botAccessToken: "test-token",
  scopes: [],
};
const discord = {
  ...connection,
  id: discordId,
  slug: "discord-main",
  guildId: "123",
  guildName: "Main guild",
};
const linear = {
  ...connection,
  id: linearId,
  slug: "linear-main",
  linearOrganizationId: "linear-1",
  linearOrganizationName: "Main organization",
  appUserId: "user-2",
  accessToken: "test-token",
  refreshToken: null,
  accessTokenExpiresAt: null,
  scopes: [],
};
const repository = {
  id: "repository",
  organizationId,
  connectionId: githubId,
  repositoryId: 42,
  fullName: "acme/repo",
  defaultBranch: "main",
};

async function setup() {
  const database = createMemoryDatabase();
  await enrollTestDaemon(database);
  const project = await database.createProject({
    organizationId,
    name: "Store project",
    slug: "store-project",
    createdByUserId: userId,
  });
  return { database, project, store: new ProjectConfigurationStore(database, project.id) };
}

function trigger(name: string, on: string, filters?: Record<string, string>) {
  const external = !["manual.run", "github.notification", "linear.issue_entered_scope"].includes(
    on,
  );
  const eventFilters = external ? { ...filters, from_users: [userId] } : filters;
  return {
    name,
    on,
    max_runtime: "1h",
    ...(eventFilters === undefined ? {} : { filters: eventFilters }),
    steps: [
      {
        id: "work",
        environment: "runner",
        max_runtime: "10m",
        idle_timeout: "1m",
        agent: { provider: "codex" },
        prompt: [{ text: "Run" }],
      },
    ],
  };
}

function bundle(...triggers: ReturnType<typeof trigger>[]) {
  return configurationBundleFixture(
    dump({
      environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
      triggers,
    }),
  );
}

describe("ProjectConfigurationStore compilation behavior", () => {
  it("persists resolved filters and activates scoped routes in trigger and connection order", async () => {
    const { database, project, store } = await setup();
    const calls: string[] = [];
    database.organizationConnectionUsage = async (id) => {
      assert.equal(id, organizationId);
      calls.push("usage");
      return {
        github: [github, { ...github, id: secondId, slug: "github-second" }],
        slack: [slack],
        discord: [discord],
        linear: [linear],
      };
    };
    database.listGitHubRepositories = async (id) => {
      assert.equal(id, organizationId);
      calls.push("repositories");
      return [repository];
    };
    const activate = database.activateProjectConfigurationRevision.bind(database);
    const writtenRoutes: ProjectTriggerRoute[] = [];
    database.activateProjectConfigurationRevision = async (projectId, revisionId, routes) => {
      assert.equal(projectId, project.id);
      calls.push("activate");
      assert.ok(routes);
      writtenRoutes.push(...routes);
      return activate(projectId, revisionId, routes);
    };

    const files = bundle(
      trigger("a-manual", "manual.run"),
      trigger("b-notification", "github.notification"),
      trigger("c-fanout", "github.push"),
      trigger("d-connection", "github.push", { connection: "github-main" }),
      trigger("e-repository", "github.push", { repo: "acme/repo" }),
      trigger("f-slack", "slack.mention", { workspace: "slack-main" }),
      trigger("g-discord", "discord.mention", { guild: "discord-main" }),
      trigger("h-linear", "linear.issue_entered_scope", { project: "project-1" }),
    );
    const revision = await store.insertManualBundleRevision({ files, userId });
    assert.equal(revision.validationErrors, null);
    const config = parseCompiledHubConfig(revision.normalizedConfiguration);
    assert.equal(revision.contentHash, compiledConfigurationHash(config));
    assert.deepEqual(
      config.triggers.map(({ filters }) => filters),
      [
        undefined,
        undefined,
        { from_users: [userId] },
        { from_users: [userId], connection: "github-main", connectionId: githubId },
        { from_users: [userId], repo: "acme/repo", connectionId: githubId, resourceId: "42" },
        { from_users: [userId], workspace: "T123", connectionId: slackId, resourceId: "T123" },
        { from_users: [userId], guild: "123", connectionId: discordId, resourceId: "123" },
        { project: "project-1", connectionId: linearId, resourceId: "project-1" },
      ],
    );
    await store.activate(revision.id);
    assert.equal((await store.getActive())?.revision.id, revision.id);
    assert.deepEqual(calls, [
      "usage",
      "repositories",
      "usage",
      "usage",
      "usage",
      "usage",
      "activate",
    ]);
    assert.deepEqual(writtenRoutes, [
      { provider: "github", connectionId: githubId, resourceId: null, triggerName: "c-fanout" },
      { provider: "github", connectionId: secondId, resourceId: null, triggerName: "c-fanout" },
      { provider: "github", connectionId: githubId, resourceId: null, triggerName: "d-connection" },
      { provider: "github", connectionId: githubId, resourceId: "42", triggerName: "e-repository" },
      { provider: "slack", connectionId: slackId, resourceId: "T123", triggerName: "f-slack" },
      { provider: "discord", connectionId: discordId, resourceId: "123", triggerName: "g-discord" },
      {
        provider: "linear",
        connectionId: linearId,
        resourceId: "project-1",
        triggerName: "h-linear",
      },
    ]);
  });

  it("records ordered resolution errors without persisting partially resolved filters", async () => {
    const { database, store } = await setup();
    database.organizationConnectionUsage = async () => ({
      github: [github],
      slack: [slack],
      discord: [],
      linear: [linear, { ...linear, id: secondId, slug: "linear-second" }],
    });
    database.listGitHubRepositories = async () => [
      repository,
      { ...repository, id: "duplicate", repositoryId: 43 },
      { ...repository, id: "different-connection", connectionId: secondId, fullName: "acme/other" },
    ];
    const files = bundle(
      trigger("a-connection", "github.push", { connection: "missing", repo: "acme/repo" }),
      trigger("b-repository", "github.push", { repo: "acme/repo" }),
      trigger("c-slack", "slack.mention", { workspace: "missing" }),
      trigger("d-discord", "discord.mention", { guild: "missing" }),
      trigger("e-linear", "linear.issue_entered_scope", { project: "project-1" }),
    );
    const revision = await store.insertManualBundleRevision({ files, userId });
    assert.deepEqual(revision.validationErrors, {
      formErrors: [],
      issues: [
        {
          path: [".paseo/workflows/a-connection.yml", "filters", "connection"],
          message: '"missing" does not match any GitHub connection (connected: github-main)',
        },
        {
          path: [".paseo/workflows/b-repository.yml", "filters", "repo"],
          message:
            '"acme/repo" does not match any GitHub repository (connected: acme/repo, acme/repo)',
        },
        {
          path: [".paseo/workflows/c-slack.yml", "filters", "workspace"],
          message:
            '"missing" does not match any Slack connection (connected: slack-main "Main team")',
        },
        {
          path: [".paseo/workflows/d-discord.yml", "filters", "guild"],
          message: '"missing" does not match any Discord connection (connected: none)',
        },
        {
          path: [".paseo/workflows/e-linear.yml", "filters", "project"],
          message:
            '"project-1" does not match any Linear project (connected: linear-main "Main organization", linear-second "Main organization")',
        },
      ],
    });
    const config = parseCompiledHubConfig(revision.normalizedConfiguration);
    assert.deepEqual(config.triggers[0]?.filters, {
      connection: "missing",
      repo: "acme/repo",
      from_users: [userId],
    });
    assert.equal(
      config.environments[0]?.kind === "daemon" && config.environments[0].daemonId,
      undefined,
    );
    assert.equal(revision.contentHash, compiledConfigurationHash(config));
    assert.equal(await store.getActive(), undefined);
  });

  it("records the missing-project issue before looking up organization resources", async () => {
    const { database, store } = await setup();
    database.findProjectById = async () => undefined;
    database.organizationConnectionUsage = async () => assert.fail("looked up organization usage");
    const files = bundle(trigger("manual", "manual.run"));
    const revision = await store.insertManualBundleRevision({ files, userId });
    assert.deepEqual(revision.validationErrors, {
      formErrors: ["unresolved organization resources: project"],
    });
    const config = parseCompiledHubConfig(revision.normalizedConfiguration);
    assert.equal(revision.contentHash, compiledConfigurationHash(config));
    assert.equal(await store.getActive(), undefined);
  });

  it("keeps named-agent validation errors distinct from resource errors", async () => {
    const { database } = await setup();
    const files = namedAgentBundle();
    assert.deepEqual(await validateHubBundleForOrganization(database, organizationId, files), {
      valid: false,
      validationErrors: {
        formErrors: [],
        issues: [
          {
            path: [".paseo/hub.yml", "agents"],
            message: "the selected daemon provider-validation capability is unavailable",
          },
        ],
      },
    });
    assert.deepEqual(
      await validateHubBundleForOrganization(database, organizationId, files, {
        validateAgentConfiguration: async () => ({ valid: true }),
      }),
      { valid: true },
    );
  });
});

function namedAgentBundle() {
  const manual = trigger("manual", "manual.run");
  return [
    {
      path: ".paseo/hub.yml",
      content: dump({
        environments: { runner: { kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" } },
        agents: { worker: { provider: "codex" } },
      }),
    },
    {
      path: ".paseo/workflows/manual.yml",
      content: dump({
        ...manual,
        steps: manual.steps.map((step) => Object.assign({}, step, { agent: "worker" })),
      }),
    },
  ];
}
