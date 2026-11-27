import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";

export const BUILT_SERVER_KEY = ".output/server/";
export const RETRY_CAP = 5;
export const DEFAULT_SHARD_TOTAL = 6;
const MAX_SHARD_TOTAL = 100;
const MIN_REDACTED_LENGTH = 6;
const SHARD_PATTERN = /^([1-9]\d*)\/([1-9]\d*)$/u;
const COUNT_PATTERN = /^[1-9]\d*$/u;
const SENSITIVE_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION/iu;
const HOST_NAMES = ["HOSTNAME", "RUNNER_NAME", "COMPUTERNAME"];
const CONTAINER_START_PATTERNS = [
  /Port \d+\/tcp not bound after \d+ ?ms/u,
  /Hook timed out in \d+ ?ms/u,
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

function failureTexts(file) {
  const failed = (file.assertionResults ?? []).filter(({ status }) => status === "failed");
  return [file.message, ...failed.flatMap(({ failureMessages }) => failureMessages ?? [])].filter(
    (text) => typeof text === "string" && text.trim() !== "",
  );
}

/** True when every failure in the file is a container-start timeout. Nothing else is retried. */
export function containerStartFailure(file) {
  const texts = failureTexts(file);
  return (
    texts.length > 0 &&
    texts.every((text) => CONTAINER_START_PATTERNS.some((pattern) => pattern.test(text)))
  );
}

/** The failed files, when all of them failed only on a container start. Otherwise empty. */
export function retryableFiles(report, failedFiles, root) {
  if (failedFiles.length === 0) return [];
  const failed = new Set(failedFiles);
  const results = report.testResults.filter(({ name }) => failed.has(relative(root, name)));
  const retryable = results.length === failed.size && results.every(containerStartFailure);
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

export function sensitiveValues(env = process.env, host = hostname()) {
  const named = Object.entries(env)
    .filter(([name]) => SENSITIVE_NAME.test(name) || HOST_NAMES.includes(name))
    .map(([, value]) => value);
  return [...new Set([...named, host])]
    .filter((value) => typeof value === "string" && value.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b.length - a.length);
}

export function redactText(text, values) {
  return values.reduce((result, value) => result.split(value).join("[redacted]"), text);
}

export function redactDeep(value, values) {
  if (typeof value === "string") return redactText(value, values);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, values)]),
    );
  }
  return value;
}

export function outcomeLine({ title, passed, durationMs, counts, files, retried }) {
  const seconds = (durationMs / 1000).toFixed(1);
  const result = passed ? "PASS" : "FAIL";
  return `${title}: ${result} in ${seconds}s, ${files} files, ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${retried} retried`;
}

function slowestFiles(report, root, limit) {
  return report.testResults
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

/** Writes the artifact files. Env values and the host name are removed from every file. */
export function writeShardArtifacts(directory, label, { report, summary, logs }, values) {
  mkdirSync(directory, { recursive: true });
  const write = (name, data) =>
    writeFileSync(join(directory, name), `${JSON.stringify(redactDeep(data, values))}\n`);
  write(`${label}.json`, report);
  write(`${label}.summary.json`, summary);
  for (const [name, path] of logs.filter(([, path]) => existsSync(path))) {
    writeFileSync(join(directory, name), redactText(readFileSync(path, "utf8"), values));
  }
}

export function appendStepSummary(path, markdown) {
  if (path) appendFileSync(path, markdown);
}

function retryCandidates(first, root) {
  const unexplained =
    first.incompleteFiles || first.processError || !first.cleanLog || !first.report;
  if (unexplained) return [];
  return retryableFiles(first.report, first.failedFiles, root);
}

function sumCounts(first, retry) {
  return countAssertions(mergeReports([first.report], retry.report).testResults);
}

async function retryOnce(first, { label, root, execute, candidates }) {
  const retry = await execute(`${label} retry`, candidates);
  const report = mergeReports([first.report], retry.report);
  const failed = retry.exitCode !== 0;
  return {
    exitCode: failed ? 1 : 0,
    durationMs: first.durationMs + retry.durationMs,
    counts: sumCounts(first, retry),
    report,
    failedFiles: failed ? retry.failedFiles : [],
    retried: candidates,
    retryFailed: failed,
    diagnostic: retry.diagnostic,
    logs: [first.log, retry.log],
    root,
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

/** Runs the files once. Retries the failed ones once, serially, only after container-start timeouts. */
export async function runWithRetry({ label, files, root, execute }) {
  const first = await execute(label, files);
  if (first.exitCode === 0) return singleRun(first);
  const candidates = retryCandidates(first, root);
  if (candidates.length === 0) return singleRun(first);
  if (candidates.length > RETRY_CAP) {
    const diagnostic = `${candidates.length} files failed on container-start timeouts, more than ${RETRY_CAP}. Not retried.`;
    return { ...singleRun(first), tooManyRetries: candidates.length, diagnostic };
  }
  return retryOnce(first, { label, root, execute, candidates });
}

export function retryAnnotations(result) {
  const lines = (result.retried ?? []).map((file) =>
    result.retryFailed
      ? `::error title=Failed again after a container-start retry::${file}`
      : `::warning title=Retried after a container-start timeout::${file} passed on a serial retry`,
  );
  if (result.tooManyRetries) {
    lines.push(`::error title=Too many container-start timeouts::${result.diagnostic}`);
  }
  return lines;
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
  if (result.diagnostic) print(`  ${title}: ${result.diagnostic}`);
  for (const file of result.failedFiles) print(`  ${title}: ${file}`);
  for (const annotation of retryAnnotations(result)) print(annotation);
  const exitCode = result.tooManyRetries ? 1 : result.exitCode;
  const values = sensitiveValues(options.env, options.host);
  if (reportDir) {
    const summary = summaryRecord({ title, label, files: files.length, result, line });
    const logs = [
      ["vitest.log", result.logs[0]],
      ["vitest.retry.log", result.logs[1] ?? ""],
    ];
    writeShardArtifacts(reportDir, label, { report: result.report, summary, logs }, values);
  }
  const markdown = stepSummary({ title, line, report: result.report, root, retried });
  appendStepSummary(summaryPath, redactText(markdown, values));
  return exitCode;
}
