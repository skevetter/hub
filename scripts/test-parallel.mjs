import { createReadStream, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  isEntrypoint,
  passedVitestReport,
  printRunContext,
  repositoryFor,
  requireGit,
} from "./test-context.mjs";
import { publishTestMetrics } from "./test-receipt.mjs";
import baselineTimings from "./test-timings.json" with { type: "json" };
import runtimeFiles from "./test-runtime-files.json" with { type: "json" };
import {
  BUILT_SERVER_KEY,
  UsageError,
  coverageProblems,
  runShardJob,
  selectMode,
  splitBuiltOnly,
} from "./test-shard.mjs";
import { timingEntries } from "./generate-test-timings.mjs";
import { runWorkerGroup, takeFullSuiteLock, watchTestSignals } from "./test-worker-group.mjs";

const failedListVersion = 1;

function comparePaths(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function partitionFiles(files, count) {
  const shardCount = Math.min(count, files.length);
  const ideal = files.reduce((sum, file) => sum + file.weight, 0) / shardCount;
  const sorted = [...files].sort((a, b) => b.weight - a.weight || comparePaths(a.path, b.path));
  const pinned = sorted.filter((file) => file.cached !== false && file.weight > ideal);
  const pinnedPaths = new Set(pinned.map((file) => file.path));
  const shards = Array.from({ length: shardCount - pinned.length }, () => ({
    files: [],
    weight: 0,
  }));
  for (const file of sorted) {
    if (pinnedPaths.has(file.path)) continue;
    const lightest = shards.reduce((first, next) => (next.weight < first.weight ? next : first));
    lightest.files.push(file.path);
    lightest.weight += file.weight;
  }
  return [...pinned.map(({ path }) => [path]), ...shards.map((shard) => shard.files)];
}

function incompleteSummary(count) {
  return count ? `, ${count} files without a result` : "";
}

function printRun(print, name, files, result) {
  const { passed, failed, skipped } = result.counts;
  const seconds = (result.durationMs / 1000).toFixed(2);
  print(
    `${name}: ${result.exitCode === 0 ? "PASS" : "FAIL"} in ${seconds}s, ${files.length} files, ${passed} passed, ${failed} failed, ${skipped} skipped${incompleteSummary(result.incompleteFiles)}`,
  );
  if (result.diagnostic) print(`  ${name}: ${result.diagnostic}`);
  for (const file of result.failedFiles) print(`  ${name}: ${file}`);
}

function printInterrupted(print, signal, count) {
  if (signal?.aborted) print(`INTERRUPTED: ${count} files did not report`);
}

function readMachineLoad() {
  return { averages: loadavg(), cores: availableParallelism() };
}

export function planShards(override, readLoad = readMachineLoad) {
  const start = readLoad();
  const { averages, cores } = start;
  const count = override ?? Math.min(6, Math.max(1, Math.round(cores / 3)));
  const reason =
    override === undefined ? `${cores} cores / 3, rounded and clamped to 1-6` : "TEST_SHARDS";
  const [load1, load5] = averages;
  const timeoutLoad =
    load5 > load1 ? { minutes: 5, average: load5 } : { minutes: 1, average: load1 };
  const multiplier = Math.min(4, Math.max(1, timeoutLoad.average / cores));
  // Match vitest.config.ts and Vitest's Node hook and teardown defaults.
  const timeoutFlags = [
    `--testTimeout=${Math.round(30_000 * multiplier)}`,
    `--hookTimeout=${Math.round(10_000 * multiplier)}`,
    `--teardownTimeout=${Math.round(10_000 * multiplier)}`,
  ];
  return { count, reason, start, multiplier, timeoutFlags, timeoutLoad };
}

function printMachineLoad(print, phase, { averages, cores }) {
  const formatted = averages.map((load) => load.toFixed(2)).join(", ");
  print(`Machine load at ${phase} (1, 5, 15 min): ${formatted}; available cores: ${cores}`);
}

export async function runShards(
  groups,
  { execute, print, signal, readLoad = readMachineLoad, start = readLoad() },
) {
  printMachineLoad(print, "start", start);
  if (start.averages[0] > start.cores) {
    print("WARNING: Machine load exceeds available cores. Timings and timeouts may be unreliable.");
  }
  try {
    const outcomes = await Promise.allSettled(
      groups.map(async (files, index) => {
        const name = `Shard ${index + 1}`;
        const result = await execute(name, files);
        printRun(print, name, files, result);
        return result;
      }),
    );
    return summarizeShards(groups, outcomes, { print, signal });
  } finally {
    printMachineLoad(print, "end", readLoad());
  }
}

function rejectedShard(reason, files, index, { print, signal }) {
  const interrupted = signal?.aborted && reason === signal.reason;
  print(
    `Shard ${index + 1}: FAIL. Runner stopped (${reason?.code ?? reason}). Files without a result: ${files.join(", ")}`,
  );
  return {
    exitCode: 1,
    incompleteFiles: files.length,
    interruptedFiles: interrupted ? files.length : 0,
    counts: { passed: 0, failed: 0, skipped: 0 },
  };
}

function summarizeShards(groups, outcomes, { print, signal }) {
  const total = { files: groups.flat().length, passed: 0, failed: 0, skipped: 0 };
  const failedFiles = [];
  let incompleteFiles = 0;
  let interruptedFiles = 0;
  let exitCode = Number(Boolean(signal?.aborted));
  for (const [index, outcome] of outcomes.entries()) {
    const files = groups[index];
    const result =
      outcome.status === "rejected"
        ? rejectedShard(outcome.reason, files, index, { print, signal })
        : outcome.value;
    if (result.exitCode !== 0) {
      exitCode = 1;
      // The report cannot always attribute a process failure to an individual file.
      failedFiles.push(...files);
    }
    incompleteFiles += result.incompleteFiles ?? 0;
    interruptedFiles += result.interruptedFiles ?? 0;
    for (const key of ["passed", "failed", "skipped"]) total[key] += result.counts[key];
  }
  print(
    `Total: ${total.files} files, ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped${incompleteSummary(incompleteFiles)}`,
  );

  printInterrupted(print, signal, interruptedFiles);
  if (failedFiles.length) {
    print("Run npm run test:parallel -- --rerun-failed to recheck failed files serially.");
  }
  return { exitCode, failedFiles };
}

export async function rerunFiles(files, execute, print, signal) {
  const result = await execute("Serial rerun", files);
  if (signal?.aborted) {
    printInterrupted(print, signal, result.interruptedFiles ?? 0);
    return 1;
  }
  printRun(print, "Serial rerun", files, result);
  return result.exitCode;
}

async function readFullTimings(cacheRoot) {
  try {
    const cache = JSON.parse(await readFile(join(cacheRoot, "test-parallel/results.json"), "utf8"));
    return cache?.results?.length && Array.isArray(cache.results) ? cache.results : null;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

async function loadTimings(cacheRoot, baselineOnly) {
  const full = baselineOnly ? null : await readFullTimings(cacheRoot);
  if (!full) return new Map(Object.entries(baselineTimings));
  const cached = new Map();
  for (const [key, result] of full) {
    if (Number.isFinite(result?.duration) && result.duration >= 0) {
      cached.set(key.slice(key.indexOf(":") + 1), result.duration);
    }
  }
  return cached;
}

export async function weighFiles(root, cacheRoot, paths, { baselineOnly = false } = {}) {
  const cached = await loadTimings(cacheRoot, baselineOnly);
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      size: Math.max(1, (await stat(join(root, path))).size),
      duration: cached.get(path),
    })),
  );
  const known = files.filter((file) => file.duration !== undefined);
  const millisecondsPerByte =
    known.length === 0
      ? 1
      : known.reduce((sum, file) => sum + file.duration, 0) /
        known.reduce((sum, file) => sum + file.size, 0);
  return files.map(({ path, size, duration }) => ({
    path,
    weight: Math.max(1, duration ?? size * millisecondsPerByte),
    cached: duration !== undefined,
  }));
}

export function shardEstimates(groups, weighted) {
  const weights = new Map(weighted.map(({ path, weight }) => [path, weight]));
  return groups.map((files, index) => {
    const seconds = files.reduce((sum, file) => sum + weights.get(file), 0) / 1000;
    return `Shard ${index + 1} estimate: ${seconds.toFixed(2)}s (${files.length} files)`;
  });
}

export function shardEnvironment(directory, parent = process.env) {
  const miseDataHome = parent.XDG_DATA_HOME || join(parent.HOME || homedir(), ".local", "share");
  const env = {
    ...parent,
    // Mise shims need the caller's installed tools after XDG_DATA_HOME changes.
    MISE_DATA_DIR: parent.MISE_DATA_DIR ?? join(miseDataHome, "mise"),
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    XDG_DATA_HOME: join(directory, "data"),
    PASEO_HUB_DATA_DIR: join(directory, "embedded"),
    HUB_VITEST_CACHE_DIR: join(directory, "vite"),
    // Testcontainers coordinates Ryuk reuse through TMPDIR, which each shard owns.
    TESTCONTAINERS_RYUK_TEST_LABEL: "true",
  };
  delete env.TESTCONTAINERS_RYUK_PORT;
  return env;
}

export async function invokeVitest(args, { root, directory, signal, lock }) {
  await mkdir(directory);
  const log = await open(join(directory, "vitest.log"), "w", 0o600);
  try {
    return await runWorkerGroup([join(root, "node_modules/vitest/vitest.mjs"), ...args], {
      cwd: root,
      env: shardEnvironment(directory),
      log,
      lock,
      signal,
    });
  } finally {
    await log.close();
  }
}

async function readVitestReport(reportPath) {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return Array.isArray(report?.testResults) ? report : null;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function unreportedRun({ run, files, durationMs, signal, log }) {
  return {
    exitCode: 1,
    durationMs,
    log,
    failedFiles: files,
    incompleteFiles: files.length,
    interruptedFiles: signal.aborted ? files.length : 0,
    counts: { passed: 0, failed: 0, skipped: 0 },
    diagnostic: `Vitest exited without a readable JSON report (exit ${run.exitCode}, ${run.processError ?? "no signal"}). Files without a result: ${files.join(", ")}. See ${log}`,
  };
}

export async function executeFiles({
  root,
  name,
  files,
  runDirectory,
  signal,
  invoke,
  timeoutFlags = [],
  collectTiming = false,
}) {
  const directory = join(runDirectory, name.toLowerCase().replaceAll(" ", "-"));
  const reportPath = join(directory, "results.json");
  const startedAt = performance.now();
  const run = await invoke(
    [
      "run",
      "--reporter=json",
      "--reporter=default",
      `--outputFile=${reportPath}`,
      ...timeoutFlags,
      ...files.map((file) => join(root, file)),
    ],
    directory,
    signal,
  );
  const durationMs = performance.now() - startedAt;
  const log = join(directory, "vitest.log");
  const report = await readVitestReport(reportPath);
  if (!report) return unreportedRun({ run, files, durationMs, signal, log });
  const result = summarizeReport(report, { root, files, run, durationMs, signal, log, reportPath });
  Object.assign(result, { report, log, processError: run.processError, runExit: run.exitCode });
  if (result.exitCode) result.cleanLog = await logHasNoUnhandledErrors(log);
  if (collectTiming && !signal.aborted) {
    result.timings = await completedTimings(report, { root, files, run, log });
  }
  return result;
}

function reportHasEveryFile(testResults, root, files) {
  const reported = new Set(testResults.map(({ name }) => relative(root, name)));
  return testResults.length === files.length && files.every((file) => reported.has(file));
}

async function normalShardExit(report, run, log) {
  if (run.processError) return false;
  const explainedExit =
    run.exitCode === 0
      ? passedVitestReport(report)
      : run.exitCode === 1 && report.testResults.some(({ status }) => status === "failed");
  return explainedExit && (await logHasNoUnhandledErrors(log));
}

async function logHasNoUnhandledErrors(log) {
  // Vitest's JSON reporter omits unhandled errors, including fork crashes.
  const marker = /Vitest caught \d+ unhandled errors? during the test run/u;
  let overlap = "";
  try {
    for await (const chunk of createReadStream(log, { encoding: "utf8" })) {
      const text = overlap + chunk;
      if (marker.test(text)) return false;
      // Keep enough text for a marker split across two chunks.
      overlap = text.slice(-128);
    }
    return true;
  } catch {
    return false;
  }
}

async function completedTimings(report, { root, files, run, log }) {
  if (!reportHasEveryFile(report.testResults, root, files)) return [];
  const timings = timingEntries(report, root);
  if (!timings || !(await normalShardExit(report, run, log))) return [];
  return timings;
}

function compareReportFiles(testResults, { root, files, processExit }) {
  const reported = new Set(testResults.map(({ name }) => relative(root, name)));
  const expected = new Set(files);
  const unfinished = new Set(
    testResults
      .filter(
        ({ status, assertionResults }) =>
          status !== "failed" &&
          (assertionResults?.some((test) => test.status === "pending") ||
            (processExit && !assertionResults?.length)),
      )
      .map(({ name }) => relative(root, name)),
  );
  const missing = files.filter((file) => !reported.has(file) || unfinished.has(file));
  const extra = [...reported].filter((file) => !expected.has(file));
  const failedFiles = testResults
    .filter(({ status }) => status === "failed")
    .map(({ name }) => relative(root, name))
    .filter((file) => expected.has(file));
  return { missing, extra, failedFiles };
}

function reportDiagnostic({ passed, run, signal, missing, extra, exitCode, log, reportPath }) {
  const diagnostics = [];
  if (!passed && !run.exitCode && !signal.aborted)
    diagnostics.push("Vitest JSON report did not show a completed passing run.");
  if (run.exitCode)
    diagnostics.push(
      `Vitest process failed (exit ${run.exitCode}, ${run.processError ?? "no signal"}).`,
    );
  if (missing.length) diagnostics.push(`Files without a result: ${missing.join(", ")}`);
  if (extra.length) diagnostics.push(`Unexpected files in report: ${extra.join(", ")}`);
  if (exitCode) diagnostics.push(`See ${log} and ${reportPath}`);
  return diagnostics.join("\n  ");
}

function summarizeReport(report, { root, files, run, durationMs, signal, log, reportPath }) {
  const { missing, extra, failedFiles } = compareReportFiles(report.testResults, {
    root,
    files,
    processExit: run.exitCode,
  });
  const passed = passedVitestReport(report);
  const exitCode =
    run.exitCode || Number(!passed || signal.aborted || missing.length > 0 || extra.length > 0);
  return {
    exitCode,
    durationMs,
    failedFiles,
    incompleteFiles: missing.length,
    interruptedFiles: signal.aborted ? missing.length : 0,
    counts: {
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.testResults
        .flatMap(({ assertionResults }) => assertionResults ?? [])
        .filter(({ status }) => status === "skipped" || status === "todo").length,
    },
    diagnostic: reportDiagnostic({
      passed,
      run,
      signal,
      missing,
      extra,
      exitCode,
      log,
      reportPath,
    }),
  };
}

function writeJson(target, data) {
  mkdirSync(dirname(target), { recursive: true });
  const pending = `${target}.${process.pid}`;
  try {
    writeFileSync(pending, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
}

async function readFailedFiles(failedFileList, files) {
  const recorded = await readFile(failedFileList, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (recorded === null) throw new Error("The last parallel run recorded no failed files.");
  const failure = JSON.parse(recorded);
  if (failure?.version !== failedListVersion || !Array.isArray(failure.files))
    throw new Error(
      "The failed-file list uses an unsupported format. Run the parallel suite again.",
    );
  const failed = failure.files;
  if (failed.length === 0) throw new Error("The last parallel run recorded no failed files.");
  const discovered = new Set(files);
  if (failed.some((file) => !discovered.has(file))) {
    throw new Error("Some failed files are no longer present. Run the parallel suite again.");
  }
  return failed;
}

async function discoverFiles(root, runDirectory, invoke) {
  const discovery = join(runDirectory, "discovery");
  const listing = join(discovery, "files.json");
  const found = await invoke(["list", "--filesOnly", `--json=${listing}`], discovery);
  if (found.exitCode) {
    const reason = found.processError ?? `exit ${found.exitCode}`;
    throw new Error(
      `Vitest file discovery failed (${reason}). See ${join(discovery, "vitest.log")}`,
    );
  }
  const files = JSON.parse(await readFile(listing, "utf8")).map(({ file }) => relative(root, file));
  if (files.length === 0 || new Set(files).size !== files.length) {
    throw new Error("Vitest did not discover a unique set of test files.");
  }
  return files;
}

function saveTimings(cacheRoot, timings, { root, head, finalized }) {
  try {
    const currentHead = requireGit(root, ["rev-parse", "--verify", "HEAD"]).trim();
    if (currentHead !== head) {
      console.warn(
        `Skipping Vitest timing cache update: HEAD changed from ${head} to ${currentHead}.`,
      );
      return;
    }
    if (!finalized) return;
    const results = timings.map(([file, duration]) => [file, { duration }]);
    writeJson(join(cacheRoot, "test-parallel/results.json"), { version: 1, results });
  } catch (error) {
    console.warn(`Could not update the Vitest timing cache: ${error.message}`);
  }
}

async function runSerialRetry(files, { execute, signal, publishSuccess }) {
  return rerunFiles(
    files,
    async (name, selected) => {
      const result = await execute(name, selected);
      if (result.exitCode === 0 && !signal.aborted) await publishSuccess();
      return result;
    },
    console.log,
    signal,
  );
}

async function runFullSuite({
  root,
  head,
  cacheRoot,
  files,
  shardOverride,
  failedFileList,
  execute,
  signal,
  publishSuccess,
}) {
  await rm(failedFileList, { force: true });
  const weighted = await weighFiles(root, cacheRoot, files);
  const { count, reason, start, multiplier, timeoutFlags, timeoutLoad } = planShards(shardOverride);
  const groups = partitionFiles(weighted, count);
  const startedAt = performance.now();
  console.log(
    `Running ${files.length} Vitest files across ${groups.length} shards (${count} requested: ${reason}).`,
  );
  for (const line of shardEstimates(groups, weighted)) console.log(line);
  console.log(
    `Vitest shard timeouts (${multiplier.toFixed(2)}x from ${timeoutLoad.minutes}-min load ${timeoutLoad.average.toFixed(2)}, ms): ${timeoutFlags.join(" ")}`,
  );
  const timings = [];
  const result = await runShards(groups, {
    execute: async (name, selected) => {
      const shard = await execute(name, selected, { timeoutFlags, collectTiming: true });
      timings.push(...(shard.timings ?? []));
      return shard;
    },
    print: console.log,
    signal,
    start,
  });
  console.log(`Shard execution wall time: ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
  if (result.failedFiles.length)
    writeJson(failedFileList, { version: failedListVersion, files: result.failedFiles });
  let finalized = false;
  try {
    if (result.exitCode === 0 && !signal.aborted) await publishSuccess();
    finalized = true;
  } finally {
    if (!signal.aborted && timings.length === files.length) {
      saveTimings(cacheRoot, timings, { root, head, finalized });
    }
  }
  return result.exitCode;
}

function parseShardOverride(requested) {
  if (requested === undefined) return undefined;
  const count = Number(requested);
  if (!/^\d+$/u.test(requested) || !Number.isSafeInteger(count) || count < 1) {
    throw new Error("TEST_SHARDS must be a positive integer.");
  }
  return count;
}

const ACTIONS = {
  full: "run the sharded Vitest suite",
  rerun: "rerun failed Vitest files",
  shard: "run one shard of the Vitest suite",
  "built-only": "run the Vitest files that need the built server",
  coverage: "check that shards cover every Vitest file",
};

function parseCommandLine(argv = process.argv.slice(2), env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: "string" },
        shard: { type: "string" },
        "rerun-failed": { type: "boolean" },
        "built-only": { type: "boolean" },
        "check-coverage": { type: "boolean" },
      },
    }));
  } catch (error) {
    if (String(error.code).startsWith("ERR_PARSE_ARGS")) throw new UsageError(error.message);
    throw error;
  }
  return { values, mode: selectMode(values, env) };
}

async function splitFiles(root, cacheRoot, files) {
  const { shardable, builtOnly } = splitBuiltOnly(files, runtimeFiles[BUILT_SERVER_KEY]);
  const weighted = await weighFiles(root, cacheRoot, shardable, { baselineOnly: true });
  return { shardable, builtOnly, weighted };
}

async function checkCoverage({ root, cacheRoot, files, total }) {
  const { builtOnly, weighted } = await splitFiles(root, cacheRoot, files);
  const groups = partitionFiles(weighted, total);
  const problems = coverageProblems(files, { groups, builtOnly, total });
  const untimed = weighted.filter(({ cached }) => !cached).length;
  if (untimed > 0)
    console.log(`::warning::${untimed} of ${files.length} files have no recorded timing.`);
  for (const problem of problems) console.log(`::error::${problem}`);
  console.log(
    `Coverage: ${files.length} files, ${groups.length} shards, ${builtOnly.length} built-only. ${problems.length ? "FAIL" : "OK"}`,
  );
  return problems.length ? 1 : 0;
}

async function selectedJob(mode, { root, cacheRoot, files }) {
  const { builtOnly, weighted } = await splitFiles(root, cacheRoot, files);
  if (mode.kind === "built-only") {
    return { title: "Built-only", label: "built-only", files: builtOnly };
  }
  const { index, total } = mode.selection;
  const group = partitionFiles(weighted, total)[index - 1];
  if (!group?.length) throw new Error(`Shard ${index}/${total} has no files.`);
  return { title: `Shard ${index}/${total}`, label: `shard-${index}`, files: group };
}

async function runSelected(mode, { root, cacheRoot, files, execute }) {
  const job = await selectedJob(mode, { root, cacheRoot, files });
  console.log(`${job.title}: ${job.files.length} of ${files.length} files.`);
  return runShardJob({
    ...job,
    root,
    execute,
    env: process.env,
    reportDir: process.env.TEST_SHARD_REPORT_DIR,
    summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });
}

async function runMode(mode, context) {
  const { root, cacheRoot, files, execute } = context;
  if (mode.kind === "coverage") return checkCoverage({ root, cacheRoot, files, total: mode.total });
  if (mode.kind === "shard" || mode.kind === "built-only") {
    return runSelected(mode, { root, cacheRoot, files, execute });
  }
  const { failedFileList, signal, publishSuccess } = context;
  if (mode.kind === "rerun") {
    const failed = await readFailedFiles(failedFileList, files);
    return runSerialRetry(failed, { execute, signal, publishSuccess });
  }
  return runFullSuite(context);
}

async function main(signal) {
  const { values, mode } = parseCommandLine();
  const root = repositoryFor(import.meta.url, values.root);
  const { head } = printRunContext(root, ACTIONS[mode.kind]);
  const cacheRoot = join(root, "node_modules/.vite/vitest");
  const failedFileList = join(cacheRoot, "test-parallel", "failed.json");
  const shardOverride =
    mode.kind === "full" || mode.kind === "rerun"
      ? parseShardOverride(process.env.TEST_SHARDS)
      : undefined;
  let lock;
  let runDirectory;
  try {
    lock = await takeFullSuiteLock();
    runDirectory = await mkdtemp(join(tmpdir(), "hub-tests-"));
    const invoke = (args, directory) => invokeVitest(args, { root, directory, signal, lock });
    const files = await discoverFiles(root, runDirectory, invoke);
    const runs = [];
    const publishSuccess = async () => {
      signal.throwIfAborted();
      await rm(runDirectory, { recursive: true });
      runDirectory = undefined;
      signal.throwIfAborted();
      publishTestMetrics(runs, [], root, { signal, expectedHead: head });
    };
    const execution = { root, runDirectory, signal, invoke };
    const execute = async (name, selected, options) => {
      const result = await executeFiles({ ...execution, name, files: selected, ...options });
      runs.push({ files: selected, counts: result.counts });
      return result;
    };
    return await runMode(mode, {
      root,
      head,
      cacheRoot,
      files,
      failedFileList,
      shardOverride,
      execute,
      signal,
      publishSuccess,
    });
  } finally {
    if (runDirectory && mode.kind === "coverage") await rm(runDirectory, { recursive: true });
    else if (runDirectory && mode.kind !== "rerun") console.log(`Run logs: ${runDirectory}`);
    lock?.release();
  }
}

if (isEntrypoint(import.meta.url)) {
  const { signal, close } = watchTestSignals();
  main(signal)
    .then(
      (code) => {
        process.exitCode = signal.aborted ? 1 : code;
      },
      (error) => {
        if (error !== signal.reason && error instanceof Error) console.error(error.message);
        process.exitCode = error instanceof UsageError ? 2 : 1;
      },
    )
    .finally(() => {
      if (signal.aborted) console.log(`INTERRUPTED: ${signal.reason}`);
      close();
    });
}
