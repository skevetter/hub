import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, relative } from "node:path";

export const BUILT_SERVER_KEY = ".output/server/";
export const RETRY_CAP = 5;
export const DEFAULT_SHARD_TOTAL = 6;
const MAX_SHARD_TOTAL = 100;
const MIN_REDACTED_LENGTH = 3;
const TRIVIAL_VALUE = /^(?:\d{1,4}|true|false|yes|no|on|off|null|undefined)$/iu;
const SHARD_PATTERN = /^([1-9]\d*)\/([1-9]\d*)$/u;
const COUNT_PATTERN = /^[1-9]\d*$/u;
const SENSITIVE_NAME =
  /TOKEN|SECRET|KEY|PASS|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|URL|URI|DSN|JWT|BEARER|SALT|SIG|CONN|WEBHOOK|CERT|SEED/iu;
const PUBLIC_NAMES = new Set(["GITHUB_SERVER_URL", "GITHUB_API_URL", "GITHUB_GRAPHQL_URL"]);
const HOST_NAMES = ["HOSTNAME", "RUNNER_NAME", "COMPUTERNAME"];
const CONTAINER_START_PATTERNS = [
  /^(?:\w*Error: )?Port \d+\/tcp not bound after \d+ ?ms\b/u,
  /^(?:\w*Error: )?Hook timed out in \d+ ?ms\b/u,
];

/** A bad command line or environment: the process exits 2 instead of 1. */
export class UsageError extends Error {}

function shardNumbers(indexText, totalText, source) {
  if (!COUNT_PATTERN.test(indexText) || !COUNT_PATTERN.test(totalText)) {
    throw new UsageError(
      `${source} must be positive whole numbers, got ${indexText}/${totalText}.`,
    );
  }
  const index = Number(indexText);
  const total = Number(totalText);
  if (index > total || total > MAX_SHARD_TOTAL) {
    throw new UsageError(
      `${source} must have 1 <= index <= total <= ${MAX_SHARD_TOTAL}, got ${index}/${total}.`,
    );
  }
  return { index, total };
}

export function parseShardTotal(text, source = "TEST_SHARD_TOTAL") {
  if (!COUNT_PATTERN.test(text) || Number(text) > MAX_SHARD_TOTAL) {
    throw new UsageError(
      `${source} must be a whole number from 1 to ${MAX_SHARD_TOTAL}, got ${text}.`,
    );
  }
  return Number(text);
}

/** `--shard i/N` wins over TEST_SHARD_INDEX and TEST_SHARD_TOTAL. Returns undefined when unset. */
export function parseShardSelection(argument, env = process.env) {
  if (argument !== undefined) {
    const match = SHARD_PATTERN.exec(argument);
    if (!match) throw new UsageError(`--shard must look like 3/6, got ${argument}.`);
    return shardNumbers(match[1], match[2], "--shard");
  }
  const { TEST_SHARD_INDEX: index, TEST_SHARD_TOTAL: total } = env;
  if (index === undefined && total === undefined) return undefined;
  if (index === undefined || total === undefined) {
    throw new UsageError("TEST_SHARD_INDEX and TEST_SHARD_TOTAL must be set together.");
  }
  return shardNumbers(index, total, "TEST_SHARD_INDEX and TEST_SHARD_TOTAL");
}

function totalFromEnv(env) {
  return env.TEST_SHARD_TOTAL === undefined ? undefined : parseShardTotal(env.TEST_SHARD_TOTAL);
}

function chosenModes(values) {
  return [
    values["rerun-failed"] === true && "rerun",
    values["built-only"] === true && "built-only",
    values["check-coverage"] === true && "coverage",
    values.shard !== undefined && "shard",
  ].filter(Boolean);
}

/** Decides what this invocation does. Only the shard modes use a machine of their own. */
export function selectMode(values, env = process.env) {
  const chosen = chosenModes(values);
  if (chosen.length > 1) {
    throw new UsageError(`Choose one of --shard, --built-only, --check-coverage, --rerun-failed.`);
  }
  if (chosen[0] === "coverage") {
    return { kind: "coverage", total: totalFromEnv(env) ?? DEFAULT_SHARD_TOTAL };
  }
  if (chosen[0] === "built-only") {
    return { kind: "built-only", total: totalFromEnv(env) };
  }
  if (chosen[0] === "rerun") return { kind: "rerun" };
  const selection = parseShardSelection(values.shard, env);
  return selection === undefined ? { kind: "full" } : { kind: "shard", selection };
}

export function splitBuiltOnly(files, builtSuites) {
  const built = new Set(builtSuites);
  const known = new Set(files);
  const missing = builtSuites.filter((file) => !known.has(file));
  if (missing.length > 0) {
    throw new Error(
      `test-runtime-files.json lists suites that were not discovered: ${missing.join(", ")}`,
    );
  }
  return {
    shardable: files.filter((file) => !built.has(file)),
    builtOnly: files.filter((file) => built.has(file)),
  };
}

function duplicatesOf(list) {
  const seen = new Set();
  return list.filter((item) => seen.size === seen.add(item).size);
}

/** Problems that stop every discovered file from running exactly once. Empty means covered. */
export function coverageProblems(files, { groups, builtOnly, total }) {
  const placed = [...groups.flat(), ...builtOnly];
  const known = new Set(files);
  const problems = [];
  if (groups.length !== total) problems.push(`Expected ${total} shards, got ${groups.length}.`);
  if (groups.some((group) => group.length === 0)) problems.push("A shard has no files.");
  const repeated = duplicatesOf(placed);
  if (repeated.length > 0) problems.push(`Run more than once: ${repeated.join(", ")}`);
  const missing = files.filter((file) => !placed.includes(file));
  if (missing.length > 0) problems.push(`Not run by any shard: ${missing.join(", ")}`);
  const extra = placed.filter((file) => !known.has(file));
  if (extra.length > 0) problems.push(`Not a discovered file: ${extra.join(", ")}`);
  return problems;
}

const ANSI_PATTERN = /\u001B\[[0-9;]*m/gu;
const FAIL_LINE =
  /^\s*FAIL\s+(?:(?:\[[^\]]*\]|\|[^|]*\|)\s*)?(\S+?\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+(?:>|\[).*)?\s*$/u;
const SEPARATOR_LINE = /^\s*\u23AF{3,}/u;
const HINT_LINE = /^If this is a long-running (?:test|hook)/u;

function firstLine(text) {
  return (
    String(text)
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

function isContainerStartHeader(text) {
  const header = firstLine(text);
  return CONTAINER_START_PATTERNS.some((pattern) => pattern.test(header));
}

function addHeader(headers, files, line) {
  for (const file of files) headers.set(file, [...(headers.get(file) ?? []), line]);
}

/**
 * Error lines the default reporter printed for each failing test file, keyed by file.
 * A failure block starts with one or more FAIL lines. Every unindented line after them, up
 * to the next rule line, is an error header for all of those files.
 */
export function logFailureHeaders(logText) {
  const headers = new Map();
  let files = [];
  let inErrors = false;
  for (const raw of logText.replace(ANSI_PATTERN, "").split("\n")) {
    const line = raw.trimEnd();
    const failed = FAIL_LINE.exec(line);
    if (failed) {
      if (inErrors) files = [];
      files.push(failed[1]);
      inErrors = false;
    } else if (SEPARATOR_LINE.test(line)) {
      files = [];
      inErrors = false;
    } else if (files.length > 0 && line !== "" && !/^\s/u.test(line) && !HINT_LINE.test(line)) {
      addHeader(headers, files, line);
      inErrors = true;
    }
  }
  return headers;
}

function reportedFailures(file) {
  const assertions = file.assertionResults ?? [];
  const failed = assertions.filter(({ status }) => status === "failed");
  const texts = failed.map(({ failureMessages }) => (failureMessages ?? []).join("\n"));
  const fileMessage = typeof file.message === "string" ? file.message : "";
  if (fileMessage.trim() !== "") texts.push(fileMessage);
  return { texts, unexplained: failed.some((_, index) => texts[index].trim() === "") };
}

/**
 * True when every failure of the file starts with a container-start timeout header.
 * Vitest's JSON report omits hook failures, so the log blocks count as evidence too.
 */
export function containerStartFailure(file, logHeaders = []) {
  const { texts, unexplained } = reportedFailures(file);
  const pending = (file.assertionResults ?? []).some(({ status }) => status === "pending");
  if (pending || unexplained) return false;
  const headers = [...texts, ...logHeaders];
  return headers.length > 0 && headers.every(isContainerStartHeader);
}

/** The failed files, when every one of them failed only on a container start. Otherwise empty. */
export function retryableFiles(report, failedFiles, { root, headers = new Map() }) {
  if (failedFiles.length === 0) return [];
  const failed = new Set(failedFiles);
  const results = report.testResults.filter(({ name }) => failed.has(relative(root, name)));
  const retryable =
    results.length === failed.size &&
    results.every((file) => containerStartFailure(file, headers.get(relative(root, file.name))));
  return retryable ? failedFiles : [];
}
export function countAssertions(testResults) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const { assertionResults } of testResults) {
    for (const { status } of assertionResults ?? []) {
      if (status === "passed") counts.passed += 1;
      else if (status === "failed") counts.failed += 1;
      else if (status === "skipped" || status === "todo") counts.skipped += 1;
    }
  }
  return counts;
}

/** One Vitest-shaped report for the shard. A retried file takes its entry from the retry. */
export function mergeReports(reports, retryReport) {
  const retried = new Map((retryReport?.testResults ?? []).map((entry) => [entry.name, entry]));
  const testResults = reports
    .flatMap((report) => report.testResults)
    .map((entry) => retried.get(entry.name) ?? entry);
  const counts = countAssertions(testResults);
  return {
    success: counts.failed === 0 && testResults.every(({ status }) => status === "passed"),
    numTotalTests: counts.passed + counts.failed + counts.skipped,
    numPassedTests: counts.passed,
    numFailedTests: counts.failed,
    testResults,
  };
}

function isSensitiveName(name) {
  if (PUBLIC_NAMES.has(name)) return false;
  return SENSITIVE_NAME.test(name) || HOST_NAMES.includes(name);
}

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function urlParts(value) {
  try {
    const { hostname: name, username, password } = new URL(value);
    return [name, username, decoded(username), password, decoded(password)];
  } catch {
    return [];
  }
}

export function sensitiveValues(env = process.env, host = hostname()) {
  const named = Object.entries(env)
    .filter(([name]) => isSensitiveName(name))
    .map(([, value]) => value);
  const parts = named.filter((value) => typeof value === "string").flatMap(urlParts);
  return [...new Set([...named, ...parts, host])]
    .filter(
      (value) =>
        typeof value === "string" &&
        value.length >= MIN_REDACTED_LENGTH &&
        !TRIVIAL_VALUE.test(value),
    )
    .sort((a, b) => b.length - a.length);
}

function occurrences(text, needle, secret) {
  const spans = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    spans.push({ start: at, end: at + needle.length, secret });
  }
  return spans;
}

function mergeSpans(spans) {
  const sorted = [...spans].sort((x, y) => x.start - y.start || y.end - x.end);
  const merged = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      last.secret ||= span.secret;
    } else merged.push({ ...span });
  }
  return merged;
}

/**
 * Replaces env values with [redacted] and repository root paths with a dot. Overlapping
 * matches merge into one span, and a span that touches an env value is always redacted.
 */
export function redactText(text, { values, roots = [] }) {
  const spans = [
    ...values.flatMap((value) => occurrences(text, value, true)),
    ...roots.flatMap((root) => occurrences(text, root, false)),
  ];
  let result = "";
  let at = 0;
  for (const span of mergeSpans(spans)) {
    result += text.slice(at, span.start) + (span.secret ? "[redacted]" : ".");
    at = span.end;
  }
  return result + text.slice(at);
}

export function redactDeep(value, scrubber) {
  if (typeof value === "string") return redactText(value, scrubber);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, scrubber));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(key, scrubber),
        redactDeep(item, scrubber),
      ]),
    );
  }
  return value;
}

function escapeData(text) {
  return String(text).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function plainLine(text) {
  return String(text).replace(/[\r\n]+/gu, " ");
}

export function outcomeLine({ title, passed, durationMs, counts, files, retried }) {
  const seconds = (durationMs / 1000).toFixed(1);
  const result = passed ? "PASS" : "FAIL";
  return `${title}: ${result} in ${seconds}s, ${files} files, ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${retried} retried`;
}

function slowestFiles(report, root, limit) {
  return (report?.testResults ?? [])
    .map((entry) => ({
      file: entry.name.replace(`${root}/`, ""),
      ms: entry.endTime - entry.startTime,
    }))
    .filter(({ ms }) => Number.isFinite(ms))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

export function stepSummary({ title, line, report, root, retried }) {
  const rows = slowestFiles(report, root, 5).map(
    ({ file, ms }) => `| \`${file}\` | ${(ms / 1000).toFixed(1)} s |`,
  );
  const lines = [
    `### ${title}`,
    "",
    line,
    "",
    "| Slowest files | Time |",
    "| --- | --- |",
    ...rows,
  ];
  if (retried.length > 0) {
    lines.push(
      "",
      "Retried once after a container-start timeout:",
      ...retried.map((f) => `- \`${f}\``),
    );
  }
  return `${lines.join("\n")}\n`;
}

function redactEntry(entry, scrubber, keep) {
  return Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key,
      keep.includes(key) ? value : redactDeep(value, scrubber),
    ]),
  );
}

/** Redacts every value except the structural ones, so short env values cannot rewrite names. */
export function redactReport(report, scrubber) {
  const testResults = report.testResults.map((entry) => ({
    ...redactEntry(entry, scrubber, ["name", "status"]),
    assertionResults: (entry.assertionResults ?? []).map((item) =>
      redactEntry(item, scrubber, ["status"]),
    ),
  }));
  return { ...redactEntry(report, scrubber, ["testResults"]), testResults };
}

/** Report file names relative to the repository, so artifacts carry no runner paths. */
export function relativizeReport(report, root) {
  const testResults = report.testResults.map((entry) => ({
    ...entry,
    name: relative(root, entry.name),
  }));
  return { ...report, testResults };
}

/** Writes the artifact files. Env values, the host name and the root path are removed. */
export function writeShardArtifacts(directory, label, { report, summary, logs }, scrubber) {
  mkdirSync(directory, { recursive: true });
  const write = (name, data) => writeFileSync(join(directory, name), `${JSON.stringify(data)}\n`);
  if (report) write(`${label}.json`, redactReport(report, scrubber));
  write(`${label}.summary.json`, summary);
  for (const [name, path] of logs.filter(([, path]) => path && existsSync(path))) {
    writeFileSync(join(directory, name), redactText(readFileSync(path, "utf8"), scrubber));
  }
}

export function appendStepSummary(path, markdown) {
  if (path) appendFileSync(path, markdown);
}

async function retryCandidates(first, root) {
  const unexplained =
    first.runExit !== 1 ||
    first.incompleteFiles ||
    first.processError ||
    !first.cleanLog ||
    !first.report;
  if (unexplained) return [];
  const logText = await readFile(first.log, "utf8").catch(() => null);
  if (logText === null) return [];
  const headers = logFailureHeaders(logText);
  return retryableFiles(first.report, first.failedFiles, { root, headers });
}

async function retryEachFile(candidates, { label, execute }) {
  const outcomes = [];
  for (const [index, file] of candidates.entries()) {
    const run = await execute(`${label} retry ${index + 1}`, [file]);
    outcomes.push({ file, run, passed: run.exitCode === 0 });
  }
  return outcomes;
}

function afterRetries(first, outcomes) {
  const merged = mergeReports([first.report], {
    testResults: outcomes.flatMap(({ run }) => run.report?.testResults ?? []),
  });
  const failed = outcomes.filter(({ passed }) => !passed);
  const exitCode = failed.length > 0 ? 1 : 0;
  return {
    exitCode,
    durationMs: outcomes.reduce((sum, { run }) => sum + run.durationMs, first.durationMs),
    counts: countAssertions(merged.testResults),
    report: { ...merged, success: exitCode === 0 && merged.success },
    failedFiles: failed.map(({ file }) => file),
    retried: outcomes.map(({ file }) => file),
    retryOutcomes: outcomes.map(({ file, passed }) => ({ file, passed })),
    retryFailed: failed.length > 0,
    diagnostic: failed[0]?.run.diagnostic,
    logs: [first.log, ...outcomes.map(({ run }) => run.log)],
  };
}

function singleRun(first, retried = []) {
  return {
    exitCode: first.exitCode,
    durationMs: first.durationMs,
    counts: first.counts,
    report: first.report,
    failedFiles: first.failedFiles,
    retried,
    diagnostic: first.diagnostic,
    logs: [first.log],
  };
}

/** Runs the files once. Retries the failed ones once each, serially, only after container-start timeouts. */
export async function runWithRetry({ label, files, root, execute }) {
  const first = await execute(label, files);
  if (first.exitCode === 0) return singleRun(first);
  const candidates = await retryCandidates(first, root);
  if (candidates.length === 0) return singleRun(first);
  if (candidates.length > RETRY_CAP) {
    const diagnostic = `${candidates.length} files failed on container-start timeouts, more than ${RETRY_CAP}. Not retried.`;
    return { ...singleRun(first), tooManyRetries: candidates.length, diagnostic };
  }
  return afterRetries(first, await retryEachFile(candidates, { label, execute }));
}

export function retryAnnotations(result) {
  const lines = (result.retryOutcomes ?? []).map(({ file, passed }) =>
    passed
      ? `::warning title=Retried after a container-start timeout::${escapeData(file)} passed on a serial retry`
      : `::error title=Failed again after a container-start retry::${escapeData(file)}`,
  );
  if (result.tooManyRetries) {
    lines.push(`::error title=Too many container-start timeouts::${escapeData(result.diagnostic)}`);
  }
  return lines;
}
function rootPaths(root) {
  try {
    return [...new Set([root, realpathSync(root)])];
  } catch {
    return [root];
  }
}

function summaryRecord({ title, label, files, result, line }) {
  return {
    title,
    label,
    files,
    result: result.exitCode === 0 ? "passed" : "failed",
    durationMs: Math.round(result.durationMs),
    counts: result.counts,
    retried: result.retried ?? [],
    failedFiles: result.failedFiles,
    line,
  };
}

/** Runs one shard (or the built-only group), prints annotations, writes artifacts. Returns the exit code. */
export async function runShardJob(options) {
  const {
    title,
    label,
    files,
    root,
    execute,
    reportDir,
    summaryPath,
    print = console.log,
  } = options;
  const result = await runWithRetry({ label, files, root, execute });
  const passed = result.exitCode === 0;
  const retried = result.retried ?? [];
  const line = outcomeLine({
    title,
    passed,
    durationMs: result.durationMs,
    counts: result.counts,
    files: files.length,
    retried: retried.length,
  });
  print(line);
  if (result.diagnostic) print(`  ${title}: ${plainLine(result.diagnostic)}`);
  for (const file of result.failedFiles) print(`  ${title}: ${plainLine(file)}`);
  for (const annotation of retryAnnotations(result)) print(annotation);
  const exitCode = result.tooManyRetries ? 1 : result.exitCode;
  const scrubber = { values: sensitiveValues(options.env, options.host), roots: rootPaths(root) };
  if (reportDir) {
    const summary = summaryRecord({ title, label, files: files.length, result, line });
    const logs = result.logs.map((path, index) => [
      index === 0 ? "vitest.log" : `vitest.retry-${index}.log`,
      path,
    ]);
    const report = result.report && relativizeReport(result.report, root);
    writeShardArtifacts(reportDir, label, { report, summary, logs }, scrubber);
  }
  const markdown = stepSummary({ title, line, report: result.report, root, retried });
  appendStepSummary(summaryPath, redactText(markdown, scrubber));
  return exitCode;
}
