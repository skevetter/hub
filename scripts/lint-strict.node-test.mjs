import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ambientFiles,
  lintGroup,
  parseArgs,
  partlyStaged,
  selectDiagnostics,
} from "./lint-strict.mjs";

test("reads a base, the staged flag and a file list", () => {
  assert.deepEqual(parseArgs(["--base", "fork-1", "--staged", "src/a.ts", "--", "src/b.tsx"]), {
    base: "fork-1",
    staged: true,
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

test("ignores lines that only name a changed file", () => {
  const output = [
    "src/a.ts",
    "src/a.ts: note",
    "src/a:b.ts:3:4: msg [Error/eslint(complexity)]",
  ].join("\n");
  assert.deepEqual(selectDiagnostics(output, ["src/a.ts", "src/a:b.ts"]), [
    "src/a:b.ts:3:4: msg [Error/eslint(complexity)]",
  ]);
});

test("reports target files that still have unstaged edits", () => {
  assert.deepEqual(partlyStaged(["src/a.ts", "src/b.ts"], ["src/b.ts", "README.md"]), ["src/b.ts"]);
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

test("keeps the base billing boundary and its composition root exemption", () => {
  const dir = mkdtempSync(join(tmpdir(), "strict-billing-"));
  const probe = join(dir, "probe.ts");
  writeFileSync(probe, 'import { x } from "./billing/index.js";\nexport const y = x;\n');
  try {
    const outside = runOxlint([probe]);
    assert.match(outside, /on 1 file/u);
    assert.match(outside, /no-restricted-imports/u);
    const roots = runOxlint([
      "--tsconfig",
      "tsconfig.json",
      "src/index.ts",
      "src/application-runtime.ts",
      "src/server/runtime.ts",
    ]);
    assert.match(roots, /on 3 files/u);
    assert.doesNotMatch(roots, /no-restricted-imports/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runOxlint(args) {
  const result = spawnSync("node_modules/.bin/oxlint", ["-c", "oxlint.strict.json", ...args], {
    encoding: "utf8",
  });
  return `${result.stdout}${result.stderr}`;
}
