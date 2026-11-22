import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const cacheRoot = join(root, "node_modules/.vite/vitest");
const parallelCache = join(cacheRoot, "test-parallel");
const failedFileList = join(parallelCache, "failed.json");
const daemonSuite = join("src", "daemons", "daemons.test.ts");
const lockPath =
  process.platform === "win32" ? join(tmpdir(), "hub-fullsuite.lock") : "/tmp/hub-fullsuite.lock";

export function partitionFiles(files, count) {
  const isolateDaemon = count > 1 && files.some((file) => file.path === daemonSuite);
  const firstShard = isolateDaemon ? [[daemonSuite]] : [];
  const sharedFiles = isolateDaemon ? files.filter((file) => file.path !== daemonSuite) : files;
  const shardCount = Math.min(count - firstShard.length, sharedFiles.length);
  const shards = Array.from({ length: shardCount }, () => ({
    files: [],
    weight: 0,
  }));
  const sorted = [...sharedFiles].sort(
    (a, b) => b.weight - a.weight || a.path.localeCompare(b.path),
  );
  for (const file of sorted) {
    const lightest = shards.reduce((first, next) => (next.weight < first.weight ? next : first));
    lightest.files.push(file.path);
    lightest.weight += file.weight;
  }
  return [...firstShard, ...shards.map((shard) => shard.files)];
}

function printRun(print, name, files, result) {
  const { passed, failed, skipped } = result.counts;
  const seconds = (result.durationMs / 1000).toFixed(2);
  print(
    `${name}: ${result.exitCode === 0 ? "PASS" : "FAIL"} in ${seconds}s, ${files.length} files, ${passed} passed, ${failed} failed, ${skipped} skipped`,
  );
  for (const file of result.failedFiles) print(`  ${name}: ${file}`);
  if (result.diagnostic) print(`  ${name}: ${result.diagnostic}`);
}

export async function runShards(groups, { execute, print }) {
  const outcomes = await Promise.allSettled(
    groups.map(async (files, index) => {
      const name = `Shard ${index + 1}`;
      const result = await execute(name, files);
      printRun(print, name, files, result);
      return result;
    }),
  );
  const total = { files: groups.flat().length, passed: 0, failed: 0, skipped: 0 };
  const failedFiles = [];
  let exitCode = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      exitCode = 1;
      print(`Shard ${index + 1}: FAIL. Runner error (${outcome.reason?.code ?? "unknown"}).`);
      continue;
    }
    const result = outcome.value;
    if (result.exitCode !== 0) exitCode = 1;
    failedFiles.push(...result.failedFiles);
    for (const key of ["passed", "failed", "skipped"]) total[key] += result.counts[key];
  }
  print(
    `Total: ${total.files} files, ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped`,
  );

  if (failedFiles.length) {
    print("Run npm run test:parallel -- --rerun-failed to recheck failed files serially.");
  }
  return { exitCode, failedFiles };
}

export async function rerunFiles(files, execute, print) {
  const result = await execute("Serial rerun", files);
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
          return { cache, modifiedAt: info.mtimeMs };
        } catch (error) {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
          throw error;
        }
      }),
  );
  return caches
    .filter(Boolean)
    .sort((a, b) => a.modifiedAt - b.modifiedAt)
    .map(({ cache }) => cache)
    .filter((cache) => Array.isArray(cache?.results));
}

async function weighFiles(paths) {
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
  }));
}

async function invokeVitest(args, directory, signal) {
  await mkdir(directory);
  const log = await open(join(directory, "vitest.log"), "w", 0o600);
  const env = {
    ...process.env,
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
  try {
    signal.throwIfAborted();
    const child = spawn(process.execPath, [vitest, ...args], {
      cwd: root,
      env,
      stdio: ["ignore", log.fd, log.fd],
    });
    const interrupt = () => child.kill("SIGINT");
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      return await new Promise((settle) => {
        let error;
        child.on("error", (cause) => {
          error = cause.code ?? "spawn error";
        });
        child.on("close", (exitCode, childSignal) =>
          settle({
            exitCode: exitCode ?? 1,
            processError: error ?? childSignal,
          }),
        );
      });
    } finally {
      signal.removeEventListener("abort", interrupt);
    }
  } finally {
    await log.close();
  }
}

async function executeFiles(name, files, runDirectory, signal) {
  const directory = join(runDirectory, name.toLowerCase().replaceAll(" ", "-"));
  const reportPath = join(directory, "results.json");
  const startedAt = performance.now();
  const run = await invokeVitest(
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
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return {
      exitCode: 1,
      durationMs,
      failedFiles: [],
      counts: { passed: 0, failed: 0, skipped: 0 },
      diagnostic: `Vitest exited without a readable JSON report (${run.processError ?? run.exitCode}). See ${log}`,
    };
  }
  const reported = new Set(report.testResults.map(({ name }) => relative(root, name)));
  const expected = new Set(files);
  const missing = files.filter((file) => !reported.has(file));
  const extra = [...reported].filter((file) => !expected.has(file));
  const failedFiles = report.testResults
    .filter(({ status }) => status === "failed")
    .map(({ name }) => relative(root, name))
    .filter((file) => expected.has(file));
  const exitCode =
    run.exitCode || Number(!report.success || missing.length > 0 || extra.length > 0);
  const diagnostics = [];
  if (missing.length) diagnostics.push(`Files missing from report: ${missing.join(", ")}`);
  if (extra.length) diagnostics.push(`Unexpected files in report: ${extra.join(", ")}`);
  if (exitCode) diagnostics.push(`See ${log} and ${reportPath}`);
  return {
    exitCode,
    durationMs,
    failedFiles,
    counts: {
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numTotalTests - report.numPassedTests - report.numFailedTests,
    },
    diagnostic: diagnostics.join("\n  "),
  };
}

async function updateTimingCache(runDirectory, count) {
  const caches = (
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        readCachedResults(join(runDirectory, `shard-${index + 1}`, "vite/vitest")),
      ),
    )
  ).flat();
  if (caches.length === 0) return;
  await writeJson(join(parallelCache, "results.json"), {
    version: caches[0].version,
    results: caches.flatMap((cache) => cache.results),
  });
}

async function writeJson(target, data) {
  await mkdir(dirname(target), { recursive: true });
  const pending = `${target}.${process.pid}`;
  await writeFile(pending, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  await rename(pending, target);
}

async function readFailedFiles(files) {
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

async function main() {
  const { values } = parseArgs({ options: { "rerun-failed": { type: "boolean" } } });
  const requested = process.env.TEST_SHARDS ?? "4";
  const count = Number(requested);
  if (!/^\d+$/u.test(requested) || !Number.isSafeInteger(count) || count < 1) {
    throw new Error("TEST_SHARDS must be a positive integer.");
  }
  const busy = `The full-suite lock is held at ${lockPath}.`;
  let lock;
  if (values["rerun-failed"]) {
    await access(lockPath).then(
      () => {
        throw new Error(busy);
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  } else {
    lock = await open(lockPath, "wx", 0o600).catch((error) => {
      if (error.code === "EEXIST") throw new Error(busy);
      throw error;
    });
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let runDirectory;
  let exitCode = 1;
  try {
    await lock?.writeFile(`${process.pid}\n`);
    runDirectory = await mkdtemp(join(tmpdir(), "hub-tests-"));
    const discovery = join(runDirectory, "discovery");
    const listing = join(discovery, "files.json");
    const found = await invokeVitest(
      ["list", "--filesOnly", `--json=${listing}`],
      discovery,
      controller.signal,
    );
    if (found.exitCode)
      throw new Error(`Vitest file discovery failed. See ${join(discovery, "vitest.log")}`);
    const files = JSON.parse(await readFile(listing, "utf8")).map(({ file }) =>
      relative(root, file),
    );
    if (files.length === 0 || new Set(files).size !== files.length) {
      throw new Error("Vitest did not discover a unique set of test files.");
    }
    const execute = (name, selected) =>
      executeFiles(name, selected, runDirectory, controller.signal);
    if (values["rerun-failed"]) {
      exitCode = await rerunFiles(await readFailedFiles(files), execute, console.log);
      return exitCode;
    }
    await rm(failedFileList, { force: true });
    const groups = partitionFiles(await weighFiles(files), count);
    const startedAt = performance.now();
    console.log(`Running ${files.length} Vitest files across ${groups.length} shards.`);
    const result = await runShards(groups, { execute, print: console.log });
    exitCode = controller.signal.aborted ? 1 : result.exitCode;
    console.log(
      `Shard execution wall time: ${((performance.now() - startedAt) / 1000).toFixed(2)}s`,
    );
    if (result.failedFiles.length) await writeJson(failedFileList, result.failedFiles);
    if (exitCode === 0) await updateTimingCache(runDirectory, groups.length);
    else console.log(`Run logs: ${runDirectory}`);
    return exitCode;
  } finally {
    try {
      if (exitCode === 0 && runDirectory) await rm(runDirectory, { recursive: true });
    } finally {
      if (lock) {
        await lock.close();
        await rm(lockPath);
      }
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
