import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import { constants, existsSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";

import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  executeFiles,
  invokeVitest,
  partitionFiles,
  planShards,
  rerunFiles,
  runShards,
  shardEnvironment,
  weighFiles,
} from "./test-parallel.mjs";
import baselineTimings from "./test-timings.json" with { type: "json" };
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

test("the shard plan rounds and clamps the core count without using load", () => {
  for (const [cores, count] of [
    [1, 1],
    [8, 3],
    [12, 4],
    [48, 6],
  ]) {
    const readLoad = () => ({ averages: [150, 0, 0], cores });
    assert.equal(planShards(undefined, readLoad).count, count);
  }
  const override = planShards(8, () => ({ averages: [150, 0, 0], cores: 12 }));
  assert.equal(override.count, 8);
  assert.equal(override.reason, "TEST_SHARDS");
});

test("the shard plan scales all three timeouts from the higher one- or five-minute load", () => {
  const cases = [
    [2, 3, 5, 1, 30_000, 10_000],
    [11.91, 20.4, 5, 1.7, 51_000, 17_000],
    [18, 2, 1, 1.5, 45_000, 15_000],
    [150, 2, 1, 4, 120_000, 40_000],
  ];
  for (const [load1, load5, minutes, multiplier, testTimeout, otherTimeout] of cases) {
    const readLoad = () => ({ averages: [load1, load5, 900], cores: 12 });
    const plan = planShards(undefined, readLoad);
    assert.equal(plan.multiplier, multiplier);
    assert.deepEqual(plan.timeoutLoad, { minutes, average: Math.max(load1, load5) });
    assert.equal(plan.count, 4);
    assert.deepEqual(plan.timeoutFlags, [
      `--testTimeout=${testTimeout}`,
      `--hookTimeout=${otherTimeout}`,
      `--teardownTimeout=${otherTimeout}`,
    ]);
  }
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

test("planning uses the baseline on a fresh cache and never reads focused timings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hub-planner-"));
  t.after(() => rm(root, { recursive: true }));
  const cacheRoot = join(root, "cache");
  const files = ["src/daemons/daemons.test.ts", "src/app.test.ts", "new.test.ts"];
  await mkdir(join(root, "src/daemons"), { recursive: true });
  for (const file of files) await writeFile(join(root, file), "fixture");
  const readPlan = () => weighFiles(root, cacheRoot, files);
  const fresh = await readPlan();
  assert.deepEqual(
    fresh.slice(0, 2).map(({ weight }) => weight),
    files.slice(0, 2).map((file) => Math.max(1, baselineTimings[file])),
  );
  assert.deepEqual(
    fresh.map(({ cached }) => cached),
    [true, true, false],
  );

  const focused = join(cacheRoot, "focused");
  await mkdir(focused, { recursive: true });
  const focusedResults = files.map((file) => [`project:${file}`, { duration: 5_683 }]);
  await writeFile(join(focused, "results.json"), JSON.stringify({ results: focusedResults }));
  assert.deepEqual(await readPlan(), fresh);

  const full = join(cacheRoot, "test-parallel");
  await mkdir(full);
  await writeFile(
    join(full, "results.json"),
    JSON.stringify({ results: [[`project:${files[0]}`, { duration: 12_000 }]] }),
  );
  assert.deepEqual(
    await readPlan(),
    files.map((path, index) => ({
      path,
      weight: 12_000,
      cached: index === 0,
    })),
  );
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

async function tempLock(t) {
  const directory = await mkdtemp(join(tmpdir(), "hub-fake-lock-"));
  t.after(() => rm(directory, { recursive: true }));
  return join(directory, "lock");
}

async function readOwner(path) {
  return JSON.parse(await readFile(join(path, "pid"), "utf8"));
}

test("takes over a stale full-suite lock with a mismatched start time", async (t) => {
  const path = await tempLock(t);
  await mkdir(path);
  await writeFile(
    join(path, "pid"),
    JSON.stringify({ pid: process.pid, startTime: "old start", groups: [] }),
  );
  await writeFile(join(path, "pid.00000000-0000-0000-0000-000000000000.tmp"), "unfinished update");
  const messages = [];
  const lock = await takeFullSuiteLock(path, (line) => messages.push(line));
  assert.deepEqual(messages, [
    `Reclaiming stale full-suite lock at ${path} from PID ${process.pid}.`,
  ]);
  const owner = await readOwner(path);
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.startTime, "old start");
  lock.release();
});

test("refuses a live full-suite owner and reports its PID", async (t) => {
  const path = await tempLock(t);
  const lock = await takeFullSuiteLock(path);
  const owner = await readOwner(path);
  await assert.rejects(takeFullSuiteLock(path), {
    message: `The full-suite lock is held at ${path}. Owner PID ${process.pid}.`,
  });
  assert.deepEqual(await readOwner(path), owner);
  lock.release();
});

test("refuses a hand-made directory with no usable pid file", async (t) => {
  const path = await tempLock(t);
  await mkdir(path);
  assert.equal(fullSuiteLockHeld(path), true);
  await assert.rejects(takeFullSuiteLock(path), /no pid file/u);
  assert.ok((await stat(path)).isDirectory());
  await writeFile(join(path, "pid"), "{");
  assert.equal(fullSuiteLockHeld(path), true);
  await assert.rejects(takeFullSuiteLock(path), /no pid file/u);
  assert.equal(await readFile(join(path, "pid"), "utf8"), "{");
});

test("refuses a legacy lock file without changing it", async (t) => {
  const path = await tempLock(t);
  await writeFile(path, "legacy");
  assert.equal(fullSuiteLockHeld(path), true);
  await assert.rejects(takeFullSuiteLock(path), /not a directory.*removing it by hand/u);
  assert.equal(await readFile(path, "utf8"), "legacy");
});

test("refuses a live plain PID", async (t) => {
  const path = await tempLock(t);
  await mkdir(path);
  await writeFile(join(path, "pid"), `${process.pid}\n`);
  assert.equal(fullSuiteLockHeld(path), true);
  await assert.rejects(takeFullSuiteLock(path), {
    message: `The full-suite lock is held at ${path}. Owner PID ${process.pid}.`,
  });
});

test("reclaims a dead plain PID", async (t) => {
  const path = await tempLock(t);
  const exited = spawn(process.execPath, ["-e", ""]);
  assert.deepEqual(await once(exited, "exit"), [0, null]);
  await mkdir(path);
  await writeFile(join(path, "pid"), `${exited.pid}\n`);
  assert.equal(fullSuiteLockHeld(path), false);
  const messages = [];
  const lock = await takeFullSuiteLock(path, (line) => messages.push(line));
  assert.deepEqual(messages, [
    `Reclaiming stale full-suite lock at ${path} from PID ${exited.pid}.`,
  ]);
  assert.equal((await readOwner(path)).pid, process.pid);
  lock.release();
});

test("release removes the pid file and its directory", async (t) => {
  const path = await tempLock(t);
  const lock = await takeFullSuiteLock(path);
  assert.ok((await stat(path)).isDirectory());
  assert.ok((await stat(join(path, "pid"))).isFile());
  lock.release();
  await assert.rejects(stat(join(path, "pid")), { code: "ENOENT" });
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("release refuses while groups are registered", async (t) => {
  const path = await tempLock(t);
  const lock = await takeFullSuiteLock(path);
  lock.track(process.pid);
  assert.throws(() => lock.release(), /groups remain registered/u);
  assert.deepEqual(
    (await readOwner(path)).groups.map(({ pid }) => pid),
    [process.pid],
  );
  lock.forget(process.pid);
  lock.release();
});

test("release refuses to remove a different owner's pid file", async (t) => {
  const path = await tempLock(t);
  const lock = await takeFullSuiteLock(path);
  const replacement = { ...(await readOwner(path)), token: "replacement" };
  await writeFile(join(path, "pid"), JSON.stringify(replacement));
  assert.throws(() => lock.release(), /lock changed owners/u);
  assert.deepEqual(await readOwner(path), replacement);
});

const lockModule = new URL("./test-worker-group.mjs", import.meta.url).href;

function lockContender(path) {
  const code = `
    import { once } from "node:events";
    import { takeFullSuiteLock } from ${JSON.stringify(lockModule)};
    const start = once(process, "message");
    const finish = once(process, "disconnect");
    process.send("ready");
    await start;
    let lock;
    try {
      lock = await takeFullSuiteLock(process.argv[1], () => {});
      process.send("won");
    } catch (error) {
      process.send(error.message);
    }
    await finish;
    lock?.release();
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", code, "--", path], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

test("exactly one concurrent taker wins", async (t) => {
  for (const mode of ["fresh", "stale"]) {
    await t.test(mode, async (t) => {
      const path = await tempLock(t);
      if (mode === "stale") {
        await mkdir(path);
        await writeFile(
          join(path, "pid"),
          JSON.stringify({ pid: process.pid, startTime: "old start", groups: [] }),
        );
      }
      const children = Array.from({ length: 6 }, () => lockContender(path));
      const exits = children.map((child) => once(child, "exit"));
      const signal = AbortSignal.timeout(10_000);
      try {
        await Promise.all(children.map((child) => once(child, "message", { signal })));
        const results = Promise.all(children.map((child) => once(child, "message", { signal })));
        for (const child of children) child.send("take");
        const outcomes = (await results).map(([outcome]) => outcome);
        assert.equal(
          outcomes.filter((result) => result === "won").length,
          1,
          JSON.stringify(outcomes),
        );
        for (const result of outcomes.filter((result) => result !== "won"))
          assert.match(result, /The full-suite lock is held at/u);
        assert.equal((await readOwner(path)).pid, children[outcomes.indexOf("won")].pid);
      } finally {
        for (const child of children) {
          if (child.connected) child.disconnect();
        }
        await Promise.all(exits);
      }
      await assert.rejects(stat(path), { code: "ENOENT" });
    });
  }
});

test("a reclaim race loser keeps the winner's lock", async (t) => {
  const path = await tempLock(t);
  const pidFile = join(path, "pid");
  await mkdir(path);
  await writeFile(
    pidFile,
    JSON.stringify({ pid: process.pid, startTime: "old start", groups: [] }),
  );
  const winner = `${process.pid}\n`;
  await assert.rejects(
    takeFullSuiteLock(path, () => {
      unlinkSync(pidFile);
      rmdirSync(path);
      mkdirSync(path);
      writeFileSync(pidFile, winner);
    }),
    /lock is held/u,
  );
  assert.equal(await readFile(pidFile, "utf8"), winner);
});

test("a reclaim race loser keeps an owner with the same PID and a different token", async (t) => {
  const path = await tempLock(t);
  const pidFile = join(path, "pid");
  const staleOwner = { pid: process.pid, startTime: "old start", token: "stale", groups: [] };
  const winner = { ...staleOwner, token: "winner" };
  await mkdir(path);
  await writeFile(pidFile, JSON.stringify(staleOwner));
  await assert.rejects(
    takeFullSuiteLock(path, () => writeFileSync(pidFile, JSON.stringify(winner))),
    /lock is held/u,
  );
  assert.deepEqual(await readOwner(path), winner);
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
    assert.equal((await readOwner(path)).groups.length, 1);
    controller.abort("SIGTERM");
    const result = await worker;
    assert.notEqual(result.exitCode, 0);
    assert.equal((await readOwner(path)).groups.length, 0);
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
    import { takeFullSuiteLock, runWorkerGroup } from ${JSON.stringify(lockModule)};
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
  assert.deepEqual((await readOwner(path)).groups, []);
  replacement.release();
});

test("a symlinked runner path still executes the CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-shard-symlink-"));
  t.after(() => rm(directory, { recursive: true }));
  const runner = fileURLToPath(new URL("./test-parallel.mjs", import.meta.url));
  await symlink(dirname(runner), join(directory, "scripts"), "dir");
  const result = spawnSync(process.execPath, [join(directory, "scripts/test-parallel.mjs")], {
    env: {
      ...process.env,
      TEST_SHARDS: "invalid",
      HUB_TEST_FULLSUITE_LOCK: join(directory, "lock"),
    },
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
  await mkdir(path);
  await writeFile(join(path, "pid"), JSON.stringify(owner));
  assert.equal(fullSuiteLockHeld(path), false);

  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    if (worker.exitCode === null) worker.kill("SIGKILL");
  });
  const workerOwner = { ...owner, groups: [{ pid: worker.pid, startTime: "unknown" }] };
  await writeFile(join(path, "pid"), JSON.stringify(workerOwner));
  assert.equal(fullSuiteLockHeld(path), true);
  await assert.rejects(takeFullSuiteLock(path), /lock is held/u);
  assert.deepEqual(await readOwner(path), workerOwner);
  worker.kill("SIGKILL");
  await once(worker, "exit");
  assert.equal(fullSuiteLockHeld(path), false);
  const replacement = await takeFullSuiteLock(path, () => {});
  replacement.release();
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
        testResults: [{ name: file, status: "passed", startTime: 1000.1, endTime: 1250.7,
          assertionResults: [{ status: "passed" }] }] };
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
    assert.equal((await readOwner(lock)).pid, caller.pid);
    const contender = spawnSync(process.execPath, args, {
      ...options,
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    const details = `contender exit code=${contender.status}, signal=${contender.signal}, error=${contender.error?.message ?? "none"}; stderr: ${contender.stderr}`;
    assert.equal(contender.error, undefined, details);
    assert.deepEqual([contender.status, contender.signal], [1, null], details);
    assert.match(contender.stderr, /The full-suite lock is held/u, details);
  } finally {
    await writeFile(join(root, "release"), "");
    assert.deepEqual(await exited, [0, null]);
  }
  await assert.rejects(stat(lock), { code: "ENOENT" });
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
    await assert.rejects(stat(lock), { code: "ENOENT" });
  } finally {
    if (writer) await writer.close();
    if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
    await exited;
  }
});

test("TERM during a shard report read preserves the prior timing cache", async (t) => {
  const { root, lock, args, options } = await parallelFixture(
    t,
    `
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
      if (String(path).endsWith("/shard-1/results.json")) {
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
      "shard report was not read",
    );
    assert.ok(existsSync(marker), output);
    const result = once(caller, "exit", { signal: AbortSignal.timeout(4000) });
    caller.kill("SIGTERM");
    assert.deepEqual(await result, [1, null]);
    await exited;
    assert.match(output, /Shard 1: FAIL/u);
    assert.match(output, /INTERRUPTED: SIGTERM/u);
    await assert.rejects(readFile(metrics), { code: "ENOENT" });
    assert.equal(await readFile(cache, "utf8"), previous);
    await assert.rejects(stat(lock), { code: "ENOENT" });
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
  assert.deepEqual(JSON.parse(await readFile(cache, "utf8")), {
    version: 1,
    results: [["selected.test.ts", { duration: 251 }]],
  });
  assert.deepEqual(saved.selectedFiles, ["selected.test.ts"]);
  assert.deepEqual(saved.counts, { passed: 1, failed: 0, skipped: 0 });
});

test("timings are saved only when every shard finished, even if assertions failed", async (t) => {
  const { root, args, options } = await parallelFixture(
    t,
    `
    const result = report.testResults[0];
    result.name = files.find((name) => process.argv.includes(name));
    const mode = process.env.FIXTURE_RUN_MODE;
    if (result.name === files[0]) {
      if (["failed", "fork-crash", "signal", "missing-log"].includes(mode)) {
        result.status = "failed";
        result.assertionResults[0].status = "failed";
        report.numPassedTests = 0;
        report.numFailedTests = 1;
        report.success = false;
        process.exitCode = 1;
      }
      if (mode === "fork-crash") {
        console.error("x".repeat(65_530));
        console.error("Vitest caught 1 unhandled error during the test run.");
      }
      if (mode === "pending") result.assertionResults[0].status = "pending";
      if (mode === "empty") result.assertionResults = [];
      if (mode === "missing") report.testResults = [];
    }
    writeFileSync(reportPath, JSON.stringify(report));
    if (result.name === files[0] && mode.startsWith("missing-log")) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(process.env.TMPDIR, "vitest.log"));
    }
    if (result.name === files[0] && mode === "signal") process.kill(process.pid, "SIGKILL");
    `,
    ["a.test.ts", "b.test.ts"],
  );
  const cache = join(root, "node_modules/.vite/vitest/test-parallel/results.json");
  const previous = JSON.stringify({
    version: 1,
    results: [
      ["a.test.ts", { duration: 1350 }],
      ["b.test.ts", { duration: 750 }],
    ],
  });
  const modes = [
    "failed",
    "fork-crash",
    "signal",
    "pending",
    "empty",
    "missing",
    "missing-log",
    "missing-log-pass",
  ];
  for (const mode of modes) {
    await writeFile(cache, previous);
    const run = spawnSync(process.execPath, args, {
      ...options,
      env: { ...options.env, TEST_SHARDS: "2", FIXTURE_RUN_MODE: mode },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(
      run.status,
      mode === "missing-log-pass" ? 0 : 1,
      `${mode}: ${run.error ?? run.stderr}`,
    );
    assert.match(run.stdout, /Shard 1 estimate: 1\.35s \(1 files\)/u);
    assert.match(run.stdout, /Shard 2 estimate: 0\.75s \(1 files\)/u);
    if (mode === "missing-log") {
      assert.match(run.stdout, /Shard 1: FAIL.*, 0 passed, 1 failed, 0 skipped/u);
      assert.match(run.stdout, /Shard 1: Vitest process failed \(exit 1, no signal\)/u);
      assert.match(run.stdout, /Total: 2 files, 1 passed, 1 failed, 0 skipped$/mu);
      assert.doesNotMatch(run.stdout, /Runner stopped/u);
    }
    if (mode === "missing-log-pass") {
      assert.match(run.stdout, /Total: 2 files, 2 passed, 0 failed, 0 skipped$/mu);
    }
    const saved = await readFile(cache, "utf8");
    if (mode === "failed") {
      assert.deepEqual(Object.fromEntries(JSON.parse(saved).results), {
        "a.test.ts": { duration: 251 },
        "b.test.ts": { duration: 251 },
      });
    } else {
      assert.equal(saved, previous, mode);
    }
  }
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
        await assert.rejects(stat(lock), { code: "ENOENT" });
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
    console.log(process.argv.filter((arg) => /^--(test|hook|teardown)Timeout=/u.test(arg)).join(" "));
    if (process.argv.includes("--reporter=default")) console.error("Unhandled Error: Worker exited unexpectedly");
    process.exitCode = 1;
    `,
  );
  const result = spawnSync(process.execPath, args, {
    ...options,
    env: { ...options.env, TEST_SHARDS: "2" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /across 1 shards \(2 requested: TEST_SHARDS\)/u);
  const timeouts = result.stdout.match(
    /^Vitest shard timeouts \([\d.]+x from [15]-min load [\d.]+, ms\): (--testTimeout=\d+ --hookTimeout=\d+ --teardownTimeout=\d+)$/mu,
  )?.[1];
  assert.ok(timeouts, result.stdout);
  const log = result.stdout.match(/See (.+?\/vitest\.log) and/u)?.[1];
  assert.ok(log, result.stdout);
  assert.ok((await realpath(log)).startsWith(`${await realpath(root)}/`), log);
  const logContents = await readFile(log, "utf8");
  assert.ok(logContents.split("\n").includes(timeouts), logContents);
  assert.match(logContents, /Unhandled Error: Worker exited unexpectedly/u);
});

test("a HEAD change prevents timing promotion whether tests passed or failed", async (t) => {
  const { root, args, options } = await parallelFixture(
    t,
    `
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", [
      "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "--allow-empty", "--quiet", "-m", "Change fixture HEAD",
    ]);
    if (process.env.FIXTURE_RUN_MODE === "failed") {
      report.testResults[0].status = "failed";
      report.testResults[0].assertionResults[0].status = "failed";
      report.numPassedTests = 0;
      report.numFailedTests = 1;
      report.success = false;
      process.exitCode = 1;
    }
    writeFileSync(reportPath, JSON.stringify(report));
  `,
  );
  const metrics = join(root, "metrics.json");
  const cache = join(root, "node_modules/.vite/vitest/test-parallel/results.json");
  const previous = Buffer.from(
    '{"version":1,"results":[["selected.test.ts",{"duration":1350}]]}\n',
  );
  await writeFile(cache, previous);
  for (const mode of ["passed", "failed"]) {
    const result = spawnSync(process.execPath, args, {
      ...options,
      env: { ...options.env, FIXTURE_RUN_MODE: mode, HUB_TEST_RUN_REPORT: metrics },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Skipping Vitest timing cache update: HEAD changed/u);
    if (mode === "passed") {
      assert.match(result.stderr, /HEAD changed while the test runner was active/u);
    } else {
      assert.match(result.stdout, /Shard 1: FAIL.*, 0 passed, 1 failed, 0 skipped/u);
    }
    assert.deepEqual(await readFile(cache), previous, mode);
    await assert.rejects(readFile(metrics), { code: "ENOENT" });
  }
});

test("serial reruns keep all files from a failed shard and require complete passing results", async (t) => {
  const files = ["a.test.ts", "b.test.ts"];
  const { root, args, options } = await parallelFixture(
    t,
    `
    const mode = process.env.FIXTURE_RUN_MODE;
    if (mode !== "initial") {
      const { deepEqual } = await import("node:assert/strict");
      deepEqual(process.argv.filter((arg) => /^--(?:test|hook|teardown)Timeout(?:=|$)/u.test(arg)), []);
    }
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
  assert.equal(passing.status, 0, passing.stderr || passing.stdout);
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
