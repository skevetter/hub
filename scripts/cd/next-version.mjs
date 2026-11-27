import { commitSubjects, git, latestTag } from "./git.mjs";

export const conventional = /^([a-z]+)(?:\([^()\n]+\))?(!)?: /u;
export const releaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function nextVersion(tag, subjects, bodies = []) {
  if (tag === "") return "v1.0.0";
  const match = releaseTag.exec(tag);
  if (!match) throw new Error("Last release tag must use v<major>.<minor>.<patch>");
  const [major, minor, patch] = match.slice(1).map(BigInt);
  if (subjects.some((subject) => conventional.exec(subject)?.[2]) || bodies.some(isBreaking)) {
    return `v${major + 1n}.0.0`;
  }
  if (subjects.some((subject) => conventional.exec(subject)?.[1] === "feat")) {
    return `v${major}.${minor + 1n}.0`;
  }
  return `v${major}.${minor}.${patch + 1n}`;
}

function isBreaking(text) {
  return /^BREAKING[ -]CHANGE: /mu.test(text);
}

if (import.meta.main) {
  const tag = latestTag();
  const bodies = tag ? [git("log", "--format=%b", `${tag}..HEAD`)] : [];
  console.log(nextVersion(tag, commitSubjects(tag), bodies));
}
