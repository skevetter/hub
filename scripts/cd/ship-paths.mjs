import { diffPaths, latestTag } from "./git.mjs";

const uncertainPath = /(?:^|\/)\.{1,2}(?:\/|$)/u;
const packageContent = /^(?:bin|drizzle|dist|\.output)\//u;
const excluded = [
  /^(?:\.github|docs|e2e|examples|scripts)\//u,
  /(?:^|\/)(?:__tests__|__snapshots__|test-fixtures|test-utils)\//u,
  /^src\/(?:config\/fixtures\/current-project|triggers\/fixtures)\//u,
  /(?:^|[/-])test-fixtures?\.[^/]+$/u,
  /(?:\.(?:node-test|test|spec)\.[^/]+|\.snap|\.mdx?)$/iu,
  /^(?:LICENSE|lefthook\.yml|\.oxfmtrc\.json|oxlint(?:\.strict)?\.json)$/u,
  /^(?:(?:playwright|vitest)\.config\.ts|tsconfig\.e2e\.json|components\.json|paseo\.json)$/u,
  /^(?:compose\.yml|fly(?:\.example)?\.toml|hub\.yml\.example|\.env\.example|slack(?:-webhook)?-app-manifest\.yml)$/u,
];

function isShipPath(path) {
  return (
    uncertainPath.test(path) ||
    packageContent.test(path) ||
    !excluded.some((pattern) => pattern.test(path))
  );
}

export function shouldShip(tag, paths) {
  return !tag || paths.some(isShipPath);
}

if (import.meta.main) {
  const tag = latestTag();
  process.stdout.write(`${shouldShip(tag, tag ? diffPaths(tag) : [])}\n`);
}
