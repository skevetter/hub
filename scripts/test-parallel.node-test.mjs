import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import { constants, existsSync } from "node:fs";

import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  executeFiles,
  invokeVitest,
  partitionFiles,
  rerunFiles,
  runShards,
  shardEnvironment,
} from "./test-parallel.mjs";
import { fullSuiteLockHeld, runWorkerGroup, takeFullSuiteLock } from "./test-worker-group.mjs";

test("partition puts each file in one shard and balances cached durations", () => {
  const files = [
    { path: "small.test.ts", weight: 1 },
    { path: "fast.test.ts", weight: 2 },
    { path: "other.test.ts", weight: 3 },
    { path: "medium.test.ts", weight: 5 },
    { path: "slow.test.ts", weight: 9 },
  ];
  assert.deepEqual(partitionFiles(files, 2), [
    ["slow.test.ts", "small.test.ts"],
    ["medium.test.ts", "other.test.ts", "fast.test.ts"],
  ]);
  assert.deepEqual(partitionFiles(files.slice(0, 1), 4), [["small.test.ts"]]);
});

test("cached Hub timings balance two shards and only pin files above the ideal", () => {
  const daemon = join("src", "daemons", "daemons.test.ts");
  const measured = [111.79, 81.26, 58.85, 51.13, 32.84, 31.4];
  const remaining = 978.6 - measured.reduce((sum, duration) => sum + duration, 0);
  const files = [
    { path: daemon, weight: 13.5 },
    ...measured.map((weight, index) => ({ path: `slow-${index}.test.ts`, weight })),
    ...Array.from({ length: 328 }, (_, index) => ({
      path: `regular-${index}.test.ts`,
      weight: remaining / 328,
    })),
  ];
  const weights = new Map(files.map(({ path, weight }) => [path, weight]));
  const groups = partitionFiles(files, 2);
  assert.equal(groups.flat().length, 335);
  assert.ok(groups.every((group) => group.length > 1));
  assert.ok(groups.every((group) => group.reduce((sum, path) => sum + weights.get(path), 0) < 500));

  const heavy = [
    { path: daemon, weight: 633.82 },
    { path: "slow.test.ts", weight: 90 },
    { path: "medium.test.ts", weight: 50 },
  ];
  assert.deepEqual(partitionFiles(heavy, 2), [[daemon], ["slow.test.ts", "medium.test.ts"]]);
  assert.deepEqual(partitionFiles(heavy, 1), [[daemon, "slow.test.ts", "medium.test.ts"]]);
  const estimated = [{ ...heavy[0], cached: false }, ...heavy.slice(1)];
  const alsoHeavy = [...estimated, { path: "known.test.ts", weight: 900 }];
  assert.equal(partitionFiles(alsoHeavy, 2)[0][0], "known.test.ts");
});

test("failure reporting keeps shard numbers and reruns failed shards in one process", async () => {
  const calls = [];
  const output = [];
  let active = 0;
  let peak = 0;
  const execute = async (name, files) => {
    calls.push([name, files]);
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return {
      durationMs: 1250,
      counts: {
        passed: name === "Shard 2" ? 1 : 2,
        failed: name === "Shard 2" ? 1 : 0,
        skipped: 0,
      },
      failedFiles: name === "Shard 2" ? ["b.test.ts"] : [],
      exitCode: name === "Shard 2" ? 1 : 0,
    };
  };
  const result = await runShards([["a.test.ts"], ["b.test.ts", "c.test.ts"]], {
    execute,
    print: (line) => output.push(line),
  });
  assert.deepEqual(result, { exitCode: 1, failedFiles: ["b.test.ts", "c.test.ts"] });
  assert.match(output.join("\n"), /npm run test:parallel -- --rerun-failed/u);
  const serialExit = await rerunFiles(result.failedFiles, execute, (line) => output.push(line));

  assert.equal(peak, 2);
  assert.deepEqual(calls, [
    ["Shard 1", ["a.test.ts"]],
    ["Shard 2", ["b.test.ts", "c.test.ts"]],
    ["Serial rerun", ["b.test.ts", "c.test.ts"]],
  ]);
  assert.equal(serialExit, 0);
  assert.match(output.join("\n"), /Shard 2: FAIL.*\n.*b\.test\.ts/u);
  assert.match(output.join("\n"), /Total: 3 files, 3 passed, 1 failed, 0 skipped/u);
  assert.match(output.join("\n"), /Serial rerun: PASS/u);
});

test("a process failure with no named failed files offers a rerun without inflating failures", async () => {
  const output = [];
  const result = await runShards([["a.test.ts"]], {
    execute: async () => ({
      durationMs: 100,
      counts: { passed: 0, failed: 0, skipped: 0 },
      failedFiles: [],
      exitCode: 1,
      diagnostic: "Vitest failed after writing a complete JSON report",
    }),
    print: (line) => output.push(line),
  });

  assert.deepEqual(result, { exitCode: 1, failedFiles: ["a.test.ts"] });
  assert.match(output.join("\n"), /Shard 1: FAIL.*\n.*Vitest failed after writing/u);
  assert.match(output.join("\n"), /Total: 1 files, 0 passed, 0 failed/u);
  assert.match(output.join("\n"), /--rerun-failed/u);
});

test("shards report load before and after execution and warn only at the start", async () => {
  const output = [];
  const samples = [
    { averages: [5.125, 2, 3.256], cores: 4 },
    { averages: [6, 3.5, 2], cores: 4 },
  ];
  await runShards([["a.test.ts"]], {
    readLoad: () => samples.shift(),
    print: (line) => output.push(line),
    execute: async () => ({
      durationMs: 100,
      counts: { passed: 1, failed: 0, skipped: 0 },
      failedFiles: [],
      exitCode: 0,
    }),
  });
  assert.deepEqual(output, [
    "Machine load at start (1, 5, 15 min): 5.13, 2.00, 3.26; available cores: 4",
    "WARNING: Machine load exceeds available cores. Timings and timeouts may be unreliable.",
    "Shard 1: PASS in 0.10s, 1 files, 1 passed, 0 failed, 0 skipped",
    "Total: 1 files, 1 passed, 0 failed, 0 skipped",
    "Machine load at end (1, 5, 15 min): 6.00, 3.50, 2.00; available cores: 4",
  ]);
});

test("a shard runner error does not release the caller before sibling shards finish", async () => {
  const sibling = Promise.withResolvers();
  const outcome = runShards([["a.test.ts"], ["b.test.ts"]], {
    execute: async (name) => {
      if (name === "Shard 1") throw new Error("runner error");
      await sibling.promise;
      return {
        durationMs: 1,
        counts: { passed: 1, failed: 0, skipped: 0 },
        failedFiles: [],
        exitCode: 0,
      };
    },
    print: () => undefined,
  });
  let finished = false;
  outcome.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  sibling.resolve();
  assert.deepEqual(await outcome, { exitCode: 1, failedFiles: ["a.test.ts"] });
});

test("a worker that exits mid-run lists every missing file for serial rerun", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-fake-shard-"));
  t.after(() => rm(directory, { recursive: true }));
  const output = [];
  const invoke = async (args, shardDir) => {
    await mkdir(shardDir);
    const file = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
    const [completed, pending, placeholder] = args.filter((arg) => arg.endsWith(".test.ts"));
    const report = {
      success: true,
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 0,
      testResults: [
        { name: completed, status: "passed", assertionResults: [{ status: "passed" }] },
        { name: pending, status: "passed", assertionResults: [{ status: "pending" }] },
        { name: placeholder, status: "passed", assertionResults: [] },
      ],
    };
    const worker = spawnSync(process.execPath, [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], process.argv[2]); process.kill(process.pid, 'SIGKILL')",
      file,
      JSON.stringify(report),
    ]);
    return { exitCode: worker.status ?? 1, processError: worker.signal };
  };
  const files = ["done.test.ts", "lost.test.ts", "placeholder.test.ts", "later.test.ts"];
  const result = await runShards([files], {
    execute: (name, selected) =>
      executeFiles({
        root: process.cwd(),
        name,
        files: selected,
        runDirectory: directory,
        signal: new AbortController().signal,
        invoke,
      }),
    print: (line) => output.push(line),
  });
  assert.deepEqual(result, { exitCode: 1, failedFiles: files });
  assert.match(output.join("\n"), /Shard 1:.*SIGKILL/u);
  assert.match(
    output.join("\n"),
    /Shard 1: FAIL.*, 2 passed, 0 failed, 0 skipped, 3 files without a result/u,
  );
  assert.match(
    output.join("\n"),
    /Total: 4 files, 2 passed, 0 failed, 0 skipped, 3 files without a result/u,
  );
});

test("a zero exit still fails for missing, empty, or unexpected reports", async (t) => {
  const runDirectory = await mkdtemp(join(tmpdir(), "hub-incomplete-report-"));
  t.after(() => rm(runDirectory, { recursive: true }));
  const root = process.cwd();
  const files = ["expected.test.ts"];
  const extra = {
    name: join(root, "extra.test.ts"),
    status: "passed",
    assertionResults: [{ status: "passed" }],
  };
  const cases = [
    { name: "Missing", diagnostic: /without a readable JSON report/u },
    { name: "Empty", testResults: [], diagnostic: /Files without a result: expected.test.ts/u },
    {
      name: "Unexpected",
      testResults: [extra],
      diagnostic: /Unexpected files in report: extra.test.ts/u,
    },
  ];
  for (const { name, testResults, diagnostic } of cases) {
    const result = await executeFiles({
      root,
      name,
      files,
      runDirectory,
      signal: new AbortController().signal,
      invoke: async (_, directory) => {
        await mkdir(directory);
        if (testResults) {
          await writeFile(
            join(directory, "results.json"),
            JSON.stringify({
              success: true,
              numTotalTests: testResults.length,
              numPassedTests: testResults.length,
              numFailedTests: 0,
              testResults,
            }),
          );
        }
        return { exitCode: 0 };
      },
    });
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.incompleteFiles, 1, name);
    assert.match(result.diagnostic, diagnostic, name);
  }
});

test("takes over a stale full-suite lock and refuses a live owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-fake-lock-"));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "lock");
  const messages = [];
  await writeFile(path, JSON.stringify({ pid: process.pid, startTime: "old start", groups: [] }));
  const lock = await takeFullSuiteLock(path, (line) => messages.push(line));
  try {
    assert.match(messages.join("\n"), /stale full-suite lock/u);
    const owner = JSON.parse(await readFile(path, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.startTime, "old start");
    await assert.rejects(takeFullSuiteLock(path), /lock is held/u);
  } finally {
    await lock.release();
  }
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("waits for a worker group on abort and escalates when a descendant ignores TERM", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups");
  const directory = await mkdtemp(join(tmpdir(), "hub-fake-group-"));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "lock");
  const ready = join(directory, "worker-ready");
  const log = await open(join(directory, "worker.log"), "w");
  const lock = await takeFullSuiteLock(path);
  const controller = new AbortController();
  const worker = runWorkerGroup(
    [
      "-e",
      `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", \`
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => {}, 1000);
    \`, process.argv[1]], {stdio:"inherit"});
    setInterval(() => {}, 1000);
  `,
      ready,
    ],
    { cwd: directory, env: process.env, log, lock, signal: controller.signal, graceMs: 100 },
  );
  try {
    await waitFor(() => existsSync(ready), "fake child did not start");
    assert.equal(JSON.parse(await readFile(path, "utf8")).groups.length, 1);
    controller.abort("SIGTERM");
    const result = await worker;
    assert.notEqual(result.exitCode, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).groups.length, 0);
  } finally {
    controller.abort("SIGTERM");
    await worker.catch(() => undefined);
    await log.close();
    await lock.release();
  }
});

async function waitFor(predicate, message) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("recovers a killed runner's lock after its recorded group exits", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups");
  const directory = await mkdtemp(join(tmpdir(), "hub-killed-lock-"));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "lock");
  const ready = join(directory, "worker-ready");
  const code = `
    import { open } from "node:fs/promises";
    import { takeFullSuiteLock, runWorkerGroup } from ${JSON.stringify(new URL("./test-worker-group.mjs", import.meta.url).href)};
    const [path, ready] = process.argv.slice(1);
    const lock = await takeFullSuiteLock(path);
    const log = await open(path + ".log", "w");
    await runWorkerGroup(
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)", ready],
      { cwd: process.cwd(), env: process.env, log, lock, signal: new AbortController().signal },
    );
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code, "--", path, ready], {
    cwd: directory,
    stdio: "ignore",
  });
  const exited = once(owner, "exit");
  try {
    await waitFor(() => existsSync(ready), "fake runner did not start");
  } finally {
    owner.kill("SIGKILL");
    await exited;
  }
  const messages = [];
  const replacement = await takeFullSuiteLock(path, (message) => messages.push(message));
  assert.match(messages.join("\n"), /stale full-suite lock/u);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).groups, []);
  replacement.release();
});

test("a symlinked runner path still executes the CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-shard-symlink-"));
  t.after(() => rm(directory, { recursive: true }));
  const runner = fileURLToPath(new URL("./test-parallel.mjs", import.meta.url));
  await symlink(dirname(runner), join(directory, "scripts"), "dir");
  const result = spawnSync(process.execPath, [join(directory, "scripts/test-parallel.mjs")], {
    env: { ...process.env, TEST_SHARDS: "invalid" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Repository: .+/u);
  assert.match(result.stderr, /TEST_SHARDS must be a positive integer/u);
});

test("an interrupt reports incomplete files separately from failed assertions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-interrupted-shard-"));
  t.after(() => rm(directory, { recursive: true }));
  const root = process.cwd();
  const controller = new AbortController();
  const output = [];
  const files = ["failed.test.ts", "pending.test.ts", "missing.test.ts"];
  const invoke = async (args, shard) => {
    await mkdir(shard);
    const report = args.find((arg) => arg.startsWith("--outputFile=")).split("=")[1];
    await writeFile(
      report,
      JSON.stringify({
        success: false,
        numPassedTests: 0,
        numFailedTests: 1,
        testResults: [
          {
            name: join(root, files[0]),
            status: "failed",
            assertionResults: [{ status: "failed" }],
          },
          {
            name: join(root, files[1]),
            status: "passed",
            assertionResults: [{ status: "pending" }],
          },
        ],
      }),
    );
    controller.abort("SIGTERM");
    return { exitCode: 1, processError: "SIGTERM" };
  };

  const result = await runShards([files], {
    execute: (name, selected) =>
      executeFiles({
        root,
        name,
        files: selected,
        runDirectory: directory,
        signal: controller.signal,
        invoke,
      }),
    print: (line) => output.push(line),
    signal: controller.signal,
  });
  assert.deepEqual(result, { exitCode: 1, failedFiles: files });
  assert.match(output.join("\n"), /Total: 3 files, 0 passed, 1 failed, 0 skipped/u);
  assert.match(output.join("\n"), /^INTERRUPTED: 2 files did not report$/mu);
});

test("each shard isolates application data while keeping Mise's existing tool directory", () => {
  const parent = {
    HOME: "/home/tester",
    XDG_DATA_HOME: "/custom/data",
    PATH: "/tools/bin:/usr/bin",
    TESTCONTAINERS_RYUK_PORT: "1234",
  };
  const first = shardEnvironment("/tmp/first", parent);
  const second = shardEnvironment("/tmp/second", parent);
  assert.equal(first.XDG_DATA_HOME, "/tmp/first/data");
  assert.equal(second.XDG_DATA_HOME, "/tmp/second/data");
  assert.equal(first.TMPDIR, "/tmp/first");
  assert.equal(second.TMPDIR, "/tmp/second");
  assert.equal(first.HUB_VITEST_CACHE_DIR, "/tmp/first/vite");
  assert.equal(first.PASEO_HUB_DATA_DIR, "/tmp/first/embedded");
  assert.equal(first.TESTCONTAINERS_RYUK_PORT, undefined);
  assert.equal(first.PATH, parent.PATH);
  assert.equal(first.MISE_DATA_DIR, "/custom/data/mise");
  assert.equal(second.MISE_DATA_DIR, first.MISE_DATA_DIR);
  assert.equal(
    shardEnvironment("/tmp/first", { HOME: "/home/tester" }).MISE_DATA_DIR,
    "/home/tester/.local/share/mise",
  );
  assert.equal(
    shardEnvironment("/tmp/first", { ...parent, MISE_DATA_DIR: "/custom/mise" }).MISE_DATA_DIR,
    "/custom/mise",
  );
});

test("a launched shard receives the isolated data paths and caller's Mise install", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-worker-env-"));
  t.after(() => rm(directory, { recursive: true }));
  await mkdir(join(directory, "node_modules/vitest"), { recursive: true });
  await writeFile(
    join(directory, "node_modules/vitest/vitest.mjs"),
    `
    const { MISE_DATA_DIR, TMPDIR, XDG_DATA_HOME } = process.env;
    console.log(JSON.stringify({ MISE_DATA_DIR, TMPDIR, XDG_DATA_HOME }));
  `,
  );

  const shard = join(directory, "shard");
  const result = await invokeVitest([], {
    root: directory,
    directory: shard,
    signal: new AbortController().signal,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(join(shard, "vitest.log"), "utf8")), {
    MISE_DATA_DIR: shardEnvironment(shard).MISE_DATA_DIR,
    TMPDIR: shard,
    XDG_DATA_HOME: join(shard, "data"),
  });
});

test("reruns see a lock as held only while its owner or recorded groups run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-held-lock-"));
  t.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "lock");
  assert.equal(fullSuiteLockHeld(path), false);

  const lock = await takeFullSuiteLock(path, () => {});
  assert.equal(fullSuiteLockHeld(path), true);
  lock.release();

  const exited = spawn(process.execPath, ["-e", ""]);
  await once(exited, "exit");
  const owner = { pid: exited.pid, startTime: "Thu Jan  1 00:00:00 1970", groups: [] };
  await writeFile(path, JSON.stringify(owner));
  assert.equal(fullSuiteLockHeld(path), false);

  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    if (worker.exitCode === null) worker.kill("SIGKILL");
  });
  await writeFile(
    path,
    JSON.stringify({ ...owner, groups: [{ pid: worker.pid, startTime: "unknown" }] }),
  );
  assert.equal(fullSuiteLockHeld(path), true);
  worker.kill("SIGKILL");
  await once(worker, "exit");
  assert.equal(fullSuiteLockHeld(path), false);
});

async function parallelFixture(t, run, files = ["selected.test.ts"]) {
  const root = await mkdtemp(join(tmpdir(), "hub-parallel-test-"));
  t.after(() => rm(root, { recursive: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args]);
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Serial Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "Initialize fixture",
  );
  for (const file of files) await writeFile(join(root, file), "");
  const cache = join(root, "node_modules/.vite/vitest/test-parallel");
  await mkdir(cache, { recursive: true });
  await mkdir(join(root, "node_modules/vitest"));
  await writeFile(join(cache, "failed.json"), JSON.stringify({ version: 1, files }));
  await writeFile(
    join(root, "node_modules/vitest/vitest.mjs"),
    `
    import { existsSync, renameSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const root = process.cwd();
    const files = ${JSON.stringify(files)}.map((file) => join(root, file));
    const [file] = files;
    const output = (prefix) => process.argv.find((arg) => arg.startsWith(prefix)).slice(prefix.length);
    if (process.argv[2] === "list") {
      writeFileSync(output("--json="), JSON.stringify(files.map((file) => ({ file }))));
    } else {
      const report = { success: true, numPassedTests: 1, numFailedTests: 0, numTotalTests: 1,
        testResults: [{ name: file, status: "passed", assertionResults: [{ status: "passed" }] }] };
      const reportPath = output("--outputFile=");
      ${run}
    }
  `,
  );
  const runner = fileURLToPath(new URL("./test-parallel.mjs", import.meta.url));
  const lock = join(root, "suite.lock");
  const args = [runner, "--root", root];
  const options = {
    cwd: root,
    env: { ...process.env, TMPDIR: root, HUB_TEST_FULLSUITE_LOCK: lock, HUB_TEST_RUN_REPORT: "" },
  };
  return { root, lock, args, options };
}

test("a serial rerun owns the full-suite lock until its worker exits", async (t) => {
  const { root, lock, args, options } = await parallelFixture(
    t,
    `
    writeFileSync(join(root, "ready"), "");
    while (!existsSync(join(root, "release"))) await delay(10);
    writeFileSync(reportPath, JSON.stringify(report));
  `,
  );
  const caller = spawn(process.execPath, [...args, "--rerun-failed"], {
    ...options,
    stdio: "ignore",
  });
  const exited = once(caller, "exit");
  try {
    await waitFor(() => existsSync(join(root, "ready")), "serial worker did not start");
    assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, caller.pid);
    const contender = spawnSync(process.execPath, args, {
      ...options,
      encoding: "utf8",
      timeout: 1000,
    });
    assert.equal(contender.status, 1);
    assert.match(contender.stderr, /The full-suite lock is held/u);
  } finally {
    await writeFile(join(root, "release"), "");
    assert.deepEqual(await exited, [0, null]);
  }
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("TERM after the serial worker exits cannot turn its report into a pass", async (t) => {
  const { root, lock, args, options } = await parallelFixture(
    t,
    `
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [reportPath]);
    writeFileSync(join(root, "report.partial"), JSON.stringify({ reportPath, report }));
    renameSync(join(root, "report.partial"), join(root, "report.json"));
  `,
  );
  const marker = join(root, "report.json");
  const caller = spawn(process.execPath, [...args, "--rerun-failed"], {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [caller.stdout, caller.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk;
    });
  }
  const exited = once(caller, "close");
  const result = once(caller, "exit", { signal: AbortSignal.timeout(8000) });
  result.catch(() => {});
  let writer;
  try {
    await waitFor(() => existsSync(marker), "serial worker did not create its report pipe");
    const { reportPath, report } = JSON.parse(await readFile(marker, "utf8"));
    for (let attempt = 0; !writer && attempt < 300; attempt++) {
      try {
        writer = await open(reportPath, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        if (error.code !== "ENXIO") throw error;
        await delay(10);
      }
    }
    assert.ok(writer, output || "serial runner did not open the report pipe");
    caller.kill("SIGTERM");
    await delay(100);
    await writer.writeFile(JSON.stringify(report));
    await writer.close();
    writer = undefined;
    assert.deepEqual(await result, [1, null]);
    await exited;
    assert.match(output, /INTERRUPTED/u);
    assert.doesNotMatch(output, /Serial rerun: PASS/u);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally {
    if (writer) await writer.close();
    if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
    await exited;
  }
});

test("TERM during shard timing-cache reads preserves the prior successful cache", async (t) => {
  const { root, lock, args, options } = await parallelFixture(
    t,
    `
    const { mkdirSync } = await import("node:fs");
    const cache = join(process.env.HUB_VITEST_CACHE_DIR, "vitest/fixture");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "results.json"), JSON.stringify({ version: "fixture", results: [] }));
    writeFileSync(reportPath, JSON.stringify(report));
    `,
  );
  const preload = join(root, "pause-timings.mjs");
  const marker = join(root, "reading-timings");
  const metrics = join(root, "metrics.json");
  const cache = join(root, "node_modules/.vite/vitest/test-parallel/results.json");
  const previous = JSON.stringify({ version: "previous-success", results: [] });
  await writeFile(cache, previous);
  await writeFile(
    preload,
    `
    import { once } from "node:events";
    import { writeFileSync } from "node:fs";
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const readFile = fs.readFile;
    fs.readFile = async (path, ...args) => {
      const data = await readFile(path, ...args);
      if (String(path).endsWith("/vite/vitest/fixture/results.json")) {
        const keepAlive = setInterval(() => {}, 1000);
        const signal = once(process, "SIGTERM");
        writeFileSync(${JSON.stringify(marker)}, "");
        try { await signal; } finally { clearInterval(keepAlive); }
      }
      return data;
    };
    syncBuiltinESMExports();
    `,
  );

  const env = { ...options.env, TEST_SHARDS: "1", HUB_TEST_RUN_REPORT: metrics };
  const caller = spawn(process.execPath, ["--import", preload, ...args], {
    ...options,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(caller, "close");
  let output = "";
  for (const stream of [caller.stdout, caller.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk;
    });
  }
  try {
    await waitFor(
      () => existsSync(marker) || caller.exitCode !== null,
      "timing cache was not read",
    );
    assert.ok(existsSync(marker), output);
    const result = once(caller, "exit", { signal: AbortSignal.timeout(4000) });
    caller.kill("SIGTERM");
    assert.deepEqual(await result, [1, null]);
    await exited;
    assert.match(output, /Shard 1: PASS/u);
    assert.match(output, /INTERRUPTED: SIGTERM/u);
    await assert.rejects(readFile(metrics), { code: "ENOENT" });
    assert.equal(await readFile(cache, "utf8"), previous);
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally {
    if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
    await exited;
  }

  const passing = spawnSync(process.execPath, args, {
    ...options,
    env,
    encoding: "utf8",
    timeout: 4000,
  });
  assert.equal(passing.status, 0, passing.stderr);
  const saved = JSON.parse(await readFile(metrics, "utf8"));
  assert.equal(JSON.parse(await readFile(cache, "utf8")).version, "fixture");
  assert.deepEqual(saved.selectedFiles, ["selected.test.ts"]);
  assert.deepEqual(saved.counts, { passed: 1, failed: 0, skipped: 0 });
});

test("parallel shards and serial reruns fail when a passing worker leaves background children", async (t) => {
  for (const flags of [[], ["--rerun-failed"]]) {
    await t.test(flags[0] ?? "full suite", async (t) => {
      const { root, lock, args, options } = await parallelFixture(
        t,
        `
        const { spawn } = await import("node:child_process");
        writeFileSync(reportPath, JSON.stringify(report));
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3500)"],
          { stdio: ["ignore", "inherit", "inherit"] });
        writeFileSync(join(root, "descendant"), String(child.pid));
        child.unref();
      `,
      );
      const metrics = join(root, "metrics.json");
      try {
        const result = spawnSync(process.execPath, [...args, ...flags], {
          ...options,
          env: { ...options.env, HUB_TEST_RUN_REPORT: metrics },
          encoding: "utf8",
          timeout: 5000,
        });
        assert.equal(result.status, 1);
        assert.match(result.stdout, /background children were still running/iu);
        assert.doesNotMatch(result.stdout, /: PASS/u);
        await assert.rejects(readFile(metrics), { code: "ENOENT" });
        await assert.rejects(readFile(lock), { code: "ENOENT" });
      } finally {
        const pid = Number(await readFile(join(root, "descendant"), "utf8").catch(() => ""));
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
    });
  }
});

test("parallel testing rejects failed JSON assertions even when Vitest exits zero", async (t) => {
  const { root, args, options } = await parallelFixture(
    t,
    `
    report.numFailedTests = 1;
    report.testResults[0].status = "failed";
    report.testResults[0].assertionResults.push({ status: "failed" });
    writeFileSync(reportPath, JSON.stringify(report));
  `,
  );
  const metrics = join(root, "metrics.json");
  const result = spawnSync(process.execPath, args, {
    ...options,
    env: { ...options.env, HUB_TEST_RUN_REPORT: metrics },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Shard 1: FAIL/u);
  await assert.rejects(readFile(metrics), { code: "ENOENT" });
});

test("a failed shard keeps Vitest's human-readable errors alongside the JSON report", async (t) => {
  const { root, args, options } = await parallelFixture(
    t,
    `
    writeFileSync(reportPath, JSON.stringify(report));
    if (process.argv.includes("--reporter=default")) console.error("Unhandled Error: Worker exited unexpectedly");
    process.exitCode = 1;
    `,
  );
  const result = spawnSync(process.execPath, args, { ...options, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  const log = result.stdout.match(/See (.+?\/vitest\.log) and/u)?.[1];
  assert.ok(log, result.stdout);
  assert.ok((await realpath(log)).startsWith(`${await realpath(root)}/`), log);
  assert.match(await readFile(log, "utf8"), /Unhandled Error: Worker exited unexpectedly/u);
});

test("parallel testing cannot publish metrics after HEAD changes during the run", async (t) => {
  const { root, args, options } = await parallelFixture(
    t,
    `
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", [
      "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "--allow-empty", "--quiet", "-m", "Change fixture HEAD",
    ]);
    writeFileSync(reportPath, JSON.stringify(report));
  `,
  );
  const metrics = join(root, "metrics.json");
  const result = spawnSync(process.execPath, args, {
    ...options,
    env: { ...options.env, HUB_TEST_RUN_REPORT: metrics },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /HEAD changed while the test runner was active/u);
  await assert.rejects(readFile(metrics), { code: "ENOENT" });
});

test("serial reruns keep all files from a failed shard and require complete passing results", async (t) => {
  const files = ["a.test.ts", "b.test.ts"];
  const { root, args, options } = await parallelFixture(
    t,
    `
    const mode = process.env.FIXTURE_RUN_MODE;
    const selected = process.argv.filter((arg) => files.includes(arg));
    const b = files[1];
    const reported = mode === "missing" ? selected.filter((file) => file !== b) : selected;
    report.testResults = reported.map((name) => {
      const status = mode === "initial" && name === files[0] ? "failed" : "passed";
      const assertion = mode === "passing" && name === b ? "skipped" : status;
      return { name, status, assertionResults: [{ status: assertion }] };
    });
    report.numTotalTests = reported.length;
    report.numFailedTests = report.testResults.filter(({ status }) => status === "failed").length;
    report.numPassedTests = report.testResults.flatMap(({ assertionResults }) => assertionResults)
      .filter(({ status }) => status === "passed").length;
    report.success = report.numFailedTests === 0;
    if (mode === "initial" || (mode === "process-fails" && selected.includes(b))) process.exitCode = 1;
    writeFileSync(reportPath, JSON.stringify(report));
    `,
    files,
  );
  const metrics = join(root, "metrics.json");
  const run = (mode, ...flags) =>
    spawnSync(process.execPath, [...args, ...flags], {
      ...options,
      env: {
        ...options.env,
        TEST_SHARDS: "1",
        FIXTURE_RUN_MODE: mode,
        HUB_TEST_RUN_REPORT: metrics,
      },
      encoding: "utf8",
      timeout: 5000,
    });

  assert.equal(run("initial").status, 1);
  const processFailure = run("process-fails", "--rerun-failed");
  assert.equal(processFailure.status, 1, processFailure.stdout);
  assert.match(processFailure.stdout, /Vitest process failed \(exit 1,/u);
  assert.doesNotMatch(processFailure.stdout, /Serial rerun: PASS/u);
  await assert.rejects(readFile(metrics), { code: "ENOENT" });

  const incomplete = run("missing", "--rerun-failed");
  assert.equal(incomplete.status, 1, incomplete.stdout);
  assert.match(incomplete.stdout, /Files without a result: b\.test\.ts/u);
  assert.doesNotMatch(incomplete.stdout, /Serial rerun: PASS/u);
  await assert.rejects(readFile(metrics), { code: "ENOENT" });

  const passing = run("passing", "--rerun-failed");
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /Serial rerun: PASS/u);
  const saved = JSON.parse(await readFile(metrics, "utf8"));
  assert.deepEqual(saved.selectedFiles, files);
  assert.deepEqual(saved.counts, { passed: 1, failed: 0, skipped: 1 });

  await rm(metrics);
  await writeFile(
    join(root, "node_modules/.vite/vitest/test-parallel/failed.json"),
    '["a.test.ts"]',
  );
  const legacy = run("passing", "--rerun-failed");
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr, /failed-file list uses an unsupported format/u);
  await assert.rejects(readFile(metrics), { code: "ENOENT" });
});
