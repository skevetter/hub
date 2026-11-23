#!/usr/bin/env node
// Lints changed files with oxlint.strict.json. The base is --base, STRICT_LINT_BASE,
// the newest fork release tag reachable from HEAD, or the merge base with origin/main.
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

function print(line) {
  process.stdout.write(`${line}\n`);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function parseArgs(argv) {
  const options = { base: process.env.STRICT_LINT_BASE, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg !== "--") options.files.push(arg);
  }
  return options;
}

function defaultBase() {
  const tag = git(["describe", "--tags", "--abbrev=0", "--match", "fork-*", "HEAD"]);
  return tag ?? git(["merge-base", "HEAD", "origin/main"]);
}

function changedFiles(base) {
  const mergeBase = git(["merge-base", base, "HEAD"]);
  if (mergeBase === undefined)
    throw new Error(`strict lint: cannot find a merge base with ${base}`);
  const output = git(["diff", "--name-only", "--diff-filter=ACMR", mergeBase]);
  return output ? output.split("\n") : [];
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

export function selectDiagnostics(output, files) {
  const wanted = new Set(files);
  return output.split("\n").filter((line) => wanted.has(line.split(":", 1)[0]));
}

function reportGroup(tsconfig, files, extraFiles) {
  if (files.length === 0) return 0;
  const result = runOxlint(tsconfig, files, extraFiles);
  if (result.status !== 0 && !summaryPattern.test(result.stdout)) {
    process.stderr.write(result.stdout + result.stderr);
    return 1;
  }
  const lines = selectDiagnostics(result.stdout, files);
  for (const line of lines) print(line);
  return lines.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const explicit = options.files.length > 0;
  const base = explicit ? undefined : (options.base ?? defaultBase());
  if (!explicit && base === undefined)
    throw new Error("strict lint: no base found; pass --base <ref>");
  const groups = groupFiles(explicit ? options.files : changedFiles(base));
  const source = explicit ? "listed files" : `changes since ${base}`;
  print(`strict lint: ${groups.node.length + groups.start.length} file(s) from ${source}`);
  const ambient = ambientFiles();
  const problems =
    reportGroup(
      "tsconfig.json",
      groups.node,
      ambient.filter((file) => file.endsWith(".ts")),
    ) + reportGroup("tsconfig.start.json", groups.start, ambient);
  print(`strict lint: ${problems} problem(s)`);
  process.exitCode = problems === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
