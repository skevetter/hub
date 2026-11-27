import { execFileSync } from "node:child_process";

export const shaPattern = /^[0-9a-f]{40}$/u;
export const releaseTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export function releaseTags(...selection) {
  return git("tag", "--list", "--sort=-version:refname", ...selection, "v[0-9]*")
    .split("\n")
    .filter((tag) => releaseTag.test(tag));
}

export function latestTag() {
  return releaseTags("--merged", "HEAD")[0] ?? "";
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "latest") console.log(latestTag());
  else if (mode === "all") console.log(releaseTags().join("\n"));
  else if (mode === "merged") console.log(releaseTags("--merged", "HEAD").join("\n"));
  else if (mode === "at") console.log(releaseTags("--points-at", process.argv[3]).join("\n"));
  else throw new Error("Unknown tag query");
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
