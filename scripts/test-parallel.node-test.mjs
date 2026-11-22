import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import { constants, existsSync } from "node:fs";

import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("failure reporting keeps shard numbers and reruns only failed files in one process", async () => {
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
  assert.deepEqual(result, { exitCode: 1, failedFiles: ["b.test.ts"] });
  assert.match(output.join("\n"), /npm run test:parallel -- --rerun-failed/u);
  const serialExit = await rerunFiles(result.failedFiles, execute, (line) => output.push(line));

  assert.equal(peak, 2);
  assert.deepEqual(calls, [
    ["Shard 1", ["a.test.ts"]],
    ["Shard 2", ["b.test.ts", "c.test.ts"]],
    ["Serial rerun", ["b.test.ts"]],
  ]);
  assert.equal(serialExit, 0);
  assert.match(output.join("\n"), /Shard 2: FAIL.*\n.*b\.test\.ts/u);
  assert.match(output.join("\n"), /Total: 3 files, 3 passed, 1 failed, 0 skipped/u);
  assert.match(output.join("\n"), /Serial rerun: PASS/u);
});

test("a process failure with no named failed files offers to rerun the incomplete shard", async () => {
  const output = [];
  const result = await runShards([["a.test.ts"]], {
    execute: async () => ({
      durationMs: 100,
      counts: { passed: 0, failed: 0, skipped: 0 },
      failedFiles: [],
      exitCode: 1,
      diagnostic: "Vitest exited before writing a JSON report",
    }),
    print: (line) => output.push(line),
  });

  assert.deepEqual(result, { exitCode: 1, failedFiles: ["a.test.ts"] });
  assert.match(output.join("\n"), /Shard 1: FAIL.*\n.*Vitest exited before writing a JSON report/u);
  assert.match(output.join("\n"), /Total: 1 files, 0 passed, 1 failed/u);
  assert.match(output.join("\n"), /--rerun-failed/u);
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
  const invoke = async ([, , outputArg, completed, pending], shardDir) => {
    await mkdir(shardDir);
    const file = outputArg.slice("--outputFile=".length);
    const report = {
      success: true,
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 0,
      testResults: [
        { name: completed, status: "passed", assertionResults: [{ status: "passed" }] },
        { name: pending, status: "passed", assertionResults: [{ status: "pending" }] },
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
  const files = ["done.test.ts", "lost.test.ts", "later.test.ts"];
  const result = await runShards([files], {
    execute: (name, selected) =>
      executeFiles(process.cwd(), name, selected, directory, new AbortController().signal, invoke),
    print: (line) => output.push(line),
  });
  assert.deepEqual(result, { exitCode: 1, failedFiles: ["lost.test.ts", "later.test.ts"] });
  assert.match(output.join("\n"), /Shard 1:.*SIGKILL/u);
  assert.match(output.join("\n"), /Total: 3 files, 2 passed, 2 failed, 0 skipped/u);
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
      executeFiles(root, name, selected, directory, controller.signal, invoke),
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
  const result = await invokeVitest(directory, [], shard, new AbortController().signal);
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

async function parallelFixture(t, run) {
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
  await writeFile(join(root, "selected.test.ts"), "");
  const cache = join(root, "node_modules/.vite/vitest/test-parallel");
  await mkdir(cache, { recursive: true });
  await mkdir(join(root, "node_modules/vitest"));
  await writeFile(join(cache, "failed.json"), '["selected.test.ts"]');
  await writeFile(
    join(root, "node_modules/vitest/vitest.mjs"),
    `
    import { existsSync, renameSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const root = process.cwd();
    const file = join(root, "selected.test.ts");
    const output = (prefix) => process.argv.find((arg) => arg.startsWith(prefix)).slice(prefix.length);
    if (process.argv[2] === "list") {
      writeFileSync(output("--json="), JSON.stringify([{ file }]));
    } else {
      const report = { success: true, numPassedTests: 1, numFailedTests: 0,
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

test("TERM during shard timing-cache reads prevents successful suite metrics", async (t) => {
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
  assert.deepEqual(saved.selectedFiles, ["selected.test.ts"]);
  assert.deepEqual(saved.counts, { passed: 1, failed: 0, skipped: 0 });
});
