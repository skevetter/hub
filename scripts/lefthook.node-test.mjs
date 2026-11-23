import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

const lintJob = parse(readFileSync("lefthook.yml", "utf8"))["pre-commit"].jobs.find(
  (job) => job.name === "lint",
);

function lintRuns(file) {
  const dir = mkdtempSync(join(tmpdir(), "lefthook-lint-"));
  const config = join(dir, "lefthook.yml");
  const probe = { ...lintJob, run: "echo MATCHED" };
  writeFileSync(config, stringify({ "pre-commit": { jobs: [probe] } }));
  try {
    const result = spawnSync(
      "node_modules/.bin/lefthook",
      ["run", "pre-commit", "--job", "lint", "--file", file, "--no-auto-install", "--no-tty"],
      { encoding: "utf8", env: { ...process.env, LEFTHOOK_CONFIG: config } },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.includes("MATCHED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runs the app lint for files the app lint covers", () => {
  for (const file of [
    "src/index.ts",
    "src/e2e/harness/index.ts",
    "src/router.tsx",
    "vite.config.ts",
  ])
    assert.equal(lintRuns(file), true, file);
});

test("skips the app lint for browser e2e files and other paths", () => {
  for (const file of ["e2e/helpers/hub.ts", "playwright.config.ts", "scripts/lint-strict.mjs"])
    assert.equal(lintRuns(file), false, file);
});

test("lints the configured scope instead of the staged file list", () => {
  assert.doesNotMatch(lintJob.run, /staged_files/u);
});
