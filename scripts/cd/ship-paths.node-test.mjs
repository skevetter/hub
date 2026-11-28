import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { shouldShip } from "./ship-paths.mjs";

const tag = "v1.0.0";
const root = new URL("../../", import.meta.url);
const buildInputs = [
  "package.json",
  "package-lock.json",
  ".npmrc",
  "Dockerfile",
  "vite.config.ts",
  "drizzle.config.ts",
  "tsconfig.json",
  "tsconfig.start.json",
];

test("ships the initial release and mixed changes with a runtime path", () => {
  assert.equal(shouldShip("", []), true);
  assert.equal(shouldShip(tag, []), false);
  assert.equal(shouldShip(tag, ["README.md", "src/app.ts"]), true);
});

test("ships build inputs, runtime paths, and unknown paths", () => {
  for (const path of [
    ...buildInputs,
    "bin/paseo-hub.js",
    "drizzle/0050_example.sql",
    "src/e2e/harness/index.ts",
    ".gitignore",
    ".dockerignore",
    "new-config.toml",
    "new-directory/task.mjs",
  ]) {
    assert.equal(shouldShip(tag, [path]), true, path);
  }
});

test("ships a rename into or out of a runtime path and fails closed on dot segments", () => {
  // Git reports both names because diffPaths disables rename detection.
  const rename = ["scripts/example.mjs", "bin/example.mjs"];
  for (const paths of [rename, rename.toReversed()]) {
    assert.equal(shouldShip(tag, paths), true);
  }
  for (const path of [
    "./scripts/test-shard.mjs",
    "scripts/cd/../../src/x.ts",
    "scripts/./tool.mjs",
  ]) {
    assert.equal(shouldShip(tag, [path]), true, path);
  }
});

test("does not ship docs, tests, tooling, or deploy examples alone", () => {
  for (const path of [
    "README.md",
    "LICENSE",
    "docs/asset.svg",
    "examples/demo.yml",
    "scripts/start.mjs",
    ".github/workflows/main.yml",
    "e2e/workflow.spec.ts",
    "src/foo.test.ts",
    "src/foo.spec.ts",
    "src/e2e/hub.e2e.test.ts",
    "src/__tests__/x.ts",
    "src/__snapshots__/x.sha256",
    "src/test-fixtures/payload.json",
    "src/test-utils/example.ts",
    "src/linear-pilot/test-fixtures.ts",
    "src/config/fixtures/current-project/.paseo/hub.yml",
    "src/triggers/fixtures/manual-smoke.json",
    "src/receipt-retention/README.md",
    "lefthook.yml",
    ".oxfmtrc.json",
    "oxlint.strict.json",
    "playwright.config.ts",
    "vitest.config.ts",
    "tsconfig.e2e.json",
    "components.json",
    "paseo.json",
    "compose.yml",
    "fly.toml",
    "fly.example.toml",
    "hub.yml.example",
    ".env.example",
    "slack-app-manifest.yml",
    "slack-webhook-app-manifest.yml",
  ]) {
    assert.equal(shouldShip(tag, [path]), false, path);
  }
});

test("does not ship the recent test, workflow, and changed-paths change sets", () => {
  for (const paths of [
    ["docs/testing.md", "scripts/test-shard.mjs", "scripts/test-shard.node-test.mjs"],
    [".github/workflows/main.yml"],
    ["scripts/cd/changed-paths.mjs", "scripts/cd/changed-paths.node-test.mjs"],
    ["vitest.config.ts", "src/db/runtime/internal/postgres-shutdown.test.ts"],
  ]) {
    assert.equal(shouldShip(tag, paths), false, paths.join(", "));
  }
});

function command(t, name, args) {
  const result = spawnSync(name, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    t.skip(`${name} is unavailable`);
    return undefined;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function isRuntimeSource(path) {
  if (!path.startsWith("src/")) return true;
  return ![
    /\/(?:__tests__|__snapshots__|test-fixtures|test-utils)\//u,
    /^src\/(?:config\/fixtures\/current-project|triggers\/fixtures)\//u,
    /(?:\/|-)test-fixtures?\.[^/]+$/u,
    /\.(?:(?:node-test|test|spec)\.[^/]+|snap|mdx?)$/iu,
  ].some((pattern) => pattern.test(path));
}

test("ships every tracked runtime source and package input", (t) => {
  const tracked = command(t, "git", ["ls-files", "-z", "--", "src", "bin", "drizzle"]);
  if (tracked === undefined) return;
  const sources = tracked.split("\0").filter(Boolean).filter(isRuntimeSource);
  assert.ok(sources.length > 0);
  for (const path of [...sources, ...buildInputs]) {
    assert.equal(shouldShip(tag, [path]), true, path);
  }
});

test("ships packed runtime paths, including build outputs when present", (t) => {
  const packed = command(t, "npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  if (packed === undefined) return;
  const [{ files }] = JSON.parse(packed);
  const directories = ["bin", "drizzle", "dist", ".output"];
  for (const directory of directories.filter((dir) => existsSync(new URL(`${dir}/`, root)))) {
    const entries = files.filter(({ path }) => path.startsWith(`${directory}/`));
    assert.ok(entries.length > 0, `Expected npm to pack ${directory}/`);
    for (const { path } of entries) {
      assert.equal(shouldShip(tag, [path]), true, path);
    }
  }
});
