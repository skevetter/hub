import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import {
  synchronizeGitHubDefaultBranch,
  synchronizeGitHubProjectConfiguration,
  type GitHubConfigurationProvider,
} from "./github-sync.js";
import { ProjectConfigurationStore } from "./store.js";

const hub = ".paseo/hub.yml";
const workflow = ".paseo/workflows/a.yml";

function provider(
  entries: Awaited<ReturnType<GitHubConfigurationProvider["listFilesAtCommit"]>>,
  calls: unknown[],
  files: Readonly<Record<string, string>> = { [hub]: "" },
): GitHubConfigurationProvider {
  return {
    listInstallationRepositories: async () => [],
    readDefaultBranchHead: async () => "actual",
    listFilesAtCommit: async (input) => {
      calls.push(input);
      return entries;
    },
    readFileAtCommit: async (input) => {
      calls.push(input.path);
      const content = files[input.path];
      return content === undefined ? undefined : { kind: "file", content };
    },
  };
}

function configurationTarget(projectId: string, organizationId = "org") {
  return {
    id: "target",
    organizationId,
    projectId,
    connectionId: "connection",
    installationId: 3,
    repositoryId: 5,
    fullName: "owner/repo",
    defaultBranch: "main",
    automaticDeploymentEnabled: true,
  };
}

function databaseFixture() {
  const attempts: unknown[] = [];
  const revisions: unknown[] = [];
  const database = Object.assign(createMemoryDatabase(), {
    findGitHubConfigurationTarget: async () => configurationTarget("project"),
    recordConfigurationSyncAttempt: async (attempt) => {
      attempts.push(attempt);
      throw new Error("attempt sentinel");
    },
    insertProjectConfigurationRevision: async (revision) => {
      revisions.push(revision.validationErrors);
      throw new Error("revision sentinel");
    },
  } satisfies Partial<Database>);
  return { database, attempts, revisions };
}

function projectInput(database: Database, client: GitHubConfigurationProvider) {
  return {
    database,
    client,
    projectId: "project",
    githubConnectionId: "connection",
    githubRepositoryId: 5,
    githubRepositoryFullName: "owner/repo",
    githubDefaultBranch: "main",
    installationId: 3,
    repositoryId: 5,
    commitSha: "expected",
    webhookDeliveryId: null,
  };
}

async function rejection(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : error;
  }
  throw new Error("expected rejection");
}

describe("GitHub configuration sync characterization", () => {
  it("records a superseded branch head with the expected commit and does not list files", async () => {
    const { database, attempts } = databaseFixture();
    const calls: unknown[] = [];
    const input = projectInput(database, provider([], calls));
    expect(
      await rejection(synchronizeGitHubDefaultBranch({ ...input, expectedCommitSha: "expected" })),
    ).toBe("attempt sentinel");
    expect(attempts).toEqual([
      {
        projectId: "project",
        githubConnectionId: "connection",
        githubRepositoryId: 5,
        webhookDeliveryId: null,
        commitSha: "expected",
        outcome: "superseded",
        evidence: { branchHead: "actual" },
      },
    ]);
    expect(calls).toEqual([]);
  });

  it("checks for missing resource before checking kinds", async () => {
    const { database, attempts, revisions } = databaseFixture();
    const calls: unknown[] = [];
    const input = projectInput(database, provider([{ path: workflow, kind: "symlink" }], calls));
    expect(await rejection(synchronizeGitHubProjectConfiguration(input))).toBe("attempt sentinel");
    expect(attempts).toEqual([
      {
        projectId: "project",
        githubConnectionId: "connection",
        githubRepositoryId: 5,
        webhookDeliveryId: null,
        commitSha: "expected",
        outcome: "fetch_failed",
        evidence: { reason: "hub_resource_not_found_at_commit" },
      },
    ]);
    expect(revisions).toEqual([]);
    expect(calls).toEqual([
      { installationId: 3, repositoryId: 5, commitSha: "expected", prefix: ".paseo" },
    ]);
  });

  it("captures invalid kinds before reading and compiles after reading a complete bundle", async () => {
    const { database, attempts, revisions } = databaseFixture();
    const calls: unknown[] = [];
    const link = projectInput(database, provider([{ path: hub, kind: "symlink" }], calls));
    const file = projectInput(database, provider([{ path: hub, kind: "file" }], calls));
    expect(await rejection(synchronizeGitHubProjectConfiguration(link))).toBe("revision sentinel");
    expect(await rejection(synchronizeGitHubProjectConfiguration(file))).toBe("revision sentinel");
    expect(revisions).toEqual([
      { formErrors: [`${hub}: configuration bundle entry is not a regular file (symlink)`] },
      { formErrors: [`${hub}: document must be a YAML mapping`] },
    ]);
    expect(calls.filter((call) => typeof call === "string")).toEqual([hub]);
    expect(attempts).toEqual([]);
  });
});

const activationFiles = {
  [hub]: `environments:
  runner: { kind: daemon, daemon: ${TEST_DAEMON_SLUG}, cwd: /repo }
`,
  [workflow]: `name: run
on: manual.run
max_runtime: 1h
steps:
  - id: work
    environment: runner
    max_runtime: 10m
    idle_timeout: 1m
    agent: { provider: codex }
    prompt: [{ text: Run }]
`,
};

describe("GitHub default branch activation", () => {
  it.each(["default store", "supplied store"] as const)(
    "activates the exact revision using the %s",
    async (selection) => {
      const database = createMemoryDatabase();
      const project = await database.createProject({
        organizationId: "org_1",
        name: "Test",
        slug: "sync-test",
        createdByUserId: "test-user",
      });
      await enrollTestDaemon(database);
      database.findGitHubConfigurationTarget = async () =>
        configurationTarget(project.id, project.organizationId);
      const activationCalls: unknown[] = [];
      const activate = database.activateProjectConfigurationRevision.bind(database);
      database.activateProjectConfigurationRevision = async (...args) => {
        activationCalls.push(args);
        return activate(...args);
      };
      const factoryCalls: string[] = [];
      const configurationForProject = (projectId: string) => {
        factoryCalls.push(projectId);
        return new ProjectConfigurationStore(database, projectId);
      };
      const entries = Object.keys(activationFiles).map((path) => ({ path, kind: "file" as const }));
      const supplied = selection === "supplied store";
      const result = await synchronizeGitHubDefaultBranch({
        database,
        client: provider(entries, [], activationFiles),
        projectId: project.id,
        expectedCommitSha: "actual",
        webhookDeliveryId: "delivery",
        ...(supplied ? { configurationForProject } : {}),
      });

      expect(factoryCalls).toEqual(supplied ? [project.id] : []);
      expect(result?.outcome).toBe("activated");
      if (result?.outcome !== "activated") throw new Error("expected activation");
      expect(activationCalls).toEqual([[project.id, result.revision.id, []]]);
      expect(result.revision.sourceEvidence).toMatchObject({
        kind: "github",
        commitSha: "actual",
        webhookDeliveryId: "delivery",
      });
      expect((await database.findActiveProjectConfiguration(project.id))?.id).toBe(
        result.revision.id,
      );
    },
  );
});
