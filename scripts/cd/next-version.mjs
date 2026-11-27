import { commitSubjects, git, latestTag, releaseTag } from "./git.mjs";

export const conventional = /^([a-z]+)(?:\([^()\n]+\))?(!)?: /u;

export function nextVersion(tag, subjects, bodies = []) {
  const match = releaseTag.exec(tag);
  if (!match || match[1] === "0") return "v1.0.0";
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
