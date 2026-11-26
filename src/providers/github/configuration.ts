import { z } from "zod";
import type { GitHubAuth } from "../../auth/github.js";
import type { GitHubConfigurationProvider } from "../../configuration/github-sync.js";
import type { PromptPartialReadResult } from "../../config/prompt-partials.js";

const repositorySchema = z
  .object({
    id: z.number().int().positive(),
    full_name: z.string().min(1),
    default_branch: z.string().min(1),
  })
  .loose();
const repositoryListSchema = z.object({ repositories: z.array(repositorySchema) }).loose();
const referenceSchema = z.object({ object: z.object({ sha: z.string().min(1) }) }).loose();
const contentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string() }).loose(),
  z.object({ type: z.literal("dir") }).loose(),
  z.object({ type: z.literal("symlink") }).loose(),
  z.object({ type: z.literal("submodule") }).loose(),
]);
const treeSchema = z
  .object({
    truncated: z.boolean(),
    tree: z.array(
      z
        .object({
          path: z.string(),
          mode: z.string(),
          type: z.enum(["blob", "tree", "commit"]),
        })
        .loose(),
    ),
  })
  .loose();

export function createGitHubConfigurationProvider(auth: GitHubAuth): GitHubConfigurationProvider {
  return {
    listInstallationRepositories(input) {
      return listInstallationRepositories(auth, input);
    },
    async readDefaultBranchHead({ installationId, repositoryId, defaultBranch }) {
      const resolved = await repository(auth, installationId, repositoryId);
      const response = await resolved.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner: resolved.owner,
        repo: resolved.name,
        ref: `heads/${defaultBranch}`,
      });
      return referenceSchema.parse(response.data).object.sha;
    },
    async listFilesAtCommit({ installationId, repositoryId, commitSha, prefix }) {
      const resolved = await repository(auth, installationId, repositoryId);
      const response = await resolved.octokit.request(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        {
          owner: resolved.owner,
          repo: resolved.name,
          tree_sha: commitSha,
          recursive: "true",
        },
      );
      const tree = treeSchema.parse(response.data);
      if (tree.truncated) throw new Error("GitHub configuration tree response was truncated");
      return tree.tree
        .filter(({ path }) => path === prefix || path.startsWith(`${prefix}/`))
        .filter(({ type }) => type !== "tree")
        .map(({ path, type, mode }) => ({ path, kind: gitTreeEntryKind(type, mode) }));
    },
    async readFileAtCommit({ installationId, repositoryId, commitSha, path }) {
      const resolved = await repository(auth, installationId, repositoryId);
      try {
        const response = await resolved.octokit.request(
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            owner: resolved.owner,
            repo: resolved.name,
            path,
            ref: commitSha,
          },
        );
        const content = contentSchema.parse(response.data);
        return toFileAtCommit(content);
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
    },
  };
}

async function repository(auth: GitHubAuth, installationId: number, repositoryId: number) {
  const octokit = await auth.createInstallationOctokit(installationId);
  const response = await octokit.request("GET /repositories/{repository_id}", {
    repository_id: repositoryId,
  });
  const parsed = repositorySchema.parse(response.data);
  const [owner, name] = splitFullName(parsed.full_name);
  return { octokit, owner, name, repository: parsed };
}

async function listInstallationRepositories(
  auth: GitHubAuth,
  { installationId }: Parameters<GitHubConfigurationProvider["listInstallationRepositories"]>[0],
) {
  const octokit = await auth.createInstallationOctokit(installationId);
  const repositories: Array<{ repositoryId: number; fullName: string; defaultBranch: string }> = [];
  for (let page = 1; ; page += 1) {
    const response = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    });
    const listed = repositoryListSchema.parse(response.data).repositories;
    repositories.push(
      ...listed.map((item) => ({
        repositoryId: item.id,
        fullName: item.full_name,
        defaultBranch: item.default_branch,
      })),
    );
    if (listed.length < 100) return repositories;
  }
}

function gitTreeEntryKind(
  type: "blob" | "tree" | "commit",
  mode: string,
): "file" | "symlink" | "submodule" {
  if (type === "commit") return "submodule";
  if (mode === "120000") return "symlink";
  return "file";
}

function toFileAtCommit(content: z.infer<typeof contentSchema>): PromptPartialReadResult {
  if (content.type === "file") {
    return {
      kind: "file",
      content: Buffer.from(content.content.replaceAll("\n", ""), "base64").toString("utf8"),
    };
  }
  if (content.type === "dir") return { kind: "directory" };
  if (content.type === "symlink") return { kind: "symlink" };
  return { kind: "submodule" };
}

function splitFullName(fullName: string): [string, string] {
  const parts = fullName.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) {
    throw new Error("GitHub returned an invalid repository identity");
  }
  return [owner, name];
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "status") === status;
}
