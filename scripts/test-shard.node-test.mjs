import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { timingEntries } from "./generate-test-timings.mjs";
import { partitionFiles } from "./test-parallel.mjs";
import {
  RETRY_CAP,
  UsageError,
  coverageProblems,
  parseShardSelection,
  redactDeep,
  retryableFiles,
  runShardJob,
  runWithRetry,
  selectMode,
  sensitiveValues,
  splitBuiltOnly,
} from "./test-shard.mjs";
import runtimeFiles from "./test-runtime-files.json" with { type: "json" };
import baselineTimings from "./test-timings.json" with { type: "json" };

const root = "/repo";
const portTimeout = "Error: Port 5432/tcp not bound after 60000ms";
const hookTimeout = "Error: Hook timed out in 10000ms.";

function failedEntry(file, ...messages) {
  return {
    name: `${root}/${file}`,
    status: "failed",
    assertionResults: messages.map((failureMessages) => ({
      status: "failed",
      failureMessages: [failureMessages],
    })),
  };
}

function passedEntry(file) {
  return {
    name: `${root}/${file}`,
    status: "passed",
    assertionResults: [{ status: "passed" }],
    startTime: 0,
    endTime: 1500,
  };
}

function reportOf(...testResults) {
  return { success: false, testResults };
}

test("parses --shard and the environment pair, and rejects anything else", () => {
  assert.deepEqual(parseShardSelection("3/6", {}), { index: 3, total: 6 });
  assert.deepEqual(
    parseShardSelection(undefined, { TEST_SHARD_INDEX: "2", TEST_SHARD_TOTAL: "6" }),
    {
      index: 2,
      total: 6,
    },
  );
  assert.deepEqual(parseShardSelection("1/2", { TEST_SHARD_INDEX: "9", TEST_SHARD_TOTAL: "9" }), {
    index: 1,
    total: 2,
  });
  assert.equal(parseShardSelection(undefined, {}), undefined);
  for (const bad of ["0/6", "7/6", "a/6", "3", "3/0", "3/6/1", "-1/6", "1/101", "01/6", " 3/6"]) {
    assert.throws(() => parseShardSelection(bad, {}), UsageError, bad);
  }
  for (const env of [
    { TEST_SHARD_INDEX: "1" },
    { TEST_SHARD_TOTAL: "6" },
    { TEST_SHARD_INDEX: "0", TEST_SHARD_TOTAL: "6" },
    { TEST_SHARD_INDEX: "1.5", TEST_SHARD_TOTAL: "6" },
    { TEST_SHARD_INDEX: "7", TEST_SHARD_TOTAL: "6" },
  ]) {
    assert.throws(() => parseShardSelection(undefined, env), UsageError, JSON.stringify(env));
  }
});

test("the mode comes from one flag and conflicts are usage errors", () => {
  assert.deepEqual(selectMode({}, {}), { kind: "full" });
  assert.deepEqual(selectMode({ "rerun-failed": true }, { TEST_SHARD_INDEX: "bad" }), {
    kind: "rerun",
  });
  assert.deepEqual(selectMode({ shard: "2/6" }, {}), {
    kind: "shard",
    selection: { index: 2, total: 6 },
  });
  assert.deepEqual(selectMode({ "check-coverage": true }, {}), { kind: "coverage", total: 6 });
  assert.deepEqual(selectMode({ "check-coverage": true }, { TEST_SHARD_TOTAL: "4" }), {
    kind: "coverage",
    total: 4,
  });
  assert.deepEqual(selectMode({ "built-only": true }, {}), {
    kind: "built-only",
    total: undefined,
  });
  assert.throws(
    () => selectMode({ "check-coverage": true }, { TEST_SHARD_TOTAL: "0" }),
    UsageError,
  );
  assert.throws(() => selectMode({ "built-only": true, shard: "1/6" }, {}), UsageError);
  assert.throws(() => selectMode({ "check-coverage": true, "rerun-failed": true }, {}), UsageError);
});

test("built-only files leave the shardable set and must exist", () => {
  const files = ["a.test.ts", "b.test.ts", "c.test.ts"];
  assert.deepEqual(splitBuiltOnly(files, ["b.test.ts"]), {
    shardable: ["a.test.ts", "c.test.ts"],
    builtOnly: ["b.test.ts"],
  });
  assert.throws(() => splitBuiltOnly(files, ["gone.test.ts"]), /gone\.test\.ts/u);
});

test("coverage needs every file exactly once", () => {
  const files = ["a", "b", "c", "d"];
  const ok = { groups: [["a"], ["b", "c"]], builtOnly: ["d"], total: 2 };
  assert.deepEqual(coverageProblems(files, ok), []);
  assert.match(coverageProblems(files, { ...ok, builtOnly: [] }).join("\n"), /Not run.*: d/u);
  assert.match(
    coverageProblems(files, {
      ...ok,
      groups: [
        ["a", "b"],
        ["b", "c"],
      ],
    }).join("\n"),
    /more than once: b/u,
  );
  assert.match(
    coverageProblems(files, {
      ...ok,
      groups: [
        ["a", "x"],
        ["b", "c"],
      ],
    }).join("\n"),
    /Not a discovered file: x/u,
  );
  assert.match(coverageProblems(files, { ...ok, total: 3 }).join("\n"), /Expected 3 shards/u);
  assert.match(
    coverageProblems(files, { ...ok, groups: [[], ["a", "b", "c"]] }).join("\n"),
    /no files/u,
  );
});

test("the six real shards plus built-only cover the recorded timings exactly once", () => {
  const files = Object.keys(baselineTimings);
  const { builtOnly, shardable } = splitBuiltOnly(
    files,
    runtimeFiles[".output/server/"].filter((f) => files.includes(f)),
  );
  const weighted = shardable.map((path) => ({ path, weight: 1 + path.length, cached: true }));
  const groups = partitionFiles(weighted, 6);
  assert.deepEqual(coverageProblems(files, { groups, builtOnly, total: 6 }), []);
  assert.deepEqual(groups, partitionFiles([...weighted].reverse(), 6));
});

test("only container-start timeouts make a file retryable", () => {
  const report = reportOf(
    failedEntry("a.test.ts", portTimeout, hookTimeout),
    failedEntry("b.test.ts", portTimeout),
    failedEntry("c.test.ts", portTimeout, "AssertionError: expected 1 to be 2"),
    failedEntry("d.test.ts", "Error: Test timed out in 30000ms."),
    { name: `${root}/e.test.ts`, status: "failed", message: hookTimeout, assertionResults: [] },
    { name: `${root}/f.test.ts`, status: "failed", assertionResults: [] },
    passedEntry("g.test.ts"),
  );
  assert.deepEqual(retryableFiles(report, ["a.test.ts", "b.test.ts", "e.test.ts"], root), [
    "a.test.ts",
    "b.test.ts",
    "e.test.ts",
  ]);
  assert.deepEqual(retryableFiles(report, ["a.test.ts", "c.test.ts"], root), []);
  assert.deepEqual(retryableFiles(report, ["d.test.ts"], root), []);
  assert.deepEqual(retryableFiles(report, ["f.test.ts"], root), []);
  assert.deepEqual(retryableFiles(report, [], root), []);
});

function firstRun(failures, extra = {}) {
  const failed = failures.map(([file]) => file);
  return {
    exitCode: 1,
    durationMs: 1000,
    counts: { passed: 3, failed: failures.length, skipped: 0 },
    failedFiles: failed,
    incompleteFiles: 0,
    cleanLog: true,
    log: "/nowhere/first.log",
    report: reportOf(
      passedEntry("ok.test.ts"),
      ...failures.map(([file, message]) => failedEntry(file, message)),
    ),
    ...extra,
  };
}

function retryRun(files, exitCode = 0) {
  return {
    exitCode,
    durationMs: 500,
    counts: { passed: files.length, failed: exitCode, skipped: 0 },
    failedFiles: exitCode ? files : [],
    incompleteFiles: 0,
    log: "/nowhere/retry.log",
    report: reportOf(...files.map(passedEntry)),
  };
}

function executor(first, retry) {
  const calls = [];
  const execute = async (name, files) => {
    calls.push({ name, files });
    return calls.length === 1 ? first : retry(files);
  };
  return { execute, calls };
}

test("a timed-out file is retried once alone and the shard then passes", async () => {
  const { execute, calls } = executor(firstRun([["a.test.ts", portTimeout]]), (files) =>
    retryRun(files),
  );
  const result = await runWithRetry({
    label: "shard-1",
    files: ["ok.test.ts", "a.test.ts"],
    root,
    execute,
  });
  assert.deepEqual(calls, [
    { name: "shard-1", files: ["ok.test.ts", "a.test.ts"] },
    { name: "shard-1 retry", files: ["a.test.ts"] },
  ]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.retried, ["a.test.ts"]);
  assert.deepEqual(result.counts, { passed: 2, failed: 0, skipped: 0 });
  assert.equal(result.durationMs, 1500);
});

test("a file that fails again after the retry fails the shard", async () => {
  const { execute, calls } = executor(firstRun([["a.test.ts", hookTimeout]]), (files) =>
    retryRun(files, 1),
  );
  const result = await runWithRetry({ label: "shard-1", files: ["a.test.ts"], root, execute });
  assert.equal(calls.length, 2);
  assert.equal(result.exitCode, 1);
  assert.equal(result.retryFailed, true);
  assert.deepEqual(result.failedFiles, ["a.test.ts"]);
});

test("other failures, odd exits and unclean logs are never retried", async () => {
  const timeout = ["a.test.ts", portTimeout];
  const cases = [
    firstRun([timeout, ["b.test.ts", "AssertionError: nope"]]),
    firstRun([timeout], { processError: "SIGKILL" }),
    firstRun([timeout], { incompleteFiles: 1 }),
    firstRun([timeout], { cleanLog: false }),
  ];
  for (const first of cases) {
    const { execute, calls } = executor(first, () => assert.fail("must not retry"));
    const result = await runWithRetry({ label: "shard-1", files: ["a.test.ts"], root, execute });
    assert.equal(calls.length, 1);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.retried, []);
  }
});

test("more than the retry cap fails the shard without retrying", async () => {
  const failures = Array.from({ length: RETRY_CAP + 1 }, (_, index) => [
    `f${index}.test.ts`,
    portTimeout,
  ]);
  const { execute, calls } = executor(firstRun(failures), () => assert.fail("must not retry"));
  const result = await runWithRetry({
    label: "shard-1",
    files: failures.map(([f]) => f),
    root,
    execute,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.tooManyRetries, RETRY_CAP + 1);
  const atCap = failures.slice(0, RETRY_CAP);
  const capped = executor(firstRun(atCap), (files) => retryRun(files));
  const ok = await runWithRetry({
    label: "shard-1",
    files: atCap.map(([f]) => f),
    root,
    execute: capped.execute,
  });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.retried.length, RETRY_CAP);
});

test("artifacts and the summary hide env values and the host name", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-shard-artifacts-"));
  t.after(() => rm(directory, { recursive: true }));
  const env = {
    GITHUB_TOKEN: "ghs_supersecrettokenvalue",
    API_KEY: "key-1234567890",
    RUNNER_NAME: "GitHub Actions 42",
    HOME: "/home/runner",
    SHORT_SECRET: "abc",
  };
  const host = "fv-az123-456.internal";
  const logPath = join(directory, "in.log");
  await writeFile(logPath, `token ghs_supersecrettokenvalue on ${host} as GitHub Actions 42\n`);
  const first = firstRun([["a.test.ts", `${portTimeout} key-1234567890`]], { log: logPath });
  const { execute } = executor(first, (files) => ({ ...retryRun(files), log: logPath }));
  const summaryPath = join(directory, "summary.md");
  const printed = [];
  const exitCode = await runShardJob({
    title: "Shard 1/6",
    label: "shard-1",
    files: ["ok.test.ts", "a.test.ts"],
    root,
    execute,
    env,
    host,
    reportDir: join(directory, "out"),
    summaryPath,
    print: (line) => printed.push(line),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual((await readdir(join(directory, "out"))).sort(), [
    "shard-1.json",
    "shard-1.summary.json",
    "vitest.log",
    "vitest.retry.log",
  ]);
  const everything = [
    ...(await Promise.all(
      (
        await readdir(join(directory, "out"))
      ).map((name) => readFile(join(directory, "out", name), "utf8")),
    )),
    await readFile(summaryPath, "utf8"),
  ].join("\n");
  for (const secret of ["ghs_supersecrettokenvalue", "key-1234567890", host, "GitHub Actions 42"]) {
    assert.ok(!everything.includes(secret), secret);
  }
  assert.match(everything, /\[redacted\]/u);
  const saved = JSON.parse(await readFile(join(directory, "out", "shard-1.json"), "utf8"));
  assert.deepEqual(saved.testResults.map(({ name }) => name).sort(), ["a.test.ts", "ok.test.ts"]);
  assert.deepEqual(timingEntries(saved, root).sort(), [
    ["a.test.ts", 1500],
    ["ok.test.ts", 1500],
  ]);
  assert.match(
    printed.join("\n"),
    /::warning title=Retried after a container-start timeout::a\.test\.ts/u,
  );
  assert.match(
    await readFile(summaryPath, "utf8"),
    /Retried once after a container-start timeout/u,
  );
  assert.deepEqual(sensitiveValues({ SHORT_SECRET: "abc", PATH: "/usr/bin:/bin" }, "h"), []);
  assert.deepEqual(redactDeep({ a: ["x-secret-value"] }, ["secret-value"]), {
    a: ["x-[redacted]"],
  });
});

test("bad shard arguments exit 2 before any test runs", () => {
  const script = fileURLToPath(new URL("./test-parallel.mjs", import.meta.url));
  const cases = [
    { args: ["--shard", "0/6"], env: {} },
    { args: ["--shard", "7/6"], env: {} },
    { args: ["--shard"], env: {} },
    { args: ["--bogus"], env: {} },
    { args: ["--shard", "1/6", "--built-only"], env: {} },
    { args: [], env: { TEST_SHARD_INDEX: "1" } },
    { args: [], env: { TEST_SHARD_INDEX: "x", TEST_SHARD_TOTAL: "6" } },
    { args: ["--check-coverage"], env: { TEST_SHARD_TOTAL: "0" } },
  ];
  for (const { args, env } of cases) {
    const clean = { ...process.env };
    delete clean.TEST_SHARD_INDEX;
    delete clean.TEST_SHARD_TOTAL;
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: { ...clean, ...env },
    });
    assert.equal(result.status, 2, `${args.join(" ")} ${JSON.stringify(env)}: ${result.stderr}`);
  }
});
