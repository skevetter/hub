import ts from "typescript";
import {
  formatRuntimeMap,
  generateRuntimeMap,
  readRuntimeInputs,
} from "./generate-test-runtime-files.mjs";
import runtimeFiles from "./test-runtime-files.json" with { type: "json" };
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { git } from "./test-context.mjs";
import { combinePaths, resolveBase, selectTests } from "./test-changed.mjs";

for (const name of ["TEST_SHARD_INDEX", "TEST_SHARD_TOTAL", "TEST_SHARD_REPORT_DIR"]) {
  delete process.env[name];
}

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

test("the checked-in map covers Vitest runtime reads", async () => {
  assert.deepEqual(generateRuntimeMap(), runtimeFiles);
  const root = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(
    formatRuntimeMap(root, generateRuntimeMap(root)),
    await readFile(join(root, "scripts/test-runtime-files.json"), "utf8"),
  );
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

async function changedFixture(t, scripts) {
  const fixture = await releaseFixture(t);
  const { root, run } = fixture;
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
    ...scripts,
  }))
    await writeFile(join(root, path), contents);
  run("add", ".");
  run("commit", "--quiet", "-m", "Fixture scripts");
  return fixture;
}

test("a closer upstream or origin/main beats an older release fork point", async (t) => {
  const { run, commit, find } = await releaseFixture(t);
  const forkPoint = commit("main before the release");
  run("switch", "--quiet", "-c", "release/notifications-1");
  commit("release change");
  run("switch", "--quiet", "main");
  commit("main after the release");
  const latest = commit("latest main");
  run("update-ref", "refs/remotes/origin/main", latest);
  run("switch", "--quiet", "-c", "feature");
  commit("feature change");
  assert.equal(find().tree, latest);
  assert.match(find().display, /origin\/main/u);
  assert.match(find().reason, /1 commits to HEAD/u);

  run("branch", "--set-upstream-to=main");
  assert.equal(find().tree, latest);
  assert.match(find().reason, /configured upstream/u);

  run("update-ref", "refs/remotes/origin/main", forkPoint);
  run("branch", "--unset-upstream");
  assert.match(find().display, /release\/notifications-1/u);
});

test("test-changed forwards TERM, INT and HUP and waits for the full-suite child", async (t) => {
  const { root } = await changedFixture(t, {
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
  });
  await writeFile(join(root, "vitest.config.ts"), "");

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const marker = join(root, `status-${signal}`);
    const caller = spawn(
      process.execPath,
      [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"],
      {
        cwd: root,
        env: {
          ...process.env,
          STATUS_FILE: marker,
          HUB_TEST_FULLSUITE_LOCK: join(root, "status-lock"),
        },
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

test("test-changed stops the selected Vitest run with its descendants and removes its temp files", async (t) => {
  const { root } = await changedFixture(t, {
    // Route listing succeeds; a run starts a grandchild and waits to be stopped.
    "node_modules/vitest/vitest.mjs": `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      if (process.argv[2] === "list") process.exit(0);
      const stubborn = process.env.STATUS_STUBBORN === "1";
      if (stubborn) process.on("SIGINT", () => writeFileSync(process.env.STATUS_FILE + "-signal", "SIGINT"));
      const script = "setInterval(() => {}, 1000)" + (stubborn ? "; process.on('SIGINT', () => {})" : "");
      const sleeper = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
      writeFileSync(process.env.STATUS_FILE, JSON.stringify({ leader: process.pid, sleeper: sleeper.pid }));
      setInterval(() => {}, 1000);
    `,
  });
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  };
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    const marker = join(root, `status-${signal}`);
    const temp = join(root, `status-tmp-${signal}`);
    await mkdir(temp);
    const caller = spawn(
      process.execPath,
      [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"],
      {
        cwd: root,
        env: {
          ...process.env,
          STATUS_FILE: marker,
          TMPDIR: temp,
          STATUS_STUBBORN: signal === "SIGINT" ? "1" : "0",
          HUB_TEST_FULLSUITE_LOCK: join(root, "status-lock"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(caller, "exit");
    let output = "";
    for (const stream of [caller.stdout, caller.stderr])
      stream.on("data", (chunk) => {
        output += chunk;
      });
    let started;
    try {
      for (let attempts = 0; !started && attempts < 400 && caller.exitCode === null; attempts++) {
        await delay(25);
        started = await readFile(marker, "utf8").then(JSON.parse, () => undefined);
      }
      assert.ok(started, output || "Selected Vitest child did not start");
      const lock = join(root, "status-lock");
      assert.equal(JSON.parse(await readFile(join(lock, "pid"), "utf8")).pid, caller.pid);
      caller.kill(signal);
      const [code, terminatedBy] = await once(caller, "exit", {
        signal: AbortSignal.timeout(5500),
      });
      if (signal === "SIGINT") assert.equal(await readFile(marker + "-signal", "utf8"), signal);
      await assert.rejects(stat(lock), { code: "ENOENT" });
      assert.equal(terminatedBy, null);
      assert.equal(code, 1);
      assert.match(output, new RegExp(`INTERRUPTED: ${signal}`, "u"));
      assert.throws(() => process.kill(-started.leader, 0), { code: "ESRCH" });
      assert.ok(gone(started.sleeper), "the grandchild survived");
      assert.deepEqual(await readdir(temp), []);
    } finally {
      if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
      for (const pid of [started?.leader, started?.sleeper])
        if (pid && !gone(pid)) process.kill(pid, "SIGKILL");
      await exited;
    }
  }
});

test("TERM during changed-runner cleanup prevents successful metrics", async (t) => {
  const { root } = await changedFixture(t, {
    "node_modules/vitest/vitest.mjs": `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      if (process.argv[2] === "run") {
        const output = process.argv.find((arg) => arg.startsWith("--outputFile=")).slice(13);
        writeFileSync(output, JSON.stringify({
          success: true, numPassedTests: 1, numFailedTests: 0, numTotalTests: 1,
          testResults: [{ name: join(process.cwd(), "src/typography-policy.test.ts"),
            status: "passed", assertionResults: [{ status: "passed" }] }],
        }));
      }
    `,
  });
  const marker = join(root, "status-cleanup");
  const preload = join(root, "status-pause-cleanup.mjs");
  const metrics = join(root, "status-metrics.json");
  const lock = join(root, "status-lock");
  const temp = join(root, "status-tmp");
  await mkdir(temp);
  await writeFile(
    preload,
    `
    import { once } from "node:events";
    import { writeFileSync } from "node:fs";
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { basename } from "node:path";
    const rm = fs.rm;
    fs.rm = async (path, ...args) => {
      await rm(path, ...args);
      if (!basename(path).startsWith("hub-changed-")) return;
      const keepAlive = setInterval(() => {}, 1000);
      const signal = once(process, "SIGTERM");
      writeFileSync(${JSON.stringify(marker)}, "ready");
      try { await signal; } finally { clearInterval(keepAlive); }
    };
    syncBuiltinESMExports();
    `,
  );

  const args = [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"];
  const env = {
    ...process.env,
    TMPDIR: temp,
    HUB_TEST_FULLSUITE_LOCK: lock,
    HUB_TEST_RUN_REPORT: metrics,
  };
  const caller = spawn(process.execPath, ["--import", preload, ...args], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(caller, "close");
  let output = "";
  caller.stdout.on("data", (chunk) => {
    output += chunk;
  });
  caller.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    let ready = "";
    for (let attempt = 0; !ready && attempt < 200 && caller.exitCode === null; attempt++) {
      ready = await readFile(marker, "utf8").catch(() => "");
      if (!ready) await delay(20);
    }
    assert.equal(ready, "ready", output);
    const result = once(caller, "exit", { signal: AbortSignal.timeout(4000) });
    caller.kill("SIGTERM");
    assert.deepEqual(await result, [1, null]);
    await exited;
    assert.match(output, /1 passed, 0 failed/u);
    assert.match(output, /INTERRUPTED: SIGTERM/u);
    await assert.rejects(readFile(metrics), { code: "ENOENT" });
    await assert.rejects(stat(lock), { code: "ENOENT" });
    assert.deepEqual(await readdir(temp), []);
  } finally {
    if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
    await exited;
  }

  const passing = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 4000,
  });
  assert.equal(passing.status, 0, passing.stderr);
  const saved = JSON.parse(await readFile(metrics, "utf8"));
  assert.deepEqual(saved.selectedFiles, ["src/typography-policy.test.ts"]);
  assert.deepEqual(saved.counts, { passed: 1, failed: 0, skipped: 0 });
});

test("the changed runner fails if a passing worker leaves background children", async (t) => {
  const { root } = await changedFixture(t, {
    "node_modules/vitest/vitest.mjs": `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      if (process.argv[2] === "run") {
        const path = process.argv.find((arg) => arg.startsWith("--outputFile=")).slice(13);
        writeFileSync(path, JSON.stringify({
          success: true, numPassedTests: 1, numFailedTests: 0, numTotalTests: 1,
          testResults: [{ name: join(process.cwd(), "src/typography-policy.test.ts"),
            status: "passed", assertionResults: [{ status: "passed" }] }],
        }));
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3500)"],
          { stdio: ["ignore", "inherit", "inherit"] });
        writeFileSync("status-descendant", String(child.pid));
        child.unref();
      }
    `,
  });
  const metrics = join(root, "status-metrics.json");
  const lock = join(root, "status-lock");
  const temp = join(root, "status-tmp");
  await mkdir(temp);
  try {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"],
      {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: temp,
          HUB_TEST_FULLSUITE_LOCK: lock,
          HUB_TEST_RUN_REPORT: metrics,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /background children were still running/iu);
    await assert.rejects(readFile(metrics), { code: "ENOENT" });
    await assert.rejects(stat(lock), { code: "ENOENT" });
  } finally {
    const pid = Number(await readFile(join(root, "status-descendant"), "utf8").catch(() => ""));
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
});

test("changed testing rejects failed JSON assertions even when Vitest exits zero", async (t) => {
  const { root } = await changedFixture(t, {
    "node_modules/vitest/vitest.mjs": `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      if (process.argv[2] === "run") {
        const output = process.argv.find((arg) => arg.startsWith("--outputFile=")).slice(13);
        writeFileSync(output, JSON.stringify({
          success: false, numPassedTests: 0, numFailedTests: 1, numTotalTests: 1,
          testResults: [{ name: join(process.cwd(), "src/typography-policy.test.ts"),
            status: "failed", assertionResults: [{ status: "failed" }] }],
        }));
      }
    `,
  });
  const metrics = join(root, "status-metrics.json");
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"],
    {
      cwd: root,
      env: {
        ...process.env,
        TMPDIR: root,
        HUB_TEST_FULLSUITE_LOCK: join(root, "status-lock"),
        HUB_TEST_RUN_REPORT: metrics,
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Vitest JSON report did not show a completed passing run/u);
  await assert.rejects(readFile(metrics), { code: "ENOENT" });
});

test("changed testing refuses full-suite metrics for a different commit", async (t) => {
  const { root, run } = await changedFixture(t, {
    "scripts/test-parallel.mjs": `
      import { realpathSync, writeFileSync } from "node:fs";
      writeFileSync(process.env.HUB_TEST_RUN_REPORT, JSON.stringify({
        root: realpathSync(process.cwd()), head: process.env.FIXTURE_TESTED_HEAD,
        selectedFiles: ["src/typography-policy.test.ts"],
        counts: { passed: 1, failed: 0, skipped: 0 }, checks: [],
      }));
    `,
  });
  await writeFile(join(root, "vitest.config.ts"), "");
  const metrics = join(root, "status-metrics.json");
  const runWithHead = (head) =>
    spawnSync(process.execPath, [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"], {
      cwd: root,
      env: {
        ...process.env,
        TMPDIR: root,
        HUB_TEST_FULLSUITE_LOCK: join(root, "status-lock"),
        HUB_TEST_RUN_REPORT: metrics,
        FIXTURE_TESTED_HEAD: head,
      },
      encoding: "utf8",
      timeout: 5000,
    });
  const result = runWithHead("0".repeat(40));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /The command tested .* at 0000000000/u);
  await assert.rejects(readFile(metrics), { code: "ENOENT" });

  const head = run("rev-parse", "HEAD");
  const passing = runWithHead(head);
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(JSON.parse(await readFile(metrics, "utf8")).head, head);
});

test("changed testing rejects missing files in both direct runs and full-suite handoffs", async (t) => {
  const { root } = await changedFixture(t, {
    "node_modules/vitest/node.js": `
      import { join } from "node:path";
      export const createVitest = () => ({
        projects: [], close() {},
        globTestSpecifications: () => ["src/typography-policy.test.ts", "src/omitted.test.ts", "src/unrelated.test.ts"]
          .map((file) => ({ moduleId: join(process.cwd(), file) })),
      });
    `,
    "node_modules/vitest/vitest.mjs": `
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      if (process.argv[2] === "run") {
        const output = process.argv.find((arg) => arg.startsWith("--outputFile=")).slice(13);
        writeFileSync(output, JSON.stringify({
          success: true, numPassedTests: 1, numFailedTests: 0, numTotalTests: 1,
          testResults: [{ name: join(process.cwd(), "src/typography-policy.test.ts"),
            status: "passed", assertionResults: [{ status: "passed" }] }],
        }));
      }
    `,
    "scripts/test-parallel.mjs": `
      import { execFileSync } from "node:child_process";
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.HUB_TEST_RUN_REPORT, JSON.stringify({
        root: process.cwd(), head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        selectedFiles: ["src/typography-policy.test.ts"],
        counts: { passed: 1, failed: 0, skipped: 0 }, checks: [],
      }));
    `,
  });
  const metrics = join(root, "status-metrics.json");
  for (const changed of ["src/omitted.test.ts", "vitest.config.ts"]) {
    await writeFile(join(root, changed), "");
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/test-changed.mjs"), "--base", "HEAD"],
      {
        cwd: root,
        env: {
          ...process.env,
          TMPDIR: root,
          HUB_TEST_FULLSUITE_LOCK: join(root, "status-lock"),
          HUB_TEST_RUN_REPORT: metrics,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /Vitest did not report these selected files: src\/omitted\.test\.ts/u,
    );
    await assert.rejects(readFile(metrics), { code: "ENOENT" });
  }
});
