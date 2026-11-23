import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ambientFiles, lintGroup, parseArgs, selectDiagnostics } from "./lint-strict.mjs";

test("reads a base and file list", () => {
  assert.deepEqual(parseArgs(["--base", "fork-1", "src/a.ts", "--", "src/b.tsx"]), {
    base: "fork-1",
    files: ["src/a.ts", "src/b.tsx"],
  });
});

test("routes files to the tsconfig that owns them", () => {
  assert.equal(lintGroup("src/repo.ts"), "node");
  assert.equal(lintGroup("src/router.tsx"), "start");
  assert.equal(lintGroup("vite.config.ts"), "start");
});

test("skips files outside the lint scope", () => {
  assert.equal(lintGroup("README.md"), undefined);
  assert.equal(lintGroup("scripts/lint-strict.mjs"), undefined);
  assert.equal(lintGroup("src/routeTree.gen.ts"), undefined);
  assert.equal(lintGroup("src/deleted-file.ts"), undefined);
});

test("keeps diagnostics for the changed files only", () => {
  const output = [
    "src/a.ts:1:1: too complex [Error/eslint(complexity)]",
    "src/router.tsx:2:1: too long [Error/eslint(max-lines-per-function)]",
    "",
    "2 problems",
  ].join("\n");
  assert.deepEqual(selectDiagnostics(output, ["src/a.ts"]), [
    "src/a.ts:1:1: too complex [Error/eslint(complexity)]",
  ]);
});

test("finds module augmentations that the type program needs", () => {
  const files = ambientFiles();
  assert.ok(files.includes("src/router.tsx"));
  assert.ok(!files.includes("src/routeTree.gen.ts"));
});

test("passes when no listed file is in scope", () => {
  const result = spawnSync(process.execPath, ["scripts/lint-strict.mjs", "README.md"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /strict lint: 0 file\(s\) from listed files/u);
  assert.match(result.stdout, /strict lint: 0 problem\(s\)/u);
});
