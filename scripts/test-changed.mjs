import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { publishTestMetrics } from "./test-receipt.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const routeTree = "src/routeTree.gen.ts";
const typography = "src/typography-policy.test.ts";
const migrationTests = ["src/db/migrations.test.ts", "src/db/migrations.integration.test.ts"];
const sourceExtensions = /\.(?:[cm]?[jt]sx?|json|css)$/u;

function git(args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : null;
}

function requireGit(args) {
  const output = git(args);
  if (output === null) throw new Error(`Git could not complete ${args[0]}.`);
  return output;
}

function resolveBase(base) {
  if (base !== undefined) {
    const tree = git(["rev-parse", "--verify", "--end-of-options", `${base}^{tree}`]);
    if (tree === null) throw new Error("Could not resolve --base to a Git tree.");
    return { display: base, tree: tree.trim() };
  }
  for (const ref of [
    "release/notifications-22",
    "origin/release/notifications-22",
    "origin/HEAD",
    "origin/main",
  ]) {
    const commit = git(["merge-base", "HEAD", ref]);
    if (commit !== null) return { display: `merge base with ${ref}`, tree: commit.trim() };
  }
  throw new Error("No local base ref found. Pass --base with a Git commit or branch.");
}

export function combinePaths(diff, untracked) {
  return [...new Set(`${diff}\0${untracked}`.split("\0").filter(Boolean))].sort();
}

function repoPath(directory, path) {
  return relative(directory, path).split(sep).join("/");
}

export function selectTests(changes, discovered, present, safe) {
  const tests = new Map([[typography, "typography policy guard"]]);
  const migrationChanged = changes.some((path) => path.startsWith("drizzle/"));
  if (migrationChanged) {
    for (const path of migrationTests) tests.set(path, "migration guard for drizzle changes");
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
  return {
    tests,
    related,
    migrationChanged,
    scriptsChanged: changes.some((path) => path.startsWith("scripts/") || path === "package.json"),
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

function run(command, args, { cwd = root, env = process.env, stdio = "inherit" } = {}) {
  return new Promise((settle, reject) => {
    const child = spawn(command, args, { cwd, env, stdio });
    child.on("error", reject);
    child.on("close", (code) => settle(code ?? 1));
  });
}

function runVitest(args, options) {
  return run(process.execPath, [vitest, ...args], options);
}

async function checkRouteTree(rootDir, temp, env) {
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

async function selectedVitest(args, reportPath, env, allowEmpty = false) {
  const code = await runVitest(
    [
      ...args,
      "--reporter=json",
      `--outputFile=${reportPath}`,
      ...(allowEmpty ? ["--passWithNoTests"] : []),
    ],
    { env },
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
    if (allowEmpty && code === 0 && error.code === "ENOENT") {
      return { code, counts: { passed: 0, failed: 0, skipped: 0 }, files: [] };
    }
    throw new Error("Vitest exited without a readable test report.", { cause: error });
  }
}

function printTests(result, reason) {
  if (result.files.length === 0) console.log("No Vitest files matched the module graph.");
  for (const { path, failed } of result.files) {
    console.log(`  ${path} (${reason(path)}${failed ? ", FAILED" : ""})`);
  }
  const { passed, failed, skipped } = result.counts;
  console.log(`  ${passed} passed, ${failed} failed, ${skipped} skipped`);
}

async function main() {
  const { values } = parseArgs({
    options: { base: { type: "string" }, safe: { type: "boolean" } },
  });
  const base = resolveBase(values.base);
  const changes = combinePaths(
    requireGit(["diff", "--no-renames", "--name-only", "-z", base.tree, "--"]),
    requireGit(["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  console.log(`Changed paths from ${base.display} (${base.tree})`);
  for (const path of changes) console.log(`  ${path}`);

  if (
    await access("/tmp/hub-fullsuite.lock").then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  ) {
    throw new Error("The full-suite lock is held at /tmp/hub-fullsuite.lock.");
  }
  const temp = await mkdtemp(join(tmpdir(), "hub-changed-"));
  const env = { ...process.env, HUB_VITEST_CACHE_DIR: join(temp, "vite") };
  try {
    await checkRouteTree(root, temp, env);
    const checks = ["route tree"];
    const listing = join(temp, "all-tests.json");
    const discover = await runVitest(["list", "--filesOnly", `--json=${listing}`], { env });
    if (discover !== 0) throw new Error("Vitest file discovery failed.");
    const discovered = JSON.parse(await readFile(listing, "utf8")).map(({ file }) =>
      repoPath(root, file),
    );
    const present = new Set();
    for (const path of changes) {
      if (await exists(join(root, path))) present.add(path);
    }
    const plan = selectTests(changes, discovered, present, values.safe);
    if (plan.tests.size === discovered.length) {
      throw new Error(
        "The selected folders cover the full suite. Run npm run test:parallel in an exclusive window.",
      );
    }

    let code = 0;
    if (plan.migrationChanged) {
      console.log("Running npm run db:check for drizzle changes.");
      code |= await run("npm", ["run", "db:check"]);
      checks.push("npm run db:check");
    }
    if (plan.scriptsChanged) {
      console.log("Running npm run test:scripts for package or runner changes.");
      code |= await run("npm", ["run", "test:scripts"]);
      checks.push("npm run test:scripts");
    }
    const direct = await selectedVitest(
      ["run", ...[...plan.tests.keys()].map((path) => join(root, path))],
      join(temp, "direct.json"),
      env,
    );
    printTests(direct, (path) => plan.tests.get(path) ?? "Vitest path match");
    code |= direct.code;
    const reported = new Set(direct.files.map(({ path }) => path));
    const missing = [...plan.tests.keys()].filter((path) => !reported.has(path));
    if (missing.length)
      throw new Error(`Vitest did not report these selected files: ${missing.join(", ")}`);
    const runs = [direct];
    if (plan.related.length) {
      console.log("Selecting related tests via the Vitest module graph for these paths");
      for (const path of plan.related) console.log(`  ${path}`);
      const related = await selectedVitest(
        [
          "related",
          "--run",
          ...plan.related.map((path) => join(root, path)),
          ...[...plan.tests.keys()].map((path) => `--exclude=${path}`),
        ],
        join(temp, "related.json"),
        env,
        true,
      );
      printTests(related, () => "module graph");
      code |= related.code;
      runs.push(related);
    }
    if (code !== 0) return 1;
    await publishTestMetrics(
      runs.map(({ files, counts }) => ({ files: files.map(({ path }) => path), counts })),
      checks,
    );
    return 0;
  } finally {
    await rm(temp, { recursive: true });
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
