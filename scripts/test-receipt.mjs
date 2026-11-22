import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const reportVariable = "HUB_TEST_RUN_REPORT";

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git could not complete ${args[0]}.`);
  return result.stdout;
}

function cleanHead(directory) {
  if (git(directory, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])) {
    throw new Error("Test receipts require a clean Git worktree.");
  }
  return git(directory, ["rev-parse", "--verify", "HEAD"]).trim();
}

function execute(args, cwd, report, stdio) {
  const [command, ...rest] = args;
  return new Promise((settle, reject) => {
    const child = spawn(command, rest, {
      cwd,
      env: { ...process.env, [reportVariable]: report },
      stdio,
    });
    child.on("error", reject);
    child.on("close", (code) => settle(code ?? 1));
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function publishTestMetrics(results, checks = []) {
  const report = process.env[reportVariable];
  if (!report) return;
  const selectedFiles = [...new Set(results.flatMap(({ files }) => files))].sort();
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const result of results) {
    for (const key of Object.keys(counts)) counts[key] += result.counts[key];
  }
  await writeFile(report, JSON.stringify({ selectedFiles, counts, checks }), { flag: "wx" });
}

function validateMetrics(metrics) {
  if (!metrics) return;
  const { selectedFiles, counts, checks } = metrics;
  const strings = (items) =>
    Array.isArray(items) && items.every((value) => typeof value === "string");
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  if (
    !strings(selectedFiles) ||
    !strings(checks) ||
    !counts ||
    !count(counts.passed) ||
    !count(counts.skipped) ||
    counts.failed !== 0
  ) {
    throw new Error("The command produced invalid or failing test metrics.");
  }
}

export async function recordTestRun(directory, command, { stdio = "inherit" } = {}) {
  if (!command.length) throw new Error("A test command is required.");
  const head = cleanHead(directory);
  const temp = await mkdtemp(join(tmpdir(), "hub-receipt-"));
  try {
    const report = join(temp, "metrics.json");
    const started = performance.now();
    const code = await execute(command, directory, report, stdio);
    const durationMs = Math.round(performance.now() - started);
    if (code !== 0) return { code, path: null };
    if (cleanHead(directory) !== head) throw new Error("HEAD changed while the command ran.");
    const metrics = await readJson(report);
    validateMetrics(metrics);
    const entry = {
      command,
      selectedFiles: metrics?.selectedFiles ?? [],
      counts: metrics?.counts ?? null,
      checks: metrics?.checks ?? [],
      durationMs,
      completedAt: new Date().toISOString(),
    };
    const receiptDir = join(directory, ".test-receipts");
    await mkdir(receiptDir, { recursive: true });
    const destination = join(receiptDir, `${head}.json`);
    const pending = join(receiptDir, `${head}.tmp-${process.pid}`);
    const lockPath = join(receiptDir, `${head}.lock`);
    const lock = await open(lockPath, "wx", 0o600);
    try {
      if (cleanHead(directory) !== head)
        throw new Error("HEAD changed before the receipt was written.");
      const existing = await readJson(destination);
      if (existing && (existing.head !== head || existing.cleanTree !== true)) {
        throw new Error("The existing test receipt has invalid commit metadata.");
      }
      const commands = (existing?.commands ?? []).filter(
        (item) => JSON.stringify(item.command) !== JSON.stringify(command),
      );
      commands.push(entry);
      const data = { version: 1, head, cleanTree: true, commands };
      await writeFile(pending, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(pending, destination);
    } finally {
      try {
        await rm(pending, { force: true });
      } finally {
        await lock.close();
        await rm(lockPath);
      }
    }
    return { code, path: destination };
  } finally {
    await rm(temp, { recursive: true });
  }
}

export async function verifyReceipt(directory, sha) {
  if (!/^[a-f0-9]{7,64}$/iu.test(sha ?? "")) throw new Error("--verify requires a Git commit SHA.");
  const head = git(directory, ["rev-parse", "--verify", `${sha}^{commit}`]).trim();
  const receipt = await readJson(join(directory, ".test-receipts", `${head}.json`));
  if (!receipt) throw new Error(`No test receipt exists for ${head}.`);
  if (receipt.head !== head || receipt.cleanTree !== true) {
    throw new Error("The test receipt does not match the requested commit.");
  }
  return receipt;
}

async function main(args) {
  if (args[0] === "--verify" && args.length === 2) {
    const receipt = await verifyReceipt(root, args[1]);
    console.log(`Green test evidence for ${receipt.head} from a clean tree`);
    for (const entry of receipt.commands) {
      const time = (entry.durationMs / 1000).toFixed(2);
      console.log(`  ${entry.command.map((part) => JSON.stringify(part)).join(" ")} in ${time}s`);
      if (entry.counts) {
        const { passed, failed, skipped } = entry.counts;
        console.log(`    ${passed} passed, ${failed} failed, ${skipped} skipped`);
      }
      for (const file of entry.selectedFiles) console.log(`    ${file}`);
      for (const check of entry.checks) console.log(`    ${check}`);
    }
    return 0;
  }
  const command =
    args.length === 0 ? ["npm", "run", "test:changed"] : args[0] === "--" ? args.slice(1) : [];
  if (!command.length) throw new Error("Use --verify <sha> or -- <command> [arguments].");
  const result = await recordTestRun(root, command);
  if (result.path) console.log(`Wrote ${result.path}.`);
  return result.code;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
