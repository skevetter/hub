import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
