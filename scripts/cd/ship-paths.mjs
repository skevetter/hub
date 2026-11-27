import { diffPaths, latestTag } from "./git.mjs";

const excluded = [
  /^(?:\.github|docs|e2e|src\/e2e|scripts\/cd)\//u,
  /(?:^|\/)(?:__tests__|__snapshots__|test-fixtures)\//u,
  /(?:\.(?:node-test|test|spec)\.[^/]+|\.snap|\.mdx?)$/iu,
  /^(?:lefthook\.yml|playwright\.config\.ts|vitest\.config\.ts)$/u,
];

export function shouldShip(tag, paths) {
  return !tag || paths.some((path) => !excluded.some((pattern) => pattern.test(path)));
}

if (import.meta.main) {
  const tag = latestTag();
  console.log(shouldShip(tag, tag ? diffPaths(tag) : []));
}
