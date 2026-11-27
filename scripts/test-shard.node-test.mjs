import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { timingEntries } from "./generate-test-timings.mjs";
import { partitionFiles, usePlainOutput, weighFiles } from "./test-parallel.mjs";
import {
  RETRY_CAP,
  UsageError,
  coverageProblems,
  logFailureHeaders,
  parseShardSelection,
  redactDeep,
  redactReport,
  redactText,
  retryAnnotations,
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

test("the six real shards plus built-only cover every recorded file exactly once", async () => {
  const files = Object.keys(baselineTimings);
  const { builtOnly, shardable } = splitBuiltOnly(files, runtimeFiles[".output/server/"]);
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const weighted = await weighFiles(repository, "/nonexistent", shardable, {
    baselineOnly: true,
  });
  const groups = partitionFiles(weighted, 6);
  assert.deepEqual(coverageProblems(files, { groups, builtOnly, total: 6 }), []);
  assert.deepEqual(groups, partitionFiles([...weighted].reverse(), 6));
});

test("equal weights split by code unit, not by locale", () => {
  const files = ["z.test.ts", "\u00e4.test.ts", "a.test.ts", "b.test.ts"].map((path) => ({
    path,
    weight: 1,
  }));
  assert.deepEqual(partitionFiles(files, 2), [
    ["a.test.ts", "z.test.ts"],
    ["b.test.ts", "\u00e4.test.ts"],
  ]);
});

const logDirectory = mkdtempSync(join(tmpdir(), "hub-shard-logs-"));
process.on("exit", () => rmSync(logDirectory, { recursive: true, force: true }));
let logCount = 0;

function logWith(blocks) {
  const text = blocks
    .map(
      ([file, header]) =>
        `\n\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF Failed Suites 1 \u23AF\u23AF\u23AF\u23AF\n\n \u001B[41m\u001B[1m FAIL \u001B[22m\u001B[49m  ${file} > suite\n${header}\n \u276F x.test.ts:3:3\n`,
    )
    .join("");
  logCount += 1;
  const path = join(logDirectory, `first-${logCount}.log`);
  writeFileSync(path, text);
  return path;
}

test("log blocks give each failing file its first error line", () => {
  const log = logWith([
    ["a.test.ts", hookTimeout],
    ["b.test.ts", portTimeout],
    ["a.test.ts", "AssertionError: nope"],
  ]);
  const headers = logFailureHeaders(readFileSync(log, "utf8"));
  assert.deepEqual(headers.get("a.test.ts"), [hookTimeout, "AssertionError: nope"]);
  assert.deepEqual(headers.get("b.test.ts"), [portTimeout]);
});

const HOOK_HINT =
  'If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".';

test("the default reporter's real hook failure output is understood", () => {
  const rule = "\u23AF".repeat(6);
  const log = [
    " RUN  v3.2.4 /repo",
    " \u276F src/x.test.ts (2 tests | 2 skipped) 105ms",
    "   \u2193 slow hook > never runs",
    "",
    `${rule} Failed Suites 2 ${rule}`,
    "",
    " FAIL  src/x.test.ts > slow hook",
    "Error: Hook timed out in 100ms.",
    HOOK_HINT,
    " \u276F src/x.test.ts:3:3",
    "",
    `${rule}[1/2]${"\u23AF"}`,
    "",
    " FAIL  src/x.test.ts > port",
    "Error: Port 5432/tcp not bound after 20000ms",
    " \u276F src/x.test.ts:7:33",
    "",
  ].join("\n");
  assert.deepEqual(logFailureHeaders(log).get("src/x.test.ts"), [
    "Error: Hook timed out in 100ms.",
    "Error: Port 5432/tcp not bound after 20000ms",
  ]);
  const custom = logFailureHeaders(
    log.replace(HOOK_HINT, "If this is a long-running hook, check the fixture."),
  );
  assert.deepEqual(custom.get("src/x.test.ts")[0], "Error: Hook timed out in 100ms.");
  assert.equal(custom.get("src/x.test.ts").length, 3);
});

test("file-level failures, shared errors and extra error lines in one block", () => {
  const rule = "\u23AF".repeat(6);
  const log = [
    `${rule} Failed Suites 2 ${rule}`,
    "",
    " FAIL  a.test.ts [ a.test.ts ]",
    " FAIL  b.test.ts [ b.test.ts ]",
    "Error: Port 5432/tcp not bound after 20000ms",
    " \u276F a.test.ts:3:3",
    "",
    `${rule}[1/2]${"\u23AF"}`,
    "",
    " FAIL  c.test.ts > suite",
    "Error: Hook timed out in 100ms.",
    HOOK_HINT,
    " \u276F c.test.ts:3:3",
    "Error: cleanup failed",
    " \u276F c.test.ts:9:3",
    "",
  ].join("\n");
  const headers = logFailureHeaders(log);
  assert.deepEqual(headers.get("a.test.ts"), ["Error: Port 5432/tcp not bound after 20000ms"]);
  assert.deepEqual(headers.get("b.test.ts"), ["Error: Port 5432/tcp not bound after 20000ms"]);
  assert.deepEqual(headers.get("c.test.ts"), [
    "Error: Hook timed out in 100ms.",
    "Error: cleanup failed",
  ]);
  const hookOnly = (file) => ({
    name: `${root}/${file}`,
    status: "failed",
    message: "",
    assertionResults: [{ status: "skipped", failureMessages: [] }],
  });
  const report = reportOf(hookOnly("a.test.ts"), hookOnly("c.test.ts"));
  assert.deepEqual(retryableFiles(report, ["a.test.ts"], { root, headers }), ["a.test.ts"]);
  assert.deepEqual(retryableFiles(report, ["c.test.ts"], { root, headers }), []);
});

const SLOW_DATABASE_LOG = [
  " ✓ src/runtime-files.test.ts (1 test) 0ms",
  "",
  "\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF Failed Suites 1 \u23AF\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF",
  "",
  " FAIL  src/db/activity-paging.integration.test.ts > activity page SQL on postgres",
  "DatabaseUnavailableError: database query timed out",
  " \u276F Timeout.<anonymous> src/db/runtime/internal/pool.ts:112:27",
  "    110|         new Promise<never>((_, reject) => {",
  "",
  "\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF\u23AF[1/1]\u23AF",
].join("\n");

function suiteFailure(file, message, assertionResults) {
  return { name: `${root}/${file}`, status: "failed", message, assertionResults };
}

test("a suite that cannot start on a slow database is retried", () => {
  const file = "src/db/activity-paging.integration.test.ts";
  const skipped = Array.from({ length: 9 }, () => ({ status: "skipped", failureMessages: [] }));
  const passed = Array.from({ length: 7 }, () => ({ status: "passed", failureMessages: [] }));
  const report = reportOf(suiteFailure(file, "", [...skipped, ...passed]));
  const headers = logFailureHeaders(SLOW_DATABASE_LOG);
  assert.deepEqual(headers.get(file), ["DatabaseUnavailableError: database query timed out"]);
  assert.deepEqual(retryableFiles(report, [file], { root, headers }), [file]);
  assert.deepEqual(retryableFiles(report, [file], { root }), []);
});

function failureLog(file, header, ...rest) {
  return [" FAIL  " + file + " [ " + file + " ]", header, " \u276F " + file + ":2:7", ...rest].join(
    "\n",
  );
}

test("a suite that fails to load is retried when the log names the start timeout", () => {
  const typed = [
    ["database query timed out", "DatabaseUnavailableError: database query timed out"],
    ["timeout exceeded when trying to connect", "Error: timeout exceeded when trying to connect"],
    ["the database system is starting up", "error: the database system is starting up"],
    [
      "Connection terminated due to connection timeout",
      "Error: Connection terminated due to connection timeout",
    ],
  ];
  for (const [message, header] of typed) {
    const report = reportOf(suiteFailure("a.test.ts", message, []));
    const headers = logFailureHeaders(failureLog("a.test.ts", header));
    assert.deepEqual(retryableFiles(report, ["a.test.ts"], { root, headers }), ["a.test.ts"]);
    assert.deepEqual(retryableFiles(report, ["a.test.ts"], { root }), [], message);
  }
});

test("a bare JSON message needs a matching log header", () => {
  const report = reportOf(suiteFailure("a.test.ts", "database query timed out", []));
  const other = logFailureHeaders(failureLog("a.test.ts", "AssertionError: nope"));
  assert.deepEqual(retryableFiles(report, ["a.test.ts"], { root, headers: other }), []);
  const typed = reportOf(
    suiteFailure("a.test.ts", "DatabaseUnavailableError: database query timed out", []),
  );
  assert.deepEqual(retryableFiles(typed, ["a.test.ts"], { root }), ["a.test.ts"]);
});

test("the log must name the same timeout and the whole message must be that timeout", () => {
  const log = (header) => logFailureHeaders(failureLog("a.test.ts", header));
  const retryable = (message, headers) =>
    retryableFiles(reportOf(suiteFailure("a.test.ts", message, [])), ["a.test.ts"], {
      root,
      headers,
    });
  const query = "database query timed out";
  assert.deepEqual(retryable(query, log("Error: timeout exceeded when trying to connect")), []);
  assert.deepEqual(retryable(query, log("DatabaseUnavailableError: database query timed out")), [
    "a.test.ts",
  ]);
  const extra = "timeout exceeded when trying to connect\n  Configuration error: wrong endpoint";
  assert.deepEqual(retryable(extra, log("Error: timeout exceeded when trying to connect")), []);
});

test("a start timeout with more message text is not retried from a test or a hook", () => {
  const message = "timeout exceeded when trying to connect";
  const extra = "  Configuration error: wrong endpoint";
  const log = ["hook", "body"]
    .map((name) =>
      [
        ` FAIL  ${name}.test.ts > ${name}`,
        `Error: ${message}`,
        extra,
        ` \u276F ${name}.test.ts:4:11`,
        '      2| describe("hook", () => {',
        "",
      ].join("\n"),
    )
    .join("\n");
  const headers = logFailureHeaders(log);
  assert.deepEqual(headers.get("body.test.ts"), [`Error: ${message}\n${extra}`]);
  const report = reportOf(
    failedEntry("body.test.ts", `Error: ${message}\n${extra}\n    at body.test.ts:3:9`),
    suiteFailure("hook.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
  );
  for (const file of ["body.test.ts", "hook.test.ts"]) {
    assert.deepEqual(retryableFiles(report, [file], { root, headers }), [], file);
  }
  const plain = reportOf(failedEntry("body.test.ts", `Error: ${message}\n    at body.test.ts:3:9`));
  const plainHeaders = logFailureHeaders(failureLog("body.test.ts", `Error: ${message}`));
  assert.deepEqual(retryableFiles(plain, ["body.test.ts"], { root, headers: plainHeaders }), [
    "body.test.ts",
  ]);
});

test("message text after a blank line or starting with at still blocks the retry", () => {
  const message = "timeout exceeded when trying to connect";
  const block = (name, ...lines) =>
    [
      ` FAIL  ${name}.test.ts > ${name}`,
      `Error: ${message}`,
      ...lines,
      ` \u276F ${name}.test.ts:4:11`,
      "",
    ].join("\n");
  const log = [
    block("blank", "", "  Configuration error: wrong endpoint"),
    block("athook", "  at startup: wrong endpoint"),
    block("atbody", "  at startup: wrong endpoint"),
  ].join("\n");
  const headers = logFailureHeaders(log);
  assert.deepEqual(headers.get("blank.test.ts"), [
    `Error: ${message}\n  Configuration error: wrong endpoint`,
  ]);
  const frame = "    at /repo/atbody.test.ts:3:9";
  const report = reportOf(
    failedEntry("atbody.test.ts", `Error: ${message}\n  at startup: wrong endpoint\n${frame}`),
    suiteFailure("athook.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
    suiteFailure("blank.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
  );
  for (const file of ["atbody", "athook", "blank"]) {
    const name = `${file}.test.ts`;
    assert.deepEqual(retryableFiles(report, [name], { root, headers }), [], name);
  }
});

test("reporter text that looks like a stack frame still counts as message text", () => {
  const message = "timeout exceeded when trying to connect";
  const extra = ["  at config/startup.yaml:12:7", "  Configuration error: wrong endpoint"];
  const block = (name) =>
    [
      ` FAIL  ${name}.test.ts > ${name}`,
      `Error: ${message}`,
      ...extra,
      ` \u276F ${name}.test.ts:4:11`,
      "",
    ].join("\n");
  const headers = logFailureHeaders([block("hook"), block("body")].join("\n"));
  const report = reportOf(
    failedEntry(
      "body.test.ts",
      `Error: ${message}\n${extra.join("\n")}\n    at /repo/body.test.ts:3:9`,
    ),
    suiteFailure("hook.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
  );
  for (const name of ["body.test.ts", "hook.test.ts"]) {
    assert.deepEqual(retryableFiles(report, [name], { root, headers }), [], name);
  }
});

test("an anonymous V8 frame ends a JSON failure message", () => {
  const message = "timeout exceeded when trying to connect";
  const stack = `Error: ${message}\n    at new Promise (<anonymous>)\n    at run (/repo/a.test.ts:3:9)`;
  const report = reportOf(failedEntry("a.test.ts", stack));
  const headers = logFailureHeaders(failureLog("a.test.ts", `Error: ${message}`));
  assert.deepEqual(retryableFiles(report, ["a.test.ts"], { root, headers }), ["a.test.ts"]);
});

test("each failure entry of one test is classified on its own", () => {
  const start = "timeout exceeded when trying to connect";
  const second = "Connection terminated due to connection timeout";
  const withEntries = (...failureMessages) =>
    reportOf({
      name: `${root}/a.test.ts`,
      status: "failed",
      assertionResults: [{ status: "failed", failureMessages }],
    });
  const frame = "\n    at run (/repo/a.test.ts:3:9)";
  const retry = (report) => retryableFiles(report, ["a.test.ts"], { root });
  assert.deepEqual(retry(withEntries(`Error: ${start}${frame}`, `Error: ${second}${frame}`)), [
    "a.test.ts",
  ]);
  assert.deepEqual(retry(withEntries(`Error: ${start}${frame}`, `Error: nope${frame}`)), []);
  assert.deepEqual(retry(withEntries(`Error: ${start}${frame}`, "")), []);
  assert.deepEqual(retry(withEntries()), []);
});

test("reporter message lines that start with the frame glyph are kept", () => {
  const message = "timeout exceeded when trying to connect";
  const log = [
    " FAIL  hook.test.ts > hook",
    `Error: ${message}`,
    "  \u276F config/startup.yaml:12:7",
    "  Configuration error: wrong endpoint",
    " \u276F hook.test.ts:4:11",
    "",
  ].join("\n");
  const headers = logFailureHeaders(log);
  assert.equal(headers.get("hook.test.ts").length, 1);
  assert.match(headers.get("hook.test.ts")[0], /Configuration error/u);
  const report = reportOf(
    suiteFailure("hook.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
  );
  assert.deepEqual(retryableFiles(report, ["hook.test.ts"], { root, headers }), []);
});

test("message text after a line that imitates a frame still blocks the retry", () => {
  const message = "timeout exceeded when trying to connect";
  const log = [
    " FAIL  hook.test.ts > hook",
    `Error: ${message}`,
    " \u276F config/startup.yaml:12:7",
    "  Configuration error: wrong endpoint",
    " \u276F hook.test.ts:4:11",
    '      2| describe("hook", () => {',
    "       |           ^",
    "",
  ].join("\n");
  const headers = logFailureHeaders(log);
  assert.deepEqual(headers.get("hook.test.ts"), [
    `Error: ${message}\n  Configuration error: wrong endpoint`,
  ]);
  const report = reportOf(
    suiteFailure("hook.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
  );
  assert.deepEqual(retryableFiles(report, ["hook.test.ts"], { root, headers }), []);
  const clean = log
    .replace("  Configuration error: wrong endpoint\n", "")
    .replace(" \u276F config/startup.yaml:12:7\n", "");
  assert.deepEqual(
    retryableFiles(report, ["hook.test.ts"], { root, headers: logFailureHeaders(clean) }),
    ["hook.test.ts"],
  );
});

test("only Vitest's own frame and excerpt formats are skipped", () => {
  const message = "timeout exceeded when trying to connect";
  const headersOf = (...lines) =>
    logFailureHeaders(
      [" FAIL  hook.test.ts > hook", `Error: ${message}`, ...lines, ""].join("\n"),
    ).get("hook.test.ts");
  const frame = " \u276F hook.test.ts:4:11";
  assert.deepEqual(headersOf(frame, '      2| describe("hook", () => {', "       |   ^"), [
    `Error: ${message}`,
  ]);
  assert.deepEqual(headersOf(frame, "    100| it(1)", "    1200| it(2)"), [`Error: ${message}`]);
  const wrongHost = headersOf(" \u276F config/startup.yaml:12:7", "  12| endpoint: wrong-host");
  assert.deepEqual(wrongHost, [`Error: ${message}\n  12| endpoint: wrong-host`]);
  for (const line of ["    1  | endpoint: wrong-host", "       | endpoint: wrong-host"]) {
    const found = headersOf(" \u276F config/startup.yaml:12:7", line);
    assert.deepEqual(found, [`Error: ${message}\n${line}`]);
  }
  const noLocation = headersOf(" \u276F Configuration error: wrong endpoint", frame);
  assert.deepEqual(noLocation, [`Error: ${message}\n \u276F Configuration error: wrong endpoint`]);
});

test("causes after a serialized error block still count", () => {
  const rule = "\u23AF".repeat(14);
  const log = (...after) =>
    [
      " FAIL  a.test.ts > a",
      "Error: Connection terminated due to connection timeout",
      " \u276F a.test.ts:7:11",
      "      7|   throw new Error(1);",
      "       |           ^",
      "",
      "Caused by: Error: Connection terminated unexpectedly",
      " \u276F a.test.ts:5:17",
      "",
      rule,
      "Serialized Error: { connectionClosed: true,",
      "  detail: 'long' }",
      ...after,
      `${"\u23AF".repeat(8)}[1/1]${"\u23AF"}`,
      "",
    ].join("\n");
  const report = reportOf(
    suiteFailure("a.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
  );
  const retry = (text) =>
    retryableFiles(report, ["a.test.ts"], { root, headers: logFailureHeaders(text) });
  assert.deepEqual(retry(log()), ["a.test.ts"]);
  const nested = log("Caused by: Error: password authentication failed", " \u276F a.test.ts:4:19");
  assert.deepEqual(retry(nested), []);
  assert.equal(
    logFailureHeaders(nested).get("a.test.ts").at(-1),
    "Caused by: Error: password authentication failed",
  );
});

test("the cause pg-pool attaches to a connection timeout is part of that failure", () => {
  const timeout = "Error: Connection terminated due to connection timeout";
  const log = (cause) =>
    [
      " FAIL  a.test.ts > hook cause",
      timeout,
      " \u276F a.test.ts:4:11",
      "      3|   beforeAll(() => {",
      "",
      cause,
      " \u276F a.test.ts:5:14",
      "",
    ].join("\n");
  const report = reportOf(
    suiteFailure("a.test.ts", "", [{ status: "skipped", failureMessages: [] }]),
  );
  const retryable = (cause) =>
    retryableFiles(report, ["a.test.ts"], { root, headers: logFailureHeaders(log(cause)) });
  assert.deepEqual(retryable("Caused by: Error: Connection terminated unexpectedly"), [
    "a.test.ts",
  ]);
  assert.deepEqual(retryable("Caused by: Error: connect ECONNREFUSED 127.0.0.1:5432"), []);
  const alone = "Caused by: Error: Connection terminated unexpectedly";
  const standalone = logFailureHeaders(` FAIL  a.test.ts > s\nAssertionError: nope\n${alone}\n`);
  assert.deepEqual(retryableFiles(report, ["a.test.ts"], { root, headers: standalone }), []);
});

test("other database errors and a mixed failure are not retried", () => {
  const messages = [
    "DatabaseUnavailableError: database unavailable",
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    'error: relation "runs" does not exist',
    "AssertionError: expected 'database query timed out' to be null",
  ];
  for (const message of messages) {
    const report = reportOf(suiteFailure("a.test.ts", message, []));
    assert.deepEqual(retryableFiles(report, ["a.test.ts"], { root }), [], message);
  }
  const mixed = reportOf(
    suiteFailure("a.test.ts", "DatabaseUnavailableError: database query timed out", []),
    failedEntry("b.test.ts", "AssertionError: nope"),
  );
  assert.deepEqual(retryableFiles(mixed, ["a.test.ts", "b.test.ts"], { root }), []);
});

test("only a start timeout header makes a file retryable", () => {
  const hookFailure = {
    name: `${root}/e.test.ts`,
    status: "failed",
    message: "",
    assertionResults: [{ status: "skipped", failureMessages: [] }],
  };
  const report = reportOf(
    failedEntry("a.test.ts", portTimeout, hookTimeout),
    failedEntry("b.test.ts", portTimeout),
    failedEntry("c.test.ts", portTimeout, "AssertionError: expected 1 to be 2"),
    failedEntry("d.test.ts", "Error: Test timed out in 30000ms."),
    failedEntry("q.test.ts", "AssertionError: expected 'Hook timed out in 10000ms' to be null"),
    { name: `${root}/f.test.ts`, status: "failed", message: "", assertionResults: [] },
    { ...failedEntry("n.test.ts"), assertionResults: [{ status: "failed", failureMessages: [] }] },
    {
      name: `${root}/p.test.ts`,
      status: "failed",
      assertionResults: [
        { status: "failed", failureMessages: [hookTimeout] },
        { status: "pending" },
      ],
    },
    hookFailure,
    passedEntry("g.test.ts"),
  );
  const ready = (files, headers) => retryableFiles(report, files, { root, headers });
  assert.deepEqual(ready(["a.test.ts", "b.test.ts"]), ["a.test.ts", "b.test.ts"]);
  for (const file of ["c", "d", "q", "f", "n", "p"]) {
    assert.deepEqual(ready([`${file}.test.ts`]), [], file);
  }
  assert.deepEqual(ready(["a.test.ts", "c.test.ts"]), []);
  assert.deepEqual(ready([]), []);
  assert.deepEqual(ready(["e.test.ts"]), []);
  const hookHeaders = new Map([["e.test.ts", [hookTimeout]]]);
  assert.deepEqual(ready(["e.test.ts"], hookHeaders), ["e.test.ts"]);
  const mixed = new Map([["e.test.ts", [hookTimeout, "AssertionError: nope"]]]);
  assert.deepEqual(ready(["e.test.ts"], mixed), []);
});

function firstRun(failures, extra = {}) {
  const failed = failures.map(([file]) => file);
  return {
    exitCode: 1,
    runExit: 1,
    durationMs: 1000,
    counts: { passed: 3, failed: failures.length, skipped: 0 },
    failedFiles: failed,
    incompleteFiles: 0,
    cleanLog: true,
    log: logWith(failures),
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
    report: exitCode
      ? reportOf(failedEntry(files[0], "Error: still bad"))
      : reportOf(...files.map(passedEntry)),
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
    { name: "shard-1 retry 1", files: ["a.test.ts"] },
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.success, true);
  assert.deepEqual(result.retried, ["a.test.ts"]);
  assert.deepEqual(result.counts, { passed: 2, failed: 0, skipped: 0 });
  assert.equal(result.durationMs, 1500);
});

test("a slow database start counts as a retry and toward the per-shard limit", async () => {
  const slow = "DatabaseUnavailableError: database query timed out";
  const { execute, calls } = executor(firstRun([["a.test.ts", slow]]), (files) => retryRun(files));
  const result = await runWithRetry({ label: "shard-1", files: ["a.test.ts"], root, execute });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.retried, ["a.test.ts"]);
  assert.equal(result.exitCode, 0);

  const many = Array.from({ length: RETRY_CAP + 1 }, (_, index) => [`f${index}.test.ts`, slow]);
  const capped = executor(firstRun(many), (files) => retryRun(files));
  const refused = await runWithRetry({
    label: "shard-1",
    files: many.map(([file]) => file),
    root,
    execute: capped.execute,
  });
  assert.equal(capped.calls.length, 1);
  assert.equal(refused.exitCode, 1);
  assert.match(retryAnnotations(refused).join("\n"), /Too many start timeouts/u);
});

test("each retried file runs in its own process and reports its own outcome", async () => {
  const failures = [
    ["a.test.ts", portTimeout],
    ["b.test.ts", hookTimeout],
  ];
  const { execute, calls } = executor(firstRun(failures), (files) =>
    retryRun(files, files[0] === "b.test.ts" ? 1 : 0),
  );
  const result = await runWithRetry({
    label: "shard-1",
    files: ["a.test.ts", "b.test.ts"],
    root,
    execute,
  });
  assert.deepEqual(
    calls.slice(1).map(({ name, files }) => [name, files]),
    [
      ["shard-1 retry 1", ["a.test.ts"]],
      ["shard-1 retry 2", ["b.test.ts"]],
    ],
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.success, false);
  assert.deepEqual(result.failedFiles, ["b.test.ts"]);
  assert.deepEqual(retryAnnotations(result), [
    "::warning title=Retried after a start timeout::a.test.ts passed on a serial retry",
    "::error title=Failed again after a start timeout retry::b.test.ts",
  ]);
});

test("a failure the JSON report cannot show is retried from the log header", async () => {
  const hookOnly = {
    name: `${root}/a.test.ts`,
    status: "failed",
    message: "",
    assertionResults: [{ status: "skipped", failureMessages: [] }],
  };
  const first = firstRun([["a.test.ts", hookTimeout]], {
    report: reportOf(passedEntry("ok.test.ts"), hookOnly),
  });
  const { execute, calls } = executor(first, (files) => retryRun(files));
  const result = await runWithRetry({ label: "shard-1", files: ["a.test.ts"], root, execute });
  assert.equal(calls.length, 2);
  assert.equal(result.exitCode, 0);
});

test("other failures, odd exits and unclean logs are never retried", async () => {
  const timeout = ["a.test.ts", portTimeout];
  const cases = [
    firstRun([timeout, ["b.test.ts", "AssertionError: nope"]]),
    firstRun([timeout], { processError: "SIGKILL" }),
    firstRun([timeout], { runExit: 2 }),
    firstRun([timeout], { incompleteFiles: 1 }),
    firstRun([timeout], { cleanLog: false }),
    firstRun([timeout], { log: "/nowhere/missing.log" }),
    firstRun([timeout], { log: logWith([timeout, ["a.test.ts", "AssertionError: nope"]]) }),
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

test("workflow command text in file names and diagnostics is escaped", () => {
  const lines = retryAnnotations({
    retryOutcomes: [{ file: "a%b\n::add-mask::x.test.ts", passed: true }],
    tooManyRetries: 6,
    diagnostic: "six\r\nfiles",
  });
  assert.deepEqual(lines, [
    "::warning title=Retried after a start timeout::a%25b%0A::add-mask::x.test.ts passed on a serial retry",
    "::error title=Too many start timeouts::six%0D%0Afiles",
  ]);
});

async function artifactText(directory) {
  const names = (await readdir(directory)).sort();
  const texts = await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")));
  return { names, text: texts.join("\n") };
}

test("artifacts and the summary hide env values, short secrets and the host name", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-shard-artifacts-"));
  t.after(() => rm(directory, { recursive: true }));
  const env = {
    GITHUB_TOKEN: "ghs_supersecrettokenvalue",
    API_KEY: "key-1234567890",
    DB_PASSWORD: "admin",
    DATABASE_URL: "postgres://user:pw@db.example/app",
    RUNNER_NAME: "GitHub Actions 42",
    GITHUB_SERVER_URL: "https://github.com",
    HOME: "/home/runner",
    SHORT_SECRET: "ab",
    FLAG_TOKEN: "true",
  };
  const host = "hub01";
  const logPath = join(directory, "in.log");
  await writeFile(
    logPath,
    `token ghs_supersecrettokenvalue on ${host} as GitHub Actions 42 pw admin in ${root}/src/a.test.ts\n`,
  );
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
  const { names, text } = await artifactText(join(directory, "out"));
  assert.deepEqual(names, [
    "shard-1.json",
    "shard-1.summary.json",
    "vitest.log",
    "vitest.retry-1.log",
  ]);
  const everything = `${text}\n${await readFile(summaryPath, "utf8")}`;
  const secrets = [
    "ghs_supersecrettokenvalue",
    "key-1234567890",
    host,
    "GitHub Actions 42",
    "admin",
    "postgres://",
  ];
  for (const secret of secrets) assert.ok(!everything.includes(secret), secret);
  assert.ok(!everything.includes(`${root}/`));
  assert.match(everything, /\[redacted\]/u);
  assert.ok(!sensitiveValues(env, host).includes("https://github.com"));
  const saved = JSON.parse(await readFile(join(directory, "out", "shard-1.json"), "utf8"));
  assert.deepEqual(saved.testResults.map(({ name }) => name).sort(), ["a.test.ts", "ok.test.ts"]);
  assert.deepEqual(timingEntries(saved, root).sort(), [
    ["a.test.ts", 1500],
    ["ok.test.ts", 1500],
  ]);
  assert.match(printed.join("\n"), /::warning title=Retried after a start timeout::a\.test\.ts/u);
  assert.match(await readFile(summaryPath, "utf8"), /Retried once after a start timeout/u);
});

test("a short env value cannot rewrite file names or report keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-shard-short-"));
  t.after(() => rm(directory, { recursive: true }));
  const logPath = join(directory, "in.log");
  await writeFile(logPath, "x\n");
  const first = { ...firstRun([["a.test.ts", portTimeout]]), log: logPath };
  const { execute } = executor(first, (files) => ({ ...retryRun(files), log: logPath }));
  await runShardJob({
    title: "Shard 1/6",
    label: "shard-1",
    files: ["ok.test.ts", "a.test.ts"],
    root,
    execute,
    env: { API_KEY: "test" },
    host: "h",
    reportDir: join(directory, "out"),
    print: () => {},
  });
  const saved = JSON.parse(await readFile(join(directory, "out", "shard-1.json"), "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), [
    "numFailedTests",
    "numPassedTests",
    "numTotalTests",
    "success",
    "testResults",
  ]);
  assert.deepEqual(timingEntries(saved, root).sort(), [
    ["a.test.ts", 1500],
    ["ok.test.ts", 1500],
  ]);
});

test("report redaction survives non-string messages and scrubs snapshot data", () => {
  const scrubber = { values: ["s3cr3t-value"], roots: ["/repo"] };
  const report = {
    success: false,
    snapshot: { uncheckedKeysByFile: [{ filePath: "/repo/a.test.ts", keys: ["k-s3cr3t-value"] }] },
    testResults: [
      {
        name: "a.test.ts",
        status: "failed",
        message: "boom s3cr3t-value",
        assertionResults: [
          { status: "failed", failureMessages: [null, "at /repo/a.test.ts s3cr3t-value"] },
        ],
      },
    ],
  };
  const saved = JSON.stringify(redactReport(report, scrubber));
  assert.ok(!saved.includes("s3cr3t-value") && !saved.includes("/repo"));
  assert.match(saved, /"failureMessages":\[null,"at \.\/a\.test\.ts \[redacted\]"\]/u);
});

test("env values are redacted before the root path and URL parts count as values", () => {
  const values = sensitiveValues(
    {
      DATABASE_URL: ["postgres://", "app", ":", "pw%21123", "@db.internal.example:5432/x"].join(""),
      SEED: "123456789",
    },
    "h",
  );
  for (const part of ["db.internal.example", "pw!123", "pw%21123", "app", "123456789"]) {
    assert.ok(values.includes(part), part);
  }
  const text = redactText("file:/repo/x?key=abc at /repo/y", {
    values: ["file:/repo/x?key=abc"],
    roots: ["/repo"],
  });
  assert.equal(text, "[redacted] at ./y");
});

test("shard runs turn colors off for the Vitest subprocess", () => {
  const env = { FORCE_COLOR: "1", KEEP: "x" };
  usePlainOutput(env);
  assert.deepEqual(env, { NO_COLOR: "1", KEEP: "x" });
});

test("overlapping env values and root paths merge and stay redacted", () => {
  const scrub = (text, values, roots) => redactText(text, { values, roots });
  assert.equal(scrub("at /tmp/test-repo/a.ts", ["test"], ["/tmp/test-repo"]), "at [redacted]/a.ts");
  assert.equal(scrub("p=/repo/x?k=1&t", ["/repo/x?k=1"], ["/repo"]), "p=[redacted]&t");
  assert.equal(scrub("a /repo/b and tok", ["tok"], ["/repo"]), "a ./b and [redacted]");
  assert.equal(scrub("pw%21123 pw!123", ["pw%21123", "pw!123"], []), "[redacted] [redacted]");
  assert.equal(scrub("aSYNTHa aSYNTHaSYNTHa", ["aSYNTHa"], []), "[redacted] [redacted]");
  assert.equal(scrub("aSYNTHaSYNTHa", ["aSYNTHa"], []), "[redacted]");
  assert.equal(scrub("keep this", ["", "zzz"], [""]), "keep this");
  assert.equal(scrub("x.y x+y", ["x.y"], []), "[redacted] x+y");
  assert.equal(scrub("abcd", ["ab", "cd"], []), "[redacted][redacted]");
  assert.equal(scrub("abcd", ["abc", "bcd"], []), "[redacted]");
});

test("a named project prefix on the FAIL line still names the file", () => {
  const log = [" FAIL  |integration| a.test.ts > suite", "Error: Hook timed out in 5ms.", ""].join(
    "\n",
  );
  assert.deepEqual(logFailureHeaders(log).get("a.test.ts"), ["Error: Hook timed out in 5ms."]);
});

test("redaction covers short values and object keys but not trivial values", () => {
  assert.deepEqual(sensitiveValues({ SHORT_SECRET: "abc", PATH: "/usr/bin:/bin" }, "h"), ["abc"]);
  assert.deepEqual(sensitiveValues({ A_TOKEN: "ab", B_TOKEN: "true", C_TOKEN: "1234" }, "h"), []);
  const scrubber = { values: ["secret-value"] };
  assert.deepEqual(redactDeep({ "k-secret-value": ["x-secret-value"] }, scrubber), {
    "k-[redacted]": ["x-[redacted]"],
  });
});

test("a run without a JSON report still writes its log and summary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hub-shard-noreport-"));
  t.after(() => rm(directory, { recursive: true }));
  const logPath = join(directory, "in.log");
  await writeFile(logPath, "vitest crashed\n");
  const execute = async () => ({
    exitCode: 1,
    durationMs: 10,
    log: logPath,
    failedFiles: ["a.test.ts"],
    incompleteFiles: 1,
    counts: { passed: 0, failed: 0, skipped: 0 },
    diagnostic: "Vitest exited without a readable JSON report",
  });
  const exitCode = await runShardJob({
    title: "Shard 1/6",
    label: "shard-1",
    files: ["a.test.ts"],
    root,
    execute,
    env: {},
    host: "h",
    reportDir: join(directory, "out"),
    summaryPath: join(directory, "summary.md"),
    print: () => {},
  });
  assert.equal(exitCode, 1);
  assert.deepEqual((await readdir(join(directory, "out"))).sort(), [
    "shard-1.summary.json",
    "vitest.log",
  ]);
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
