import assert from "node:assert/strict";
import test from "node:test";
import { changedFlags } from "./changed-paths.mjs";

test("runs all optional jobs when the base is unavailable", () => {
  assert.deepEqual(changedFlags(null), { ui: true, e2e: true, workflows: true });
});

test("classifies source, the Paseo pin, and deploy helpers", () => {
  assert.deepEqual(changedFlags(["src/features/card.tsx"]), {
    ui: true,
    e2e: false,
    workflows: false,
  });
  assert.deepEqual(changedFlags(["src/e2e/contract.ts"]), {
    ui: false,
    e2e: true,
    workflows: false,
  });
  assert.deepEqual(changedFlags([".github/workflows/ci.yml"]), {
    ui: true,
    e2e: true,
    workflows: true,
  });
  assert.deepEqual(changedFlags(["scripts/cd/deploy.sh"]), {
    ui: false,
    e2e: false,
    workflows: true,
  });
  assert.deepEqual(changedFlags(["README.md"]), { ui: false, e2e: false, workflows: false });
});
