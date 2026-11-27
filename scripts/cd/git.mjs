import { execFileSync, spawnSync } from "node:child_process";

export const shaPattern = /^[0-9a-f]{40}$/u;

export function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export function latestTag() {
  const result = spawnSync("git", ["describe", "--tags", "--match", "v[0-9]*", "--abbrev=0"], {
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.trim();
  if (!git("tag", "--merged", "HEAD", "--list", "v[0-9]*").trim()) return "";
  throw new Error("Cannot determine the last release tag");
}

export function diffPaths(base, filter = "ACDMRTUXB") {
  return git(
    "diff",
    "--name-only",
    "--no-renames",
    `--diff-filter=${filter}`,
    "-z",
    base,
    "HEAD",
    "--",
  )
    .split("\0")
    .filter(Boolean);
}

export function commitSubjects(tag) {
  return git("log", "--format=%s", tag ? `${tag}..HEAD` : "HEAD")
    .trimEnd()
    .split("\n");
}
