import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : null;
}

export function requireGit(root, args) {
  const output = git(root, args);
  if (output === null) throw new Error(`Git could not complete ${args[0]}.`);
  return output;
}

function worktree(directory) {
  const root = git(directory, ["rev-parse", "--show-toplevel"])?.trimEnd();
  return root ? realpathSync(root) : null;
}

export function repositoryFor(scriptUrl, explicitRoot) {
  const cwd = realpathSync(process.cwd());
  const scriptRoot = worktree(fileURLToPath(new URL("../", scriptUrl)));
  const callerRoot = worktree(cwd);
  if (explicitRoot === undefined && callerRoot && callerRoot !== scriptRoot) {
    throw new Error(
      `The caller is in a different Git worktree (${callerRoot}). This script belongs to ${scriptRoot ?? "no Git worktree"}. Pass --root <path> to choose a worktree explicitly.`,
    );
  }
  const root = explicitRoot === undefined ? scriptRoot : worktree(explicitRoot);
  if (!root) throw new Error(`No Git worktree found at ${explicitRoot ?? scriptUrl}.`);
  return root;
}

export function readRepository(root) {
  return {
    root: realpathSync(root),
    branch: requireGit(root, ["branch", "--show-current"]).trimEnd() || "(detached)",
    head: requireGit(root, ["rev-parse", "--verify", "HEAD"]).trim(),
    dirty: Boolean(requireGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])),
  };
}

export function printRunContext(root, action) {
  const repo = readRepository(root);
  console.log(`Repository: ${repo.root}`);
  console.log(`Branch: ${repo.branch}`);
  console.log(`HEAD: ${repo.head}`);
  console.log(`Worktree: ${repo.dirty ? "dirty" : "clean"}`);
  console.log(`CWD: ${realpathSync(process.cwd())}`);
  console.log(`Run: ${action}`);
  return repo;
}

export function passedVitestReport(report) {
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    (report.numFailedTestSuites ?? 0) !== 0
  )
    return false;

  let passed = 0;
  let total = 0;
  for (const file of report.testResults) {
    if (file?.status !== "passed" || !Array.isArray(file.assertionResults)) return false;
    for (const assertion of file.assertionResults) {
      total++;
      if (assertion?.status === "passed") passed++;
      else if (assertion?.status !== "skipped" && assertion?.status !== "todo") return false;
    }
  }
  return report.numPassedTests === passed && report.numTotalTests === total;
}

export function isEntrypoint(url) {
  const entry = process.argv[1];
  return entry && existsSync(entry) && realpathSync(entry) === realpathSync(fileURLToPath(url));
}
