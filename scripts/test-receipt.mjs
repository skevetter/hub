import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, realpathSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  isEntrypoint,
  printRunContext,
  readRepository,
  repositoryFor,
  requireGit,
} from "./test-context.mjs";

const reportVariable = "HUB_TEST_RUN_REPORT";

function cleanHead(directory) {
  const repo = readRepository(directory);
  if (repo.dirty) throw new Error("Test receipts require a clean Git worktree.");
  return { ...repo, ...revision(directory, repo.head) };
}

function revision(directory, ref) {
  const head = requireGit(directory, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const tree = requireGit(directory, ["rev-parse", "--verify", `${head}^{tree}`]).trim();
  return { head, tree };
}

function execute(args, cwd, report, log, stdio) {
  const [command, ...rest] = args;
  return new Promise((settle, reject) => {
    const child = spawn(command, rest, {
      cwd,
      env: { ...process.env, [reportVariable]: report },
      stdio: [stdio, "pipe", "pipe"],
    });
    let logError;
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        try {
          if (!logError) writeFileSync(log.fd, chunk);
        } catch (error) {
          logError = error;
        }
        if (stdio === "inherit" && !output.write(chunk)) {
          stream.pause();
          output.once("drain", () => stream.resume());
        }
      });
    }
    child.on("error", (error) => {
      logError = error;
    });
    child.on("close", (code) => {
      if (logError) reject(logError);
      else settle(code ?? 1);
    });
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptHash(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function logPath(directory, hash) {
  return join(directory, "logs", `${hash}.log`);
}

async function checkReceipt(receipt, { head, tree }, directory, root) {
  if (receipt.version !== 4 || receipt.cleanTree !== true || !Array.isArray(receipt.commands)) {
    throw new Error("Unsupported or invalid test receipt. Record fresh evidence.");
  }
  const { sha256, ...payload } = receipt;
  if (receipt.head !== head || receipt.tree !== tree) {
    throw new Error("The test receipt does not match the requested commit and tree.");
  }
  if (receiptHash(payload) !== sha256) throw new Error("Test receipt integrity hash differs.");
  for (const entry of receipt.commands) {
    if (entry.head !== head || entry.tree !== tree)
      throw new Error("A receipt entry has a different commit or tree.");
    if (entry.root !== root || (entry.testedRoot !== null && entry.testedRoot !== root))
      throw new Error(`A receipt entry ran in a different worktree than ${root}.`);
    if (
      !/^[a-f0-9]{64}$/u.test(entry.logSha256 ?? "") ||
      (await fileHash(logPath(directory, entry.logSha256)).catch(() => null)) !== entry.logSha256
    ) {
      throw new Error("A test receipt log is missing or its log hash differs.");
    }
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function publishTestMetrics(results, checks = [], directory = process.cwd()) {
  const report = process.env[reportVariable];
  if (!report) return;
  const root = realpathSync(directory);
  const head = requireGit(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const selectedFiles = [...new Set(results.flatMap(({ files }) => files))].sort();
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const result of results) {
    for (const key of Object.keys(counts)) counts[key] += result.counts[key];
  }
  await writeFile(report, JSON.stringify({ root, head, selectedFiles, counts, checks }), {
    flag: "wx",
  });
}

function validateMetrics(metrics) {
  if (!metrics) return;
  const { root, head, selectedFiles, counts, checks } = metrics;
  const strings = (items) =>
    Array.isArray(items) && items.every((value) => typeof value === "string");
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  if (
    typeof root !== "string" ||
    typeof head !== "string" ||
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
  const { root, branch, head, tree } = cleanHead(directory);
  const checkUnchanged = () => {
    const current = cleanHead(directory);
    if (current.head !== head || current.branch !== branch)
      throw new Error("HEAD or branch changed while the command ran.");
  };
  const temp = await mkdtemp(join(tmpdir(), "hub-receipt-"));
  try {
    const report = join(temp, "metrics.json");
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const logFile = join(temp, "command.log");
    const log = await open(logFile, "wx", 0o600);
    let code;
    try {
      code = await execute(command, directory, report, log, stdio);
    } finally {
      await log.close();
    }
    const completedAt = new Date().toISOString();
    const durationMs = Math.round(performance.now() - started);
    checkUnchanged();
    const metrics = code === 0 ? await readJson(report) : null;
    validateMetrics(metrics);
    if (metrics && (metrics.root !== root || metrics.head !== head)) {
      throw new Error(
        `The command tested ${metrics.root} at ${metrics.head}, not ${root} at ${head}.`,
      );
    }
    const entry = {
      root,
      testedRoot: metrics?.root ?? null,
      branch,
      head,
      tree,
      command,
      exitCode: code,
      selectedFiles: [...(metrics?.selectedFiles ?? [])].sort(),
      counts: metrics?.counts ?? null,
      checks: metrics?.checks ?? [],
      durationMs,
      startedAt,
      completedAt,
      nodeVersion: process.version,
      vitestVersion:
        (await readJson(join(directory, "node_modules/vitest/package.json")))?.version ?? null,
      logSha256: await fileHash(logFile),
    };
    const receiptDir = join(directory, ".test-receipts");
    await mkdir(receiptDir, { recursive: true });
    const destination = join(receiptDir, `${head}.json`);
    const pending = join(receiptDir, `${head}.tmp-${process.pid}`);
    const lockPath = join(receiptDir, `${head}.lock`);
    const lock = await open(lockPath, "wx", 0o600);
    try {
      checkUnchanged();
      const existing = await readJson(destination);
      if (existing) await checkReceipt(existing, { head, tree }, receiptDir, root);
      const previous = existing?.commands ?? [];
      const commands = previous.filter(
        (item) => JSON.stringify(item.command) !== JSON.stringify(command),
      );
      if (code !== 0 && commands.length === previous.length) return { code, path: null };
      await mkdir(join(receiptDir, "logs"), { recursive: true, mode: 0o700 });
      await copyFile(logFile, logPath(receiptDir, entry.logSha256), constants.COPYFILE_EXCL).catch(
        async (error) => {
          if (
            error.code !== "EEXIST" ||
            (await fileHash(logPath(receiptDir, entry.logSha256))) !== entry.logSha256
          )
            throw error;
        },
      );
      commands.push(entry);
      const payload = { version: 4, head, tree, cleanTree: true, commands };
      const data = { ...payload, sha256: receiptHash(payload) };
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
  const commit = revision(directory, sha);
  const receiptDir = join(directory, ".test-receipts");
  const receipt = await readJson(join(receiptDir, `${commit.head}.json`));
  if (!receipt) throw new Error(`No test receipt exists for ${commit.head}.`);
  await checkReceipt(receipt, commit, receiptDir, realpathSync(directory));
  const failure = receipt.commands.find((entry) => (entry.exitCode ?? 0) !== 0);
  if (failure) {
    const command = failure.command.map((part) => JSON.stringify(part)).join(" ");
    throw new Error(`The latest run of ${command} failed with exit code ${failure.exitCode}.`);
  }
  return receipt;
}

async function main(args) {
  const delimiter = args.indexOf("--");
  const { values } = parseArgs({
    args: delimiter === -1 ? args : args.slice(0, delimiter),
    options: { root: { type: "string" }, verify: { type: "string" } },
  });
  const root = repositoryFor(import.meta.url, values.root);
  if (values.verify !== undefined) {
    if (delimiter !== -1) throw new Error("Use --verify <sha> or -- <command> [arguments].");
    printRunContext(root, `verify the test receipt for ${values.verify}`);
    const receipt = await verifyReceipt(root, values.verify);
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
    delimiter === -1
      ? [
          process.execPath,
          fileURLToPath(new URL("./test-changed.mjs", import.meta.url)),
          "--root",
          root,
        ]
      : args.slice(delimiter + 1);
  if (!command.length) throw new Error("Use --verify <sha> or -- <command> [arguments].");
  printRunContext(root, `record ${command.map((part) => JSON.stringify(part)).join(" ")}`);
  const result = await recordTestRun(root, command);
  if (result.path) console.log(`Wrote ${result.path}.`);
  return result.code;
}

if (isEntrypoint(import.meta.url)) {
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
