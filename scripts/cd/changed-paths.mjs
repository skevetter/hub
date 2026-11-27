import { spawnSync } from "node:child_process";
import { diffPaths, latestTag, shaPattern } from "./git.mjs";

const shared = /^(?:package(?:-lock)?\.json|\.npmrc|\.github\/workflows\/(?:ci|nightly)\.yml)$/u;
const ui =
  /^(?:e2e\/|src\/(?:routes\/|components\/|styles\.css$|routeTree\.gen\.ts$)|(?:vite|playwright)\.config\.ts$)/u;
const e2e = /^(?:src\/e2e\/|scripts\/(?:paseo-workspace|ci-paseo-source)\.|vitest\.config\.ts$)/u;

export function changedFlags(paths) {
  if (paths === null) return { ui: true, e2e: true, workflows: true };
  const sharedChange = paths.some((path) => shared.test(path));
  return {
    ui:
      sharedChange ||
      paths.some((path) => ui.test(path) || (path.startsWith("src/") && path.endsWith(".tsx"))),
    e2e: sharedChange || paths.some((path) => e2e.test(path)),
    workflows: paths.some((path) => path.startsWith(".github/") || path.startsWith("scripts/cd/")),
  };
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
