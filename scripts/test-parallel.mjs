import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import {
  isEntrypoint,
  passedVitestReport,
  printRunContext,
  repositoryFor,
} from "./test-context.mjs";
import { publishTestMetrics } from "./test-receipt.mjs";
import { runWorkerGroup, takeFullSuiteLock, watchTestSignals } from "./test-worker-group.mjs";

export function partitionFiles(files, count) {
  const shardCount = Math.min(count, files.length);
  const ideal = files.reduce((sum, file) => sum + file.weight, 0) / shardCount;
  const sorted = [...files].sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
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

function printRun(print, name, files, result) {
  const { passed, failed, skipped } = result.counts;
  const seconds = (result.durationMs / 1000).toFixed(2);
  print(
    `${name}: ${result.exitCode === 0 ? "PASS" : "FAIL"} in ${seconds}s, ${files.length} files, ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  if (result.diagnostic) print(`  ${name}: ${result.diagnostic}`);
  for (const file of result.failedFiles) print(`  ${name}: ${file}`);
}

function printInterrupted(print, signal, count) {
  if (signal?.aborted) print(`INTERRUPTED: ${count} files did not report`);
}

export async function runShards(groups, { execute, print, signal }) {
  const outcomes = await Promise.allSettled(
    groups.map(async (files, index) => {
      const name = `Shard ${index + 1}`;
      let result = await execute(name, files);
      if (result.exitCode !== 0 && !result.failedFiles.length && !signal?.aborted) {
        result = {
          ...result,
          failedFiles: files,
          counts: { ...result.counts, failed: Math.max(files.length, result.counts.failed) },
        };
      }
      printRun(print, name, files, result);
      return result;
    }),
  );
  const total = { files: groups.flat().length, passed: 0, failed: 0, skipped: 0 };
  const failedFiles = [];
  let interruptedFiles = 0;
  let exitCode = Number(Boolean(signal?.aborted));
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      exitCode = 1;
      const files = groups[index];
      failedFiles.push(...files);
      if (signal?.aborted && outcome.reason === signal.reason) interruptedFiles += files.length;
      else total.failed += files.length;
      print(
        `Shard ${index + 1}: FAIL. Runner stopped (${outcome.reason?.code ?? outcome.reason}). Files without a result: ${files.join(", ")}`,
      );
      continue;
    }
    const result = outcome.value;
    if (result.exitCode !== 0) exitCode = 1;
    failedFiles.push(...result.failedFiles);
    interruptedFiles += result.interruptedFiles ?? 0;
    for (const key of ["passed", "failed", "skipped"]) total[key] += result.counts[key];
  }
  print(
    `Total: ${total.files} files, ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped`,
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

async function readCachedResults(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
  const caches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(directory, entry.name, "results.json");
        try {
          const info = await stat(path);
          const cache = JSON.parse(await readFile(path, "utf8"));
          return { cache, modifiedAt: info.mtimeMs, full: entry.name === "test-parallel" };
        } catch (error) {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
          throw error;
        }
      }),
  );
  return caches
    .filter(Boolean)
    .sort((a, b) => Number(a.full) - Number(b.full) || a.modifiedAt - b.modifiedAt)
    .map(({ cache }) => cache)
    .filter((cache) => Array.isArray(cache?.results));
}

async function weighFiles(root, cacheRoot, paths) {
  const cached = new Map();
  for (const cache of await readCachedResults(cacheRoot)) {
    for (const [key, result] of cache.results) {
      if (Number.isFinite(result?.duration) && result.duration > 0) {
        cached.set(key.slice(key.indexOf(":") + 1), result.duration);
      }
    }
  }
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
    weight: duration ?? size * millisecondsPerByte,
    cached: duration !== undefined,
  }));
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

export async function invokeVitest(root, args, directory, signal, lock) {
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

export async function executeFiles(root, name, files, runDirectory, signal, invoke) {
  const directory = join(runDirectory, name.toLowerCase().replaceAll(" ", "-"));
  const reportPath = join(directory, "results.json");
  const startedAt = performance.now();
  const run = await invoke(
    [
      "run",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      ...files.map((file) => join(root, file)),
    ],
    directory,
    signal,
  );
  const durationMs = performance.now() - startedAt;
  const log = join(directory, "vitest.log");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
    if (!Array.isArray(report?.testResults)) throw new SyntaxError("missing testResults");
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return {
      exitCode: 1,
      durationMs,
      failedFiles: files,
      interruptedFiles: signal.aborted ? files.length : 0,
      counts: { passed: 0, failed: signal.aborted ? 0 : files.length, skipped: 0 },
      diagnostic: `Vitest exited without a readable JSON report (exit ${run.exitCode}, ${run.processError ?? "no signal"}). Files without a result: ${files.join(", ")}. See ${log}`,
    };
  }
  const reported = new Set(report.testResults.map(({ name }) => relative(root, name)));
  const expected = new Set(files);
  const unfinished = new Set(
    report.testResults
      .filter(
        ({ status, assertionResults }) =>
          status !== "failed" &&
          (assertionResults?.some((test) => test.status === "pending") ||
            (run.exitCode && !assertionResults?.length)),
      )
      .map(({ name }) => relative(root, name)),
  );
  const missing = files.filter((file) => !reported.has(file) || unfinished.has(file));
  const extra = [...reported].filter((file) => !expected.has(file));
  const failedFiles = report.testResults
    .filter(({ status }) => status === "failed")
    .map(({ name }) => relative(root, name))
    .filter((file) => expected.has(file));
  const passed = passedVitestReport(report);
  const exitCode =
    run.exitCode || Number(!passed || signal.aborted || missing.length > 0 || extra.length > 0);
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
  const failures = [...new Set([...failedFiles, ...missing])];
  if (exitCode && !failures.length && !signal.aborted) failures.push(...files);
  return {
    exitCode,
    durationMs,
    failedFiles: failures,
    interruptedFiles: signal.aborted ? missing.length : 0,
    counts: {
      passed: report.numPassedTests,
      failed: signal.aborted
        ? report.numFailedTests
        : Math.max(report.numFailedTests, failedFiles.length) +
          (failures.length - failedFiles.length),
      skipped: report.testResults
        .flatMap(({ assertionResults }) => assertionResults ?? [])
        .filter(({ status }) => status === "skipped" || status === "todo").length,
    },
    diagnostic: diagnostics.join("\n  "),
  };
}

async function collectTimings(runDirectory, count) {
  const caches = (
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        readCachedResults(join(runDirectory, `shard-${index + 1}`, "vite/vitest")),
      ),
    )
  ).flat();
  if (caches.length === 0) return;
  return { version: caches[0].version, results: caches.flatMap((cache) => cache.results) };
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
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  const failed = JSON.parse(recorded);
  if (failed.length === 0) throw new Error("The last parallel run recorded no failed files.");
  const discovered = new Set(files);
  if (failed.some((file) => !discovered.has(file))) {
    throw new Error("Some failed files are no longer present. Run the parallel suite again.");
  }
  return failed;
}

async function main(signal) {
  const { values } = parseArgs({
    options: { root: { type: "string" }, "rerun-failed": { type: "boolean" } },
  });
  const root = repositoryFor(import.meta.url, values.root);
  printRunContext(
    root,
    values["rerun-failed"] ? "rerun failed Vitest files" : "run the sharded Vitest suite",
  );
  const cacheRoot = join(root, "node_modules/.vite/vitest");
  const parallelCache = join(cacheRoot, "test-parallel");
  const failedFileList = join(parallelCache, "failed.json");
  const requested = process.env.TEST_SHARDS ?? "4";
  const count = Number(requested);
  if (!/^\d+$/u.test(requested) || !Number.isSafeInteger(count) || count < 1) {
    throw new Error("TEST_SHARDS must be a positive integer.");
  }
  let lock;
  let runDirectory;
  try {
    lock = await takeFullSuiteLock();
    runDirectory = await mkdtemp(join(tmpdir(), "hub-tests-"));
    const discovery = join(runDirectory, "discovery");
    const listing = join(discovery, "files.json");
    const found = await invokeVitest(
      root,
      ["list", "--filesOnly", `--json=${listing}`],
      discovery,
      signal,
      lock,
    );
    if (found.exitCode) {
      const reason = found.processError ?? `exit ${found.exitCode}`;
      throw new Error(
        `Vitest file discovery failed (${reason}). See ${join(discovery, "vitest.log")}`,
      );
    }
    const files = JSON.parse(await readFile(listing, "utf8")).map(({ file }) =>
      relative(root, file),
    );
    if (files.length === 0 || new Set(files).size !== files.length) {
      throw new Error("Vitest did not discover a unique set of test files.");
    }
    const runs = [];
    const publishSuccess = async (timings) => {
      signal.throwIfAborted();
      await rm(runDirectory, { recursive: true });
      runDirectory = undefined;
      signal.throwIfAborted();
      lock.release();
      lock = undefined;
      publishTestMetrics(runs, [], root, signal);
      if (timings) {
        try {
          writeJson(join(parallelCache, "results.json"), timings);
        } catch (error) {
          console.warn(`Could not update the Vitest timing cache: ${error.message}`);
        }
      }
    };
    const execute = async (name, selected) => {
      const result = await executeFiles(
        root,
        name,
        selected,
        runDirectory,
        signal,
        (args, directory, signal) => invokeVitest(root, args, directory, signal, lock),
      );
      runs.push({ files: selected, counts: result.counts });
      return result;
    };
    if (values["rerun-failed"]) {
      return await rerunFiles(
        await readFailedFiles(failedFileList, files),
        async (name, selected) => {
          const result = await execute(name, selected);
          if (result.exitCode === 0 && !signal.aborted) await publishSuccess();
          return result;
        },
        console.log,
        signal,
      );
    }
    await rm(failedFileList, { force: true });
    const groups = partitionFiles(await weighFiles(root, cacheRoot, files), count);
    const startedAt = performance.now();
    console.log(`Running ${files.length} Vitest files across ${groups.length} shards.`);
    const result = await runShards(groups, {
      execute,
      print: console.log,
      signal,
    });
    console.log(
      `Shard execution wall time: ${((performance.now() - startedAt) / 1000).toFixed(2)}s`,
    );
    if (result.failedFiles.length) writeJson(failedFileList, result.failedFiles);
    if (result.exitCode === 0 && !signal.aborted) {
      const timings = await collectTimings(runDirectory, groups.length);
      await publishSuccess(timings);
    }
    return result.exitCode;
  } finally {
    if (runDirectory && !values["rerun-failed"]) console.log(`Run logs: ${runDirectory}`);
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
        process.exitCode = 1;
      },
    )
    .finally(() => {
      if (signal.aborted) console.log(`INTERRUPTED: ${signal.reason}`);
      close();
    });
}
