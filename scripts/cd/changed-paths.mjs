import { spawnSync } from "node:child_process";
import { diffPaths, latestTag, shaPattern } from "./git.mjs";

const all = { ui: true, e2e: true, workflows: true };
const suites = { ui: true, e2e: true, workflows: false };
const none = { ui: false, e2e: false, workflows: false };
const rules = [
  [/^(?:package(?:-lock)?\.json|\.npmrc|\.github\/workflows\/(?:ci|nightly)\.yml)$/u, all],
  [/^(?:\.github|scripts\/cd)\//u, { ui: false, e2e: false, workflows: true }],
  [/^src\/e2e\/harness\//u, suites],
  [/^src\/e2e\//u, { ui: false, e2e: true, workflows: false }],
  [/^(?:docs|examples)\//u, none],
  [/\.md$/u, none],
  [
    /^(?:LICENSE|\.gitignore|lefthook\.yml|oxlint(?:\.strict)?\.json|\.oxfmtrc\.json|\.env\.example|hub\.yml\.example|fly\.example\.toml)$/u,
    none,
  ],
  [/^scripts\/.*\.node-test\.mjs$/u, none],
  [/^src\/(?:.*\/)?(?:__tests__|__snapshots__|test-fixtures)\//u, none],
  [/^src\/.*\.(?:test|node-test|spec)\.[^/]+$/u, none],
  [/^e2e\//u, { ui: true, e2e: false, workflows: false }],
  [/^(?:Dockerfile|(?:drizzle|vite|vitest|playwright)\.config\.ts|tsconfig[^/]*\.json)$/u, suites],
  [/^(?:bin|drizzle|scripts)\//u, suites],
  // Both suites boot the whole Hub, so any server or UI code can affect them.
  [/^src\//u, suites],
];

export function changedFlags(paths) {
  if (paths === null) return { ...all };
  const flags = { ...none };
  for (const path of paths) {
    const [, change] = rules.find(([pattern]) => pattern.test(path)) ?? [null, all];
    flags.ui ||= change.ui;
    flags.e2e ||= change.e2e;
    flags.workflows ||= change.workflows;
  }
  return flags;
}

function reachable(base) {
  if (!shaPattern.test(base)) return false;
  return spawnSync("git", ["merge-base", "--is-ancestor", base, "HEAD"]).status === 0;
}

export function classify(fallback, sinceRelease) {
  const tag = sinceRelease ? latestTag() : "";
  return changedFlags(tag ? diffPaths(tag) : reachable(fallback) ? diffPaths(fallback) : null);
}

if (import.meta.main) {
  const flags = classify(process.argv[2] ?? "", process.argv[3] === "true");
  for (const [name, value] of Object.entries(flags)) console.log(`${name}=${value}`);
}
