import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { recordTestRun, verifyReceipt } from "./test-receipt.mjs";

async function gitFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "hub-receipt-test-"));
  t.after(() => rm(directory, { recursive: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        directory,
        "-c",
        "user.name=Receipt Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(directory, "no-hooks")}`,
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  await writeFile(join(directory, ".gitignore"), ".test-receipts/\n");
  git("add", ".gitignore");
  git("commit", "--quiet", "-m", "Initialize fixture");
  return { directory, git, head: git("rev-parse", "HEAD") };
}

test("records command, selected files and counts on a clean commit", async (t) => {
  const { directory, head } = await gitFixture(t);
  const command = [
    process.execPath,
    "--input-type=module",
    "-e",
    `import { publishTestMetrics } from ${JSON.stringify(new URL("./test-receipt.mjs", import.meta.url).href)};
     await publishTestMetrics([
       { files: ["a.test.ts"], counts: { passed: 1, failed: 0, skipped: 1 } },
       { files: ["a.test.ts", "b.test.ts"], counts: { passed: 1, failed: 0, skipped: 0 } },
     ], ["route tree"]);`,
  ];
  const first = await recordTestRun(directory, command, { stdio: "ignore" });
  assert.equal(first.code, 0);
  assert.equal(first.path, join(directory, ".test-receipts", `${head}.json`));
  await recordTestRun(directory, command, { stdio: "ignore" });
  await recordTestRun(directory, [process.execPath, "-e", ""], { stdio: "ignore" });

  const saved = await verifyReceipt(directory, head.slice(0, 12));
  assert.deepEqual(JSON.parse(await readFile(first.path, "utf8")), saved);
  assert.equal(saved.head, head);
  assert.equal(saved.commands[0].head, head);
  assert.equal(saved.commands[0].root, await realpath(directory));
  assert.equal(saved.commands[0].testedRoot, await realpath(directory));
  assert.equal(saved.commands[0].branch, gitBranch(directory));
  assert.equal(saved.cleanTree, true);
  assert.equal(saved.commands.length, 2);
  assert.deepEqual(saved.commands[0].command, command);
  assert.deepEqual(saved.commands[0].selectedFiles, ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(saved.commands[0].counts, { passed: 2, failed: 0, skipped: 1 });
  assert.deepEqual(saved.commands[0].checks, ["route tree"]);
  assert.ok(saved.commands[0].durationMs > 0);
});

test("dirty trees and commands that dirty the tree cannot write an evidence file", async (t) => {
  const { directory, head } = await gitFixture(t);
  await writeFile(join(directory, "dirty"), "untracked");
  await assert.rejects(
    recordTestRun(directory, [process.execPath, "-e", ""], { stdio: "ignore" }),
    /require a clean Git worktree/u,
  );
  await rm(join(directory, "dirty"));
  await assert.rejects(
    recordTestRun(
      directory,
      [process.execPath, "-e", "require('node:fs').writeFileSync('dirty', 'after command')"],
      { stdio: "ignore" },
    ),
    /require a clean Git worktree/u,
  );
  await assert.rejects(verifyReceipt(directory, head), /No test receipt exists/u);
});

test("a failed command does not write green evidence", async (t) => {
  const { directory, head } = await gitFixture(t);
  assert.deepEqual(
    await recordTestRun(directory, [process.execPath, "-e", "process.exitCode=7"], {
      stdio: "ignore",
    }),
    { code: 7, path: null },
  );
  await assert.rejects(verifyReceipt(directory, head), /No test receipt exists/u);
  await assert.rejects(verifyReceipt(directory, "../../etc/passwd"), /requires a Git commit SHA/u);
});

test("a failed repeat replaces the green result for the same command and commit", async (t) => {
  const { directory, head } = await gitFixture(t);
  const runner = fileURLToPath(new URL("./test-receipt.mjs", import.meta.url));
  const receiptDir = join(directory, ".test-receipts");
  const resultFile = join(receiptDir, "result");
  const command = [
    process.execPath,
    "-e",
    "process.exit(Number(require('node:fs').readFileSync(process.argv[1], 'utf8')))",
    resultFile,
  ];
  const run = (...args) =>
    spawnSync(process.execPath, [runner, "--root", directory, ...args], { encoding: "utf8" });
  await mkdir(receiptDir);
  await writeFile(resultFile, "0");
  assert.equal(run("--", ...command).status, 0);
  assert.equal(run("--verify", head).status, 0);

  await writeFile(resultFile, "7");
  assert.equal(run("--", ...command).status, 7);
  const failed = run("--verify", head);
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stdout, /Green test evidence/u);
  assert.match(failed.stderr, /exit code 7/u);
  const receipt = JSON.parse(await readFile(join(receiptDir, `${head}.json`), "utf8"));
  assert.equal(receipt.commands.length, 1);
  assert.equal(receipt.commands[0].exitCode, 7);

  await writeFile(resultFile, "0");
  assert.equal(run("--", ...command).status, 0);
  assert.equal(run("--verify", head).status, 0);
});

test("a successful process cannot record a report containing failed tests", async (t) => {
  const { directory, head } = await gitFixture(t);
  const command = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.env.HUB_TEST_RUN_REPORT, JSON.stringify({ selectedFiles:['a.test.ts'], counts:{passed:2, failed:1, skipped:0}, checks:[] }))",
  ];
  await assert.rejects(
    recordTestRun(directory, command, { stdio: "ignore" }),
    /failing test metrics/u,
  );
  await assert.rejects(verifyReceipt(directory, head), /No test receipt exists/u);
});

test("invalid metrics replace an earlier pass for the same command and commit", async (t) => {
  const { directory, head } = await gitFixture(t);
  const runner = fileURLToPath(new URL("./test-receipt.mjs", import.meta.url));
  const receiptDir = join(directory, ".test-receipts");
  const input = join(receiptDir, "metrics.json");
  const command = [
    process.execPath,
    "-e",
    `const fs = require("node:fs");
     fs.copyFileSync(process.argv[1], process.env.HUB_TEST_RUN_REPORT);`,
    input,
  ];
  const run = (...args) =>
    spawnSync(process.execPath, [runner, "--root", directory, ...args], { encoding: "utf8" });
  const passing = {
    root: await realpath(directory),
    head,
    selectedFiles: ["a.test.ts"],
    counts: { passed: 1, failed: 0, skipped: 0 },
    checks: [],
  };
  await mkdir(receiptDir);
  for (const invalid of [{ ...passing, counts: { ...passing.counts, failed: 1 } }, null]) {
    await writeFile(input, JSON.stringify(passing));
    assert.equal(run("--", ...command).status, 0);
    assert.equal(run("--verify", head).status, 0);

    await writeFile(input, JSON.stringify(invalid));
    const rejected = run("--", ...command);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /invalid or failing test metrics/u);
    const verified = run("--verify", head);
    assert.equal(verified.status, 1);
    assert.doesNotMatch(verified.stdout, /Green test evidence/u);
    assert.match(verified.stderr, /exit code 1/u);
    const receipt = JSON.parse(await readFile(join(receiptDir, `${head}.json`), "utf8"));
    assert.equal(receipt.commands.length, 1);
    assert.equal(receipt.commands[0].exitCode, 1);
  }
});

test("rejects edited commands, copied commits, and modified log files", async (t) => {
  const { directory, head, git } = await gitFixture(t);
  const { path } = await recordTestRun(
    directory,
    [process.execPath, "-e", "console.log('output')"],
    {
      stdio: "ignore",
    },
  );
  const original = JSON.parse(await readFile(path, "utf8"));
  const entry = original.commands[0];
  const forged = structuredClone(original);
  forged.commands.push({
    ...entry,
    command: ["npm", "run", "test:parallel"],
    counts: { passed: 4470, failed: 0, skipped: 22 },
  });
  await writeFile(path, JSON.stringify(forged));
  await assert.rejects(verifyReceipt(directory, head), /integrity hash/u);
  await writeFile(path, JSON.stringify(original));
  assert.equal(original.tree, git("rev-parse", "HEAD^{tree}"));
  assert.equal(entry.tree, original.tree);
  assert.equal(entry.head, head);
  assert.ok(entry.startedAt <= entry.completedAt);
  assert.equal(entry.nodeVersion, process.version);
  assert.equal(entry.vitestVersion, null);

  git("commit", "--allow-empty", "--quiet", "-m", "Same tree");
  const other = git("rev-parse", "HEAD");
  await writeFile(
    join(directory, ".test-receipts", `${other}.json`),
    JSON.stringify({ ...original, head: other }),
  );
  await assert.rejects(verifyReceipt(directory, other), /commit|integrity/u);

  await writeFile(join(directory, ".test-receipts", "logs", `${entry.logSha256}.log`), "edited");
  await assert.rejects(verifyReceipt(directory, head), /log hash/u);
});

function gitBranch(directory) {
  return execFileSync("git", ["-C", directory, "branch", "--show-current"], {
    encoding: "utf8",
  }).trim();
}

test("CLI refuses a different checkout and records evidence in an explicit root", async (t) => {
  const { directory, head } = await gitFixture(t);
  const { directory: target, head: targetHead } = await gitFixture(t);
  const runner = fileURLToPath(new URL("./test-receipt.mjs", import.meta.url));
  const run = (...args) =>
    spawnSync(process.execPath, [runner, ...args], { cwd: directory, encoding: "utf8" });
  const refused = run("--verify", head);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /different Git worktree.*--root/su);

  const allowed = run("--root", target, "--", process.execPath, "-p", "process.cwd()");
  assert.equal(allowed.status, 0, allowed.stderr);
  const root = await realpath(target);
  assert.ok(allowed.stdout.includes(`Repository: ${root}`));
  assert.ok(allowed.stdout.includes(`Branch: ${gitBranch(root)}`));
  assert.ok(allowed.stdout.includes(`HEAD: ${targetHead}`));
  assert.ok(allowed.stdout.includes(`CWD: ${await realpath(directory)}`));
  assert.match(allowed.stdout, /Worktree: clean/u);
  assert.match(allowed.stdout, /Run: .*process.cwd/u);
  const saved = await verifyReceipt(root, targetHead);
  assert.equal(saved.commands[0].root, root);
  assert.equal(saved.commands[0].branch, gitBranch(root));
});

test("receipts bind evidence to the worktree the tests ran in", async (t) => {
  const { directory, head, git } = await gitFixture(t);
  const other = await gitFixture(t);
  const publish = (target) => [
    process.execPath,
    "--input-type=module",
    "-e",
    `import { publishTestMetrics } from ${JSON.stringify(new URL("./test-receipt.mjs", import.meta.url).href)};
     await publishTestMetrics([{ files: ["a.test.ts"], counts: { passed: 1, failed: 0, skipped: 0 } }], [], ${JSON.stringify(target)});`,
  ];
  await assert.rejects(
    recordTestRun(directory, publish(other.directory), { stdio: "ignore" }),
    /The command tested .* not /u,
  );
  await assert.rejects(verifyReceipt(directory, head), /No test receipt exists/u);

  await recordTestRun(directory, publish(directory), { stdio: "ignore" });
  const clone = await mkdtemp(join(tmpdir(), "hub-receipt-clone-"));
  t.after(() => rm(clone, { recursive: true }));
  execFileSync("git", ["clone", "--quiet", directory, clone]);
  assert.equal(git("rev-parse", "HEAD"), head);
  await cp(join(directory, ".test-receipts"), join(clone, ".test-receipts"), { recursive: true });
  await assert.rejects(verifyReceipt(clone, head), /different worktree/u);
  await verifyReceipt(directory, head);
});

test("an interrupted receipt waits for the command and removes its temp directory and lock", async (t) => {
  const { directory, head } = await gitFixture(t);
  const runner = fileURLToPath(new URL("./test-receipt.mjs", import.meta.url));
  const receiptDir = join(directory, ".test-receipts");
  const marker = join(receiptDir, "ready");
  const temp = join(receiptDir, "tmp");
  await mkdir(temp, { recursive: true });
  const script = `
    const { writeFileSync } = require("node:fs");
    const marker = process.argv[1];
    const timer = setInterval(() => {}, 1000);
    process.on("SIGTERM", () => setTimeout(() => {
      writeFileSync(marker + "-signal", "SIGTERM");
      clearInterval(timer);
    }, 150));
    writeFileSync(marker, String(process.pid));
  `;
  const caller = spawn(
    process.execPath,
    [runner, "--root", directory, "--", process.execPath, "-e", script, marker],
    { env: { ...process.env, TMPDIR: temp }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(caller, "close");
  let output = "";
  for (const stream of [caller.stdout, caller.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk;
    });
  }
  let worker;
  try {
    for (let attempts = 0; !worker && attempts < 200; attempts++) {
      worker = Number(await readFile(marker, "utf8").catch(() => ""));
      if (!worker) await delay(20);
    }
    assert.ok(worker, output || "receipt command did not start");
    const lock = join(receiptDir, `${head}.lock`);
    const owner = JSON.parse(await readFile(lock, "utf8"));
    assert.equal(owner.pid, caller.pid);
    assert.equal(owner.groups[0].pid, worker);
    caller.kill("SIGTERM");
    assert.deepEqual(await once(caller, "exit", { signal: AbortSignal.timeout(4000) }), [1, null]);
    await exited;
    assert.match(output, /INTERRUPTED: SIGTERM/u);
    assert.equal(await readFile(marker + "-signal", "utf8"), "SIGTERM");
    assert.deepEqual(await readdir(temp), []);
    assert.throws(() => process.kill(-worker, 0), { code: "ESRCH" });
    await assert.rejects(readFile(lock), { code: "ENOENT" });
  } finally {
    if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
    if (worker) {
      try {
        process.kill(worker, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await exited;
  }
});

test("TERM after staging a receipt prevents its publication", async (t) => {
  const { directory, head } = await gitFixture(t);
  const runner = fileURLToPath(new URL("./test-receipt.mjs", import.meta.url));
  const receiptDir = join(await realpath(directory), ".test-receipts");
  const marker = join(receiptDir, "staged");
  const preload = join(receiptDir, "pause-write.mjs");
  await mkdir(receiptDir);
  await writeFile(
    preload,
    `
    import { once } from "node:events";
    import { writeFileSync } from "node:fs";
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const writeFile = fs.writeFile;
    fs.writeFile = async (path, ...args) => {
      await writeFile(path, ...args);
      if (path !== ${JSON.stringify(join(receiptDir, `${head}.tmp-`))} + process.pid) return;
      const keepAlive = setInterval(() => {}, 1000);
      const signal = once(process, "SIGTERM");
      writeFileSync(${JSON.stringify(marker)}, path);
      try { await signal; } finally { clearInterval(keepAlive); }
    };
    syncBuiltinESMExports();
    `,
  );

  const caller = spawn(
    process.execPath,
    ["--import", preload, runner, "--root", directory, "--", process.execPath, "-e", ""],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(caller, "close");
  let output = "";
  caller.stdout.on("data", (chunk) => {
    output += chunk;
  });
  caller.stderr.on("data", (chunk) => {
    output += chunk;
  });
  try {
    let pending = "";
    for (let attempt = 0; !pending && attempt < 200 && caller.exitCode === null; attempt++) {
      pending = await readFile(marker, "utf8").catch(() => "");
      if (!pending) await delay(20);
    }
    assert.ok(pending, output || "receipt did not reach the pending write");
    const result = once(caller, "exit", { signal: AbortSignal.timeout(4000) });
    caller.kill("SIGTERM");
    assert.deepEqual(await result, [1, null]);
    await exited;
    assert.match(output, /INTERRUPTED: SIGTERM/u);
    assert.doesNotMatch(output, /^Wrote /mu);
    await assert.rejects(verifyReceipt(directory, head), /No test receipt exists/u);
    await assert.rejects(readFile(pending), { code: "ENOENT" });
    await assert.rejects(readFile(join(receiptDir, `${head}.lock`)), { code: "ENOENT" });
  } finally {
    if (caller.exitCode === null && caller.signalCode === null) caller.kill("SIGKILL");
    await exited;
  }
});

test("a dead receipt writer's lock is reclaimed on the next recording", async (t) => {
  const { directory, head } = await gitFixture(t);
  const receiptDir = join(directory, ".test-receipts");
  const lock = join(receiptDir, `${head}.lock`);
  await mkdir(receiptDir);
  const writer = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(writer, "exit");
  await writeFile(lock, JSON.stringify({ pid: writer.pid, groups: [] }));
  const result = await recordTestRun(directory, [process.execPath, "-e", ""], { stdio: "ignore" });
  assert.equal(result.code, 0);
  await verifyReceipt(directory, head);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("an explicit command without metrics reports an unconfirmed tested root", async (t) => {
  const { directory, head } = await gitFixture(t);
  const other = await gitFixture(t);
  const script = join(other.directory, "check.mjs");
  await writeFile(script, "");
  const { path } = await recordTestRun(directory, [process.execPath, script], { stdio: "ignore" });
  const entry = JSON.parse(await readFile(path, "utf8")).commands[0];
  assert.equal(entry.testedRoot, await realpath(directory));
  assert.equal(entry.counts, null);

  const runner = fileURLToPath(new URL("./test-receipt.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [runner, "--root", directory, "--verify", head], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^    Tested root was not confirmed by metrics\.$/mu);
});
