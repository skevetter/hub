import ts from "typescript";
import { generateRuntimeMap, readRuntimeInputs } from "./generate-test-runtime-files.mjs";
import runtimeFiles from "./test-runtime-files.json" with { type: "json" };
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { git } from "./test-context.mjs";
import { combinePaths, resolveBase, selectTests } from "./test-changed.mjs";

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
        ts,
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
      ts,
      "src/new.test.ts",
      `
    import { readdir as inspect } from "node:fs/promises";
    await inspect(new URL("../new-fixtures/", import.meta.url));
  `,
    ),
    ["new-fixtures/"],
  );
});

test("configuration and resolved setup changes select the full suite explicitly", () => {
  const setup = "src/support/global-setup.ts";
  const discovered = ["src/typography-policy.test.ts", "src/unit.test.ts"];
  for (const path of ["package.json", "vitest.config.ts", setup]) {
    const plan = selectTests([path], discovered, new Set([path]), false, { setupFiles: [setup] });
    assert.equal(plan.fullSuiteReason, path);
    assert.deepEqual([...plan.tests.keys()], discovered);
    assert.deepEqual(plan.related, []);
  }
});

test("coverage of the whole suite via the module graph is handed to the full runner", () => {
  const path = "src/widely-used.ts";
  const discovered = ["src/typography-policy.test.ts", "src/unit.test.ts"];
  const plan = selectTests([path], discovered, new Set([path]), false, { graphFiles: discovered });
  assert.equal(plan.fullSuiteReason, "selection covers every Vitest file");
  assert.deepEqual([...plan.tests.keys()], discovered);
});

async function releaseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "hub-test-base-"));
  t.after(() => rm(root, { recursive: true }));
  const run = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(root, "no-hooks")}`,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  run("init", "--quiet", "--initial-branch=main");
  const commit = (name) => {
    run("commit", "--quiet", "--allow-empty", "-m", name);
    return run("rev-parse", "HEAD");
  };
  const main = commit("main");
  run("update-ref", "refs/remotes/origin/main", main);
  return { root, run, commit, main, find: (base) => resolveBase(base, (args) => git(root, args)) };
}

test("the closest release merge base wins, with the highest version breaking ties", async (t) => {
  const { run, commit, main, find } = await releaseFixture(t);
  run("branch", "release/notifications-90", main);
  run("switch", "--quiet", "-c", "release/notifications-21");
  const older = commit("older release");
  run("switch", "--quiet", "-c", "release/notifications-22");
  const branchPoint = commit("release branch point");
  run("update-ref", "refs/remotes/origin/release/notifications-23", branchPoint);
  run("switch", "--quiet", "-c", "feature");
  commit("feature change");
  run("switch", "--quiet", "release/notifications-22");
  commit("release branch continued");
  run("switch", "--quiet", "feature");
  assert.equal(find().tree, branchPoint);
  assert.match(find().display, /origin\/release\/notifications-23/u);
  assert.match(find().reason, /closest release.*1 commit/u);

  run("update-ref", "-d", "refs/remotes/origin/release/notifications-23");
  assert.equal(find().tree, branchPoint);
  run("switch", "--quiet", "release/notifications-22");
  assert.equal(find().tree, older);
});

test("the upstream precedes origin/main when no release has a merge base", async (t) => {
  const { run, commit, main, find } = await releaseFixture(t);
  run("switch", "--quiet", "-c", "upstream");
  const upstream = commit("upstream change");
  run("switch", "--quiet", "-c", "feature");
  commit("feature change");
  run("branch", "--set-upstream-to=upstream");
  assert.equal(find().tree, upstream);
  assert.match(find().reason, /upstream/u);
  run("branch", "--unset-upstream");
  assert.equal(find().tree, main);
  assert.match(find().display, /origin\/main/u);
  assert.equal(find("HEAD").tree, run("rev-parse", "HEAD^{tree}"));
  assert.throws(() => find("missing"), /Could not resolve --base/u);
});

test("test-changed forwards TERM, INT and HUP and waits for the full-suite child", async (t) => {
  const { root, run } = await releaseFixture(t);
  for (const directory of ["scripts", "src/routes", "node_modules/vitest"])
    await mkdir(join(root, directory), { recursive: true });
  for (const file of [
    "test-changed.mjs",
    "test-context.mjs",
    "test-receipt.mjs",
    "test-worker-group.mjs",
    "generate-test-runtime-files.mjs",
  ])
    await cp(new URL(`./${file}`, import.meta.url), join(root, "scripts", file));

  for (const [path, contents] of Object.entries({
    ".gitignore": "node_modules/\nstatus-*\n",
    "scripts/test-runtime-files.json": "{}",
    "src/routeTree.gen.ts": "",
    "src/router.tsx": "",
    "src/start.ts": "",
    "src/start-server.ts": "",
    "src/typography-policy.test.ts": "",
    "node_modules/vitest/package.json": JSON.stringify({
      type: "module",
      exports: { "./node": "./node.js" },
    }),
    "node_modules/vitest/vitest.mjs": "",
    "node_modules/vitest/node.js": `export const createVitest = () => ({
      projects: [], globTestSpecifications: () => [], close() {},
    })`,
    "scripts/test-parallel.mjs": `
      import { writeFileSync } from "node:fs";
      const interval = setInterval(() => {}, 100);
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
        process.on(signal, () => setTimeout(() => {
          writeFileSync(process.env.STATUS_FILE, signal);
          clearInterval(interval);
        }, 120));
      }
      writeFileSync(process.env.STATUS_FILE, String(process.pid));
    `,
  }))
    await writeFile(join(root, path), contents);
  run("add", ".");
  run("commit", "--quiet", "-m", "Fixture scripts");
  await writeFile(join(root, "vitest.config.ts"), "");

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const marker = join(root, `status-${signal}`);
    const caller = spawn(
      process.execPath,
      [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"],
      {
        cwd: root,
        env: { ...process.env, STATUS_FILE: marker },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const exited = once(caller, "exit");
    let stderr = "";
    caller.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let childPid;
    try {
      for (let attempts = 0; !childPid && attempts < 400 && caller.exitCode === null; attempts++) {
        await delay(25);
        childPid = Number(await readFile(marker, "utf8").catch(() => ""));
      }
      assert.ok(childPid, stderr || "Full-suite child did not start");
      assert.notEqual(childPid, caller.pid);
      caller.kill(signal);
      const [code, terminatedBy] = await exited;
      assert.equal(await readFile(marker, "utf8"), signal);
      assert.equal(terminatedBy, null);
      assert.throws(() => process.kill(-childPid, 0), { code: "ESRCH" });
      assert.equal(code, 1);
    } finally {
      if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
      if (childPid && (await readFile(marker, "utf8")) === String(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await exited;
    }
  }
});
