import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { generateRuntimeMap } from "./generate-test-runtime-files.mjs";
import { git, isEntrypoint, printRunContext, repositoryFor, requireGit } from "./test-context.mjs";
import { publishTestMetrics } from "./test-receipt.mjs";
import { takeFullSuiteLock, waitForTestGroup, watchTestSignals } from "./test-worker-group.mjs";
import runtimeFiles from "./test-runtime-files.json" with { type: "json" };

const routeTree = "src/routeTree.gen.ts";
const typography = "src/typography-policy.test.ts";
const migrationTests = ["src/db/migrations.test.ts", "src/db/migrations.integration.test.ts"];
const sourceExtensions = /\.(?:[cm]?[jt]sx?|json|css)$/u;
const fullSuiteInputs =
  /^(?:package(?:-lock)?\.json|(?:vite|vitest)(?:\.config|\.workspace)\.[cm]?[jt]s)$/u;

const releaseRef = /^(?:(?:refs\/heads|refs\/remotes\/[^/]+)\/)?release\/(.+)$/u;
const versionOrder = (a, b) => a.localeCompare(b, "en", { numeric: true });

function releaseRefs(gitCommand) {
  const current = gitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"])
    ?.trim()
    .match(releaseRef)?.[1];
  const family = (name) => name.split(/\d/u, 1)[0];
  const refs =
    gitCommand(["for-each-ref", "--format=%(refname)", "refs/heads/release", "refs/remotes"]) ?? "";
  return refs
    .trim()
    .split("\n")
    .map((ref) => ({ ref, version: ref.match(releaseRef)?.[1] }))
    .filter(
      ({ version }) =>
        version &&
        /\d/u.test(version) &&
        (!current || (family(version) === family(current) && versionOrder(version, current) < 0)),
    )
    .sort((a, b) => versionOrder(b.version, a.version) || a.ref.localeCompare(b.ref))
    .map(({ ref }) => ref);
}

export function resolveBase(base, gitCommand) {
  if (base !== undefined) {
    const tree = gitCommand(["rev-parse", "--verify", "--end-of-options", `${base}^{tree}`]);
    if (tree === null) throw new Error("Could not resolve --base to a Git tree.");
    return { display: base, tree: tree.trim(), kind: "tree" };
  }
  const mergeBase = (ref) => gitCommand(["merge-base", "HEAD", ref])?.trim();
  const fromRef = (ref, tree, reason) => ({
    display: `merge base with ${ref.replace(/^refs\/(?:heads|remotes)\//u, "")}`,
    tree,
    kind: "commit",
    reason,
  });
  const upstream = gitCommand([
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ])?.trim();
  // Fewest commits to HEAD wins. Ties keep this order: releases by version, upstream, origin/main.
  const candidates = [
    ...releaseRefs(gitCommand).map((ref) => ({ ref, reason: "closest release branch" })),
    ...(upstream ? [{ ref: upstream, reason: "configured upstream" }] : []),
    { ref: "origin/main", reason: "origin/main" },
  ];
  const distances = new Map();
  let closest;
  for (const { ref, reason } of candidates) {
    const commit = mergeBase(ref);
    if (!commit) continue;
    if (!distances.has(commit)) {
      const count = gitCommand(["rev-list", "--count", `${commit}..HEAD`])?.trim();
      if (count === undefined) continue;
      distances.set(commit, Number(count));
    }
    const distance = distances.get(commit);
    if (!closest || distance < closest.distance) closest = { ref, commit, distance, reason };
  }
  if (closest) {
    const { ref, commit, distance, reason } = closest;
    return fromRef(ref, commit, `${reason}, ${distance} commits to HEAD`);
  }
  throw new Error("No local merge base found. Pass --base with a Git commit or branch.");
}

export function combinePaths(diff, untracked) {
  return [...new Set(`${diff}\0${untracked}`.split("\0").filter(Boolean))].sort();
}

function repoPath(directory, path) {
  return relative(directory, path).split(sep).join("/");
}

export function selectTests(
  changes,
  discovered,
  present,
  safe,
  { setupFiles = [], graphFiles = [], fixtures = runtimeFiles } = {},
) {
  const migrationChanged = changes.some((path) => path.startsWith("drizzle/"));
  const scriptsChanged = changes.some(
    (path) => path.startsWith("scripts/") || path === "package.json",
  );
  const fullSuiteReason = changes.find(
    (path) => fullSuiteInputs.test(path) || setupFiles.includes(path),
  );
  if (fullSuiteReason) {
    return {
      tests: new Map(discovered.map((path) => [path, `whole suite for ${fullSuiteReason}`])),
      related: [],
      migrationChanged,
      scriptsChanged,
      fullSuiteReason,
    };
  }
  const tests = new Map([[typography, "typography policy guard"]]);
  if (migrationChanged) {
    for (const path of migrationTests) tests.set(path, "migration guard for drizzle changes");
  }

  const available = new Set(discovered);
  for (const [input, readers] of Object.entries(fixtures)) {
    const changed = changes.find((path) =>
      input.endsWith("/") ? path.startsWith(input) : path === input,
    );
    if (!changed) continue;
    for (const reader of readers) {
      if (available.has(reader) && !tests.has(reader)) tests.set(reader, `runtime file ${changed}`);
    }
  }

  const changedPaths = new Set(changes);
  const changedTests = new Set(discovered.filter((path) => changedPaths.has(path)));
  for (const path of changedTests) {
    if (!tests.has(path)) tests.set(path, "changed test file");
  }

  const sources = changes.filter(
    (path) =>
      sourceExtensions.test(path) &&
      !changedTests.has(path) &&
      !path.startsWith("docs/") &&
      !path.startsWith("drizzle/"),
  );
  const related = sources.filter((path) => present.has(path));
  const fallback = (safe ? changes : sources.filter((path) => !present.has(path))).filter((path) =>
    path.startsWith("src/"),
  );
  for (const source of fallback) {
    const folder = posix.dirname(source);
    for (const path of discovered) {
      if (path.startsWith(`${folder}/`) && !tests.has(path)) {
        tests.set(path, safe ? `safe mode for ${folder}` : `deleted source in ${folder}`);
      }
    }
  }
  for (const path of graphFiles) {
    if (available.has(path) && !tests.has(path)) tests.set(path, "module graph");
  }
  return {
    tests,
    related,
    migrationChanged,
    scriptsChanged,
    fullSuiteReason:
      discovered.length > 0 && discovered.every((path) => tests.has(path))
        ? "selection covers every Vitest file"
        : undefined,
  };
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function supervise(signal, getLock) {
  return {
    async run(command, args, { cwd, env = process.env, graceMs = 3000 }) {
      signal.throwIfAborted();
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
      });
      const { exitCode, error } = await waitForTestGroup(child, {
        signal,
        lock: getLock(),
        graceMs,
      });
      if (error) throw error;
      signal.throwIfAborted();
      return exitCode;
    },
  };
}

function runVitest(supervisor, root, args, options) {
  return supervisor.run(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), ...args], {
    cwd: root,
    ...options,
  });
}

async function checkRouteTree(supervisor, rootDir, temp, env) {
  const snapshot = join(await realpath(temp), "routes");
  const source = join(snapshot, "src");
  await mkdir(source, { recursive: true });
  const current = await readFile(join(rootDir, routeTree), "utf8");
  await Promise.all([
    cp(join(rootDir, "src/routes"), join(source, "routes"), { recursive: true, dereference: true }),
    cp(join(rootDir, routeTree), join(snapshot, routeTree)),
    cp(join(rootDir, "src/router.tsx"), join(source, "router.tsx")),
    cp(join(rootDir, "src/start.ts"), join(source, "start.ts")),
    cp(join(rootDir, "src/start-server.ts"), join(source, "start-server.ts")),
    cp(join(rootDir, typography), join(snapshot, typography)),
    symlink(join(rootDir, "node_modules"), join(snapshot, "node_modules"), "junction"),
  ]);
  const code = await runVitest(
    supervisor,
    rootDir,
    [
      "list",
      "--root",
      snapshot,
      "--config",
      join(rootDir, "vitest.config.ts"),
      "--filesOnly",
      `--json=${join(temp, "route-tests.json")}`,
    ],
    { cwd: snapshot, env },
  );
  if (code !== 0) throw new Error("Could not regenerate the route tree in a temporary checkout.");
  const generated = await readFile(join(snapshot, routeTree), "utf8");
  if (current !== generated)
    throw new Error(`${routeTree} differs from the generated routes. Run npm run build.`);
  console.log(`Route tree guard passed for ${routeTree}.`);
}

async function resolveTestPlan(root, changes, present, safe, temp) {
  const require = createRequire(join(root, "package.json"));
  const { createVitest } = await import(pathToFileURL(require.resolve("vitest/node")).href);
  const mapPath = join(root, "scripts/test-runtime-files.json");
  const fixtures = (await exists(mapPath))
    ? JSON.parse(await readFile(mapPath, "utf8"))
    : generateRuntimeMap(root);
  const ctx = await createVitest(
    "test",
    { root, run: true, watch: false },
    { cacheDir: join(temp, "graph") },
  );
  try {
    const specs = await ctx.globTestSpecifications();
    const discovered = [...new Set(specs.map(({ moduleId }) => repoPath(root, moduleId)))];
    const setupFiles = ctx.projects.flatMap(({ config }) =>
      [...config.setupFiles, ...config.globalSetup].map((file) => repoPath(root, file)),
    );
    const plan = selectTests(changes, discovered, present, safe, { setupFiles, fixtures });
    if (plan.fullSuiteReason || !plan.related.length) return plan;
    // Use the same graph query as Vitest related, then run only the resolved files.
    ctx.config.related = plan.related.map((path) => join(root, path));
    const graph = await ctx.getRelevantTestSpecifications();
    return selectTests(changes, discovered, present, safe, {
      setupFiles,
      fixtures,
      graphFiles: graph.map(({ moduleId }) => repoPath(root, moduleId)),
    });
  } finally {
    await ctx.close();
  }
}

async function selectedVitest(supervisor, root, args, reportPath, env) {
  const code = await runVitest(
    supervisor,
    root,
    [...args, "--reporter=json", `--outputFile=${reportPath}`],
    {
      env,
    },
  );
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return {
      code,
      counts: {
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        skipped: report.numTotalTests - report.numPassedTests - report.numFailedTests,
      },
      files: report.testResults.map((result) => ({
        path: repoPath(root, result.name),
        failed: result.status === "failed",
      })),
    };
  } catch (error) {
    throw new Error("Vitest exited without a readable test report.", { cause: error });
  }
}

function printTests(result, reason) {
  for (const { path, failed } of result.files) {
    console.log(`  ${path} (${reason(path)}${failed ? ", FAILED" : ""})`);
  }
  const { passed, failed, skipped } = result.counts;
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
}

async function main(signal) {
  const { values } = parseArgs({
    options: { base: { type: "string" }, safe: { type: "boolean" }, root: { type: "string" } },
  });
  const root = repositoryFor(import.meta.url, values.root);
  printRunContext(root, `run Vitest files affected by changes${values.safe ? " with --safe" : ""}`);
  const base = resolveBase(values.base, (args) => git(root, args));
  const changes = combinePaths(
    requireGit(root, ["diff", "--no-renames", "--name-only", "-z", base.tree, "--"]),
    requireGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  console.log(`Base: ${base.display} (${base.reason ?? "explicit --base"})`);
  console.log(`Changed paths from ${base.display} (Git ${base.kind} ${base.tree})`);
  for (const path of changes) console.log(`  ${path}`);

  let lock;
  const supervisor = supervise(signal, () => lock);
  const checks = ["route tree"];
  let completed;
  let temp;
  try {
    lock = await takeFullSuiteLock();
    temp = await mkdtemp(join(tmpdir(), "hub-changed-"));
    const env = { ...process.env, HUB_VITEST_CACHE_DIR: join(temp, "vite") };
    await checkRouteTree(supervisor, root, temp, env);
    const present = new Set();
    for (const path of changes) {
      if (await exists(join(root, path))) present.add(path);
    }
    const plan = await resolveTestPlan(root, changes, present, values.safe, temp);
    signal.throwIfAborted();
    if (plan.fullSuiteReason) {
      console.log(
        `FULL VITEST SUITE selected for ${plan.fullSuiteReason}. Handing off to the parallel runner with the full-suite lock.`,
      );
    }

    let code = 0;
    if (plan.migrationChanged) {
      console.log("Running npm run db:check for drizzle changes.");
      code |= await supervisor.run("npm", ["run", "db:check"], { cwd: root });
      checks.push("npm run db:check");
    }
    if (plan.scriptsChanged) {
      console.log("Running npm run test:scripts for package or runner changes.");
      code |= await supervisor.run("npm", ["run", "test:scripts"], { cwd: root });
      checks.push("npm run test:scripts");
    }
    if (code !== 0) return 1;
    if (plan.fullSuiteReason) {
      const metrics = join(temp, "full-metrics.json");
      const runner = fileURLToPath(new URL("./test-parallel.mjs", import.meta.url));
      lock.release();
      lock = undefined;
      const result = await supervisor.run(process.execPath, [runner, "--root", root], {
        cwd: root,
        env: { ...env, HUB_TEST_RUN_REPORT: metrics },
        // Let the parallel runner finish stopping its detached shards.
        graceMs: 12_000,
      });
      if (result !== 0) return result;
      const { selectedFiles, counts } = JSON.parse(await readFile(metrics, "utf8"));
      completed = { files: selectedFiles, counts };
    } else {
      const direct = await selectedVitest(
        supervisor,
        root,
        ["run", ...[...plan.tests.keys()].map((path) => join(root, path))],
        join(temp, "direct.json"),
        env,
      );
      printTests(direct, (path) => plan.tests.get(path) ?? "Vitest path match");
      const files = direct.files.map(({ path }) => path);
      const reported = new Set(files);
      const missing = [...plan.tests.keys()].filter((path) => !reported.has(path));
      if (missing.length)
        throw new Error(`Vitest did not report these selected files: ${missing.join(", ")}`);
      if (direct.code !== 0) return direct.code;
      completed = { files, counts: direct.counts };
    }
  } finally {
    try {
      if (temp) await rm(temp, { recursive: true });
    } finally {
      lock?.release();
    }
  }
  publishTestMetrics([completed], checks, root, signal);
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  const { signal, close } = watchTestSignals();
  main(signal)
    .then(
      (code) => {
        process.exitCode = signal.aborted ? 1 : code;
      },
      (error) => {
        if (error !== signal.reason) console.error(error.message);
        process.exitCode = 1;
      },
    )
    .finally(() => {
      if (signal.aborted) console.log(`INTERRUPTED: ${signal.reason}`);
      close();
    });
}
