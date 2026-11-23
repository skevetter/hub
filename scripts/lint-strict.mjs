#!/usr/bin/env node
// Lints changed files with oxlint.strict.json. The base is --base, STRICT_LINT_BASE,
// the newest fork release tag reachable from HEAD, or the merge base with origin/main.
// --staged (pre-commit) refuses files with unstaged edits, since oxlint reads the disk copy.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = "oxlint.strict.json";
const startRootFiles = new Set(["vite.config.ts", "drizzle.config.ts"]);
const ignoredFiles = new Set(["src/routeTree.gen.ts"]);
const ambientPattern = /^\s*declare (?:global|module)\b/mu;
const summaryPattern = /^\d+ problems?$/mu;
const positionPattern = /^\d+:\d+: /u;

function print(line) {
  process.stdout.write(`${line}\n`);
}

function runGit(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function gitValue(args) {
  const result = runGit(args);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitList(args) {
  const result = runGit(args);
  if (result.status !== 0) {
    throw new Error(`strict lint: git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\0").filter((file) => file.length > 0);
}

export function parseArgs(argv) {
  const options = { base: process.env.STRICT_LINT_BASE, staged: false, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg === "--staged") options.staged = true;
    else if (arg !== "--") options.files.push(arg);
  }
  return options;
}

function defaultBase() {
  const tag = gitValue(["describe", "--tags", "--abbrev=0", "--match", "fork-*", "HEAD"]);
  return tag ?? gitValue(["merge-base", "HEAD", "origin/main"]);
}

function changedFiles(base) {
  const mergeBase = gitValue(["merge-base", base, "HEAD"]);
  if (mergeBase === undefined) {
    throw new Error(`strict lint: cannot find a merge base with ${base}`);
  }
  return [
    ...gitList(["diff", "--name-only", "-z", "--diff-filter=ACMR", mergeBase]),
    ...gitList(["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
}

function toRepoPath(file) {
  return path.relative(root, path.resolve(file)).split(path.sep).join("/");
}

export function lintGroup(file) {
  if (ignoredFiles.has(file) || !existsSync(path.join(root, file))) return undefined;
  if (startRootFiles.has(file)) return "start";
  if (!file.startsWith("src/")) return undefined;
  if (file.endsWith(".tsx")) return "start";
  return file.endsWith(".ts") ? "node" : undefined;
}

function groupFiles(files) {
  const groups = { node: [], start: [] };
  for (const file of new Set(files.map(toRepoPath))) {
    const group = lintGroup(file);
    if (group) groups[group].push(file);
  }
  return groups;
}

export function partlyStaged(files, unstaged) {
  const dirty = new Set(unstaged);
  return files.filter((file) => dirty.has(file));
}

// tsgolint builds its program from the listed files only, so module augmentations
// such as the router Register must be passed in or route types collapse to any.
export function ambientFiles() {
  const entries = readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => toRepoPath(path.join(entry.parentPath, entry.name)))
    .filter((file) => !ignoredFiles.has(file))
    .filter((file) => ambientPattern.test(readFileSync(path.join(root, file), "utf8")));
}

function runOxlint(tsconfig, files, extraFiles) {
  const bin = path.join(root, "node_modules", ".bin", "oxlint");
  const targets = [...new Set([...files, ...extraFiles])];
  const args = ["--config", config, "--tsconfig", tsconfig, "-f", "unix", ...targets];
  return spawnSync(bin, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function isDiagnosticFor(line, file) {
  return line.startsWith(`${file}:`) && positionPattern.test(line.slice(file.length + 1));
}

export function selectDiagnostics(output, files) {
  return output.split("\n").filter((line) => files.some((file) => isDiagnosticFor(line, file)));
}

function toolFailure(result) {
  if (result.error) return `strict lint: oxlint did not run: ${result.error.message}`;
  if (result.signal) return `strict lint: oxlint stopped by ${result.signal}`;
  if (result.status !== 0 && !summaryPattern.test(result.stdout)) {
    return `strict lint: oxlint failed\n${result.stdout}${result.stderr}`;
  }
  return undefined;
}

function reportGroup(tsconfig, files, extraFiles) {
  if (files.length === 0) return 0;
  const result = runOxlint(tsconfig, files, extraFiles);
  const failure = toolFailure(result);
  if (failure) {
    process.stderr.write(`${failure}\n`);
    return 1;
  }
  const lines = selectDiagnostics(result.stdout, files);
  for (const line of lines) print(line);
  return lines.length;
}

function resolveTargets(options) {
  if (options.files.length > 0) return { files: options.files, source: "listed files" };
  const base = options.base ?? defaultBase();
  if (base === undefined) throw new Error("strict lint: no base found; pass --base <ref>");
  return { files: changedFiles(base), source: `changes since ${base}` };
}

function checkStaged(groups) {
  const targets = [...groups.node, ...groups.start];
  const dirty = partlyStaged(targets, gitList(["diff", "--name-only", "-z"]));
  for (const file of dirty) print(`strict lint: ${file} has unstaged edits; stage or revert them`);
  return dirty.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { files, source } = resolveTargets(options);
  const groups = groupFiles(files);
  print(`strict lint: ${groups.node.length + groups.start.length} file(s) from ${source}`);
  const ambient = ambientFiles();
  const nodeAmbient = ambient.filter((file) => file.endsWith(".ts"));
  const problems =
    (options.staged ? checkStaged(groups) : 0) +
    reportGroup("tsconfig.json", groups.node, nodeAmbient) +
    reportGroup("tsconfig.start.json", groups.start, ambient);
  print(`strict lint: ${problems} problem(s)`);
  process.exitCode = problems === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
