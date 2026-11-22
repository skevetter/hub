import { generateRuntimeMap, readRuntimeInputs } from "./generate-test-runtime-files.mjs";
import runtimeFiles from "./test-runtime-files.json" with { type: "json" };
import assert from "node:assert/strict";
import { test } from "node:test";
import { combinePaths, selectTests } from "./test-changed.mjs";

test("combines tracked and untracked paths without splitting names on whitespace", () => {
  assert.deepEqual(
    combinePaths("src/a.ts\0src/name with spaces.ts\0", "src/a.ts\0src/new\nfile.ts\0"),
    ["src/a.ts", "src/name with spaces.ts", "src/new\nfile.ts"],
  );
});

test("keeps guard, changed and related test reasons separate", () => {
  const changes = [
    "docs/testing.md",
    "drizzle/001.sql",
    "src/auth/client.ts",
    "src/auth/client.test.ts",
    "scripts/test-changed.mjs",
  ];
  const plan = selectTests(changes, ["src/auth/client.test.ts"], new Set(changes), false);
  assert.deepEqual(
    [...plan.tests],
    [
      ["src/typography-policy.test.ts", "typography policy guard"],
      ["src/db/migrations.test.ts", "migration guard for drizzle changes"],
      ["src/db/migrations.integration.test.ts", "migration guard for drizzle changes"],
      ["src/auth/client.test.ts", "changed test file"],
    ],
  );
  assert.deepEqual(plan.related, ["src/auth/client.ts", "scripts/test-changed.mjs"]);
  assert.equal(plan.migrationChanged, true);
  assert.equal(plan.scriptsChanged, true);
});

test("deleted modules fall back to their folders without treating sibling prefixes as matches", () => {
  const plan = selectTests(
    ["src/auth/deleted.ts"],
    ["src/auth/open.test.ts", "src/authorization/token.test.ts"],
    new Set(),
    false,
  );
  assert.equal(plan.tests.get("src/auth/open.test.ts"), "deleted source in src/auth");
  assert.equal(plan.tests.has("src/authorization/token.test.ts"), false);
  assert.deepEqual(plan.related, []);
});

test("safe mode includes sibling tests for dynamically loaded files", () => {
  const changes = ["src/config/loader.ts", "src/db/fixture.sql", "src/auth/client.test.ts"];
  const plan = selectTests(
    changes,
    [
      "src/config/validation.test.ts",
      "src/db/statement.test.ts",
      "src/auth/client.test.ts",
      "src/auth/session.test.ts",
    ],
    new Set(changes),
    true,
  );
  assert.equal(plan.tests.get("src/config/validation.test.ts"), "safe mode for src/config");
  assert.equal(plan.tests.get("src/db/statement.test.ts"), "safe mode for src/db");
  assert.equal(plan.tests.get("src/auth/client.test.ts"), "changed test file");
  assert.equal(plan.tests.get("src/auth/session.test.ts"), "safe mode for src/auth");
  assert.deepEqual(plan.related, ["src/config/loader.ts"]);
  assert.equal(plan.migrationChanged, false);
});

test("runtime SQL selects the migration tests outside the touched folder", () => {
  const sql = "src/db/migrations/0001_machine_model.sql";
  const readers = ["src/db/migrations.test.ts", "src/db/migrations.integration.test.ts"];
  for (const safe of [false, true]) {
    const plan = selectTests([sql], readers, new Set([sql]), safe);
    for (const reader of readers) assert.match(plan.tests.get(reader), /runtime file/u);
  }
});

test("the checked-in map covers Vitest runtime reads", () => {
  assert.deepEqual(generateRuntimeMap(), runtimeFiles);
  assert.throws(
    () =>
      readRuntimeInputs(
        "src/new.test.ts",
        `
    import { readdir as inspect } from "node:fs/promises";
    await inspect(environmentPath);
  `,
      ),
    /Unmapped runtime read/u,
  );
  assert.deepEqual(
    readRuntimeInputs(
      "src/new.test.ts",
      `
    import { readdir as inspect } from "node:fs/promises";
    await inspect(new URL("../new-fixtures/", import.meta.url));
  `,
    ),
    ["new-fixtures/"],
  );
});
