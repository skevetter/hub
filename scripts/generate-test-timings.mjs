import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { isEntrypoint, repositoryFor } from "./test-context.mjs";

const finishedAssertions = new Set(["passed", "failed", "skipped", "todo"]);

function finishedFile(file) {
  return (
    (file.status === "passed" || file.status === "failed") &&
    Array.isArray(file.assertionResults) &&
    file.assertionResults.length > 0 &&
    file.assertionResults.every((assertion) => finishedAssertions.has(assertion?.status))
  );
}

export function timingEntries(report, root) {
  if (!Array.isArray(report?.testResults) || !report.testResults.length) return null;
  const entries = [];
  for (const file of report.testResults) {
    if (!file || !finishedFile(file)) return null;
    const { startTime, endTime } = file;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime)
      return null;
    const path = isAbsolute(file.name) ? relative(root, file.name) : file.name;
    entries.push([path, Math.round(endTime - startTime)]);
  }
  return entries;
}

async function readShardTimings(directory, root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const reports = entries
    .filter((entry) => /^shard-\d+$/u.test(entry.name) && entry.isDirectory())
    .map(({ name }) => join(directory, name, "results.json"));
  for (const entry of entries) {
    if (/^shard-\d+\.json$/u.test(entry.name) && entry.isFile()) {
      reports.push(join(directory, entry.name));
    }
  }
  if (!reports.length) throw new Error("No shard reports found.");
  const timings = [];
  for (const path of reports) {
    const entries = timingEntries(JSON.parse(await readFile(path, "utf8")), root);
    if (!entries) throw new Error(`Incomplete shard report: ${path}`);
    timings.push(...entries);
  }
  return timings;
}

function sortedBaseline(entries) {
  const timings = new Map();
  for (const [path, duration] of entries) {
    if (!path || path === ".." || path.startsWith("../") || isAbsolute(path) || timings.has(path)) {
      throw new Error(`Invalid or duplicate repository-relative timing path: ${path}`);
    }
    timings.set(path, duration);
  }
  return Object.fromEntries([...timings.keys()].sort().map((path) => [path, timings.get(path)]));
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { root: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("Pass the directory containing the shard reports.");
  const root = repositoryFor(import.meta.url, values.root);
  const baseline = sortedBaseline(await readShardTimings(positionals[0], root));
  const output = "scripts/test-timings.json";
  const format = spawnSync(join(root, "node_modules/.bin/oxfmt"), [`--stdin-filepath=${output}`], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(baseline),
  });
  if (format.status !== 0) throw format.error ?? new Error(`oxfmt failed: ${format.stderr}`);
  await writeFile(join(root, output), format.stdout);
}

if (isEntrypoint(import.meta.url)) await main();
