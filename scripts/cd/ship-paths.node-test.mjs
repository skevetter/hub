import assert from "node:assert/strict";
import test from "node:test";
import { shouldShip } from "./ship-paths.mjs";

test("ships the initial release and any runtime change", () => {
  assert.equal(shouldShip("", []), true);
  for (const path of [
    "src/index.ts",
    "scripts/start.mjs",
    "drizzle/0050_example.sql",
    "package-lock.json",
  ]) {
    assert.equal(shouldShip("v1.0.0", ["README.md", path]), true, path);
  }
});

test("does not ship documentation, tests, or pipeline changes", () => {
  assert.equal(
    shouldShip("v1.0.0", [
      "README.md",
      "docs/asset.svg",
      ".github/workflows/main.yml",
      "src/behavior.test.ts",
      "e2e/workflow.spec.ts",
      "scripts/cd/deploy.sh",
    ]),
    false,
  );
});
