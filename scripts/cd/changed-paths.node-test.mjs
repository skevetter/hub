import assert from "node:assert/strict";
import test from "node:test";
import { changedFlags } from "./changed-paths.mjs";

test("runs all optional jobs when the base is unavailable", () => {
  assert.deepEqual(changedFlags(null), { ui: true, e2e: true, workflows: true });
});

const cases = [
  [
    { ui: true, e2e: true, workflows: false },
    [
      "src/features/card.tsx",
      "src/daemons/lifecycle.ts",
      "src/test-utils/helper.ts",
      "src/receipt-retention/README.md",
      "src/daemons/lifecycle.test.ts.bak",
      "src/daemons/helper.test.json",
      "src/e2e/harness/browser-child.ts",
      "drizzle/0070_x.sql",
      "Dockerfile",
      "scripts/paseo-workspace.mjs",
      "scripts/ci-paseo-source.sh",
    ],
  ],
  [
    { ui: false, e2e: true, workflows: false },
    ["src/e2e/contract.ts", "src/e2e/hub-foundation.e2e.test.ts"],
  ],
  [{ ui: true, e2e: false, workflows: false }, ["e2e/apps.spec.ts"]],
  [
    { ui: false, e2e: false, workflows: true },
    ["scripts/cd/deploy.sh", "scripts/cd/deploy.node-test.mjs", ".github/pull_request_template.md"],
  ],
  [
    { ui: true, e2e: true, workflows: true },
    [
      ".github/workflows/ci.yml",
      ".github/workflows/nightly.yml",
      "package-lock.json",
      "brand-new-dir/file.txt",
      "mystery.bin",
    ],
  ],
  [
    { ui: false, e2e: false, workflows: false },
    [
      "src/daemons/lifecycle.test.ts",
      "src/daemons/lifecycle.node-test.mjs",
      "src/daemons/lifecycle.spec.tsx",
      "src/daemons/lifecycle.test.mts",
      "src/__tests__/helper.ts",
      "src/daemons/__snapshots__/lifecycle.snap",
      "src/daemons/test-fixtures/input.json",
      "docs/foo.md",
      "README.md",
      "scripts/lint-strict.node-test.mjs",
      "scripts/oxlint/hub-strict-plugin.node-test.mjs",
    ],
  ],
];

for (const [flags, paths] of cases) {
  for (const path of paths) {
    test(`classifies ${path}`, () => {
      assert.deepEqual(changedFlags([path]), flags);
    });
  }
}

test("combines flags from different paths", () => {
  assert.deepEqual(
    changedFlags(["e2e/apps.spec.ts", "src/e2e/contract.ts", "scripts/cd/deploy.sh", "README.md"]),
    { ui: true, e2e: true, workflows: true },
  );
});

test("runs no optional jobs for an empty change list", () => {
  assert.deepEqual(changedFlags([]), { ui: false, e2e: false, workflows: false });
});
