import { commitSubjects, latestTag } from "./git.mjs";
import { conventional } from "./next-version.mjs";

function escapeSubject(subject) {
  return subject.replaceAll(/[\\`*_{}\[\]<>#~@]/gu, "\\$&");
}

export function releaseNotes(subjects) {
  const groups = new Map();
  for (const subject of subjects.filter(Boolean)) {
    const type = conventional.exec(subject)?.[1] ?? "other";
    const entries = groups.get(type) ?? [];
    entries.push(`- ${escapeSubject(subject)}`);
    groups.set(type, entries);
  }
  return [...groups.keys()]
    .sort()
    .map((type) => `## ${type}\n\n${groups.get(type).join("\n")}\n`)
    .join("\n");
}

if (import.meta.main) console.log(releaseNotes(commitSubjects(latestTag())));
