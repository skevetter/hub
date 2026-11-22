import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { partitionFiles, rerunFiles, runShards } from "./test-parallel.mjs";

test("partition puts each file in one shard and balances cached durations", () => {
  const files = [
    { path: "small.test.ts", weight: 1 },
    { path: "fast.test.ts", weight: 2 },
    { path: "other.test.ts", weight: 3 },
    { path: "medium.test.ts", weight: 5 },
    { path: "slow.test.ts", weight: 9 },
  ];
  assert.deepEqual(partitionFiles(files, 2), [
    ["slow.test.ts", "small.test.ts"],
    ["medium.test.ts", "other.test.ts", "fast.test.ts"],
  ]);
  assert.deepEqual(partitionFiles(files.slice(0, 1), 4), [["small.test.ts"]]);
});

test("the daemon suite owns the first shard even with a small timing estimate", () => {
  const daemon = join("src", "daemons", "daemons.test.ts");
  const files = [
    { path: "slow.test.ts", weight: 90 },
    { path: daemon, weight: 10 },
    { path: "medium.test.ts", weight: 50 },
  ];
  assert.deepEqual(partitionFiles(files, 2), [[daemon], ["slow.test.ts", "medium.test.ts"]]);
  assert.deepEqual(partitionFiles(files, 1), [["slow.test.ts", "medium.test.ts", daemon]]);
});

test("failure reporting keeps shard numbers and reruns only failed files in one process", async () => {
  const calls = [];
  const output = [];
  let active = 0;
  let peak = 0;
  const execute = async (name, files) => {
    calls.push([name, files]);
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return {
      durationMs: 1250,
      counts: {
        passed: name === "Shard 2" ? 1 : 2,
        failed: name === "Shard 2" ? 1 : 0,
        skipped: 0,
      },
      failedFiles: name === "Shard 2" ? ["b.test.ts"] : [],
      exitCode: name === "Shard 2" ? 1 : 0,
    };
  };
  const result = await runShards([["a.test.ts"], ["b.test.ts", "c.test.ts"]], {
    execute,
    print: (line) => output.push(line),
  });
  assert.deepEqual(result, { exitCode: 1, failedFiles: ["b.test.ts"] });
  assert.match(output.join("\n"), /npm run test:parallel -- --rerun-failed/u);
  const serialExit = await rerunFiles(result.failedFiles, execute, (line) => output.push(line));

  assert.equal(peak, 2);
  assert.deepEqual(calls, [
    ["Shard 1", ["a.test.ts"]],
    ["Shard 2", ["b.test.ts", "c.test.ts"]],
    ["Serial rerun", ["b.test.ts"]],
  ]);
  assert.equal(serialExit, 0);
  assert.match(output.join("\n"), /Shard 2: FAIL.*\n.*b\.test\.ts/u);
  assert.match(output.join("\n"), /Total: 3 files, 3 passed, 1 failed, 0 skipped/u);
  assert.match(output.join("\n"), /Serial rerun: PASS/u);
});

test("a process failure with no named failed files has no serial rerun", async () => {
  const output = [];
  const result = await runShards([["a.test.ts"]], {
    execute: async () => ({
      durationMs: 100,
      counts: { passed: 0, failed: 0, skipped: 0 },
      failedFiles: [],
      exitCode: 1,
      diagnostic: "Vitest exited before writing a JSON report",
    }),
    print: (line) => output.push(line),
  });

  assert.deepEqual(result, { exitCode: 1, failedFiles: [] });
  assert.match(output.join("\n"), /Shard 1: FAIL.*\n.*Vitest exited before writing a JSON report/u);
  assert.doesNotMatch(output.join("\n"), /--rerun-failed/u);
});

test("a shard runner error does not release the caller before sibling shards finish", async () => {
  const sibling = Promise.withResolvers();
  const outcome = runShards([["a.test.ts"], ["b.test.ts"]], {
    execute: async (name) => {
      if (name === "Shard 1") throw new Error("runner error");
      await sibling.promise;
      return {
        durationMs: 1,
        counts: { passed: 1, failed: 0, skipped: 0 },
        failedFiles: [],
        exitCode: 0,
      };
    },
    print: () => undefined,
  });
  let finished = false;
  outcome.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  sibling.resolve();
  assert.deepEqual(await outcome, { exitCode: 1, failedFiles: [] });
});
