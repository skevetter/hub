import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import {
  synchronizeGitHubDefaultBranch,
  synchronizeGitHubProjectConfiguration,
  type GitHubConfigurationProvider,
} from "./github-sync.js";

const hub = ".paseo/hub.yml";
const workflow = ".paseo/workflows/a.yml";

function provider(
  entries: Awaited<ReturnType<GitHubConfigurationProvider["listFilesAtCommit"]>>,
  calls: unknown[],
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
      return input.path === hub ? { kind: "file", content: "" } : undefined;
    },
  };
}

function databaseFixture() {
  const attempts: unknown[] = [];
  const revisions: unknown[] = [];
  const database = Object.assign(createMemoryDatabase(), {
    findGitHubConfigurationTarget: async () => ({
      id: "target",
      organizationId: "org",
      projectId: "project",
      connectionId: "connection",
      installationId: 3,
      repositoryId: 5,
      fullName: "owner/repo",
      defaultBranch: "main",
      automaticDeploymentEnabled: true,
    }),
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
