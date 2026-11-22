import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import { existsSync } from "node:fs";

import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { executeFiles, partitionFiles, rerunFiles, runShards } from "./test-parallel.mjs";
import { runWorkerGroup, takeFullSuiteLock } from "./test-worker-group.mjs";

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
