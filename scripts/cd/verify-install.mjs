import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function compareInstall(locked, installed) {
  const differences = [];
  for (const [path, version] of Object.entries(installed)) {
    const entry = locked[path];
    if (entry?.version !== version || entry.dev) differences.push(path || "<root>");
  }
  for (const [path, entry] of Object.entries(locked)) {
    if (entry.dev || entry.optional || entry.devOptional || Object.hasOwn(installed, path))
      continue;
    differences.push(path || "<root>");
  }
  return differences.sort();
}

function packageDirectories(modules) {
  const directory = lstatSync(modules, { throwIfNoEntry: false });
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error("Unexpected linked dependency directory");
  const entries = readdirSync(modules);
  return entries
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => {
      const path = join(modules, name);
      if (!lstatSync(path).isDirectory()) throw new Error(`Unexpected dependency entry: ${name}`);
      if (!name.startsWith("@")) return [path];
      return readdirSync(path).map((child) => join(path, child));
    });
}

function* installedVersions(root, path = root) {
  if (!lstatSync(path).isDirectory()) throw new Error("Unexpected linked package");
  yield [relative(root, path), readJson(resolve(path, "package.json")).version];
  for (const child of packageDirectories(join(path, "node_modules"))) {
    yield* installedVersions(root, child);
  }
}

if (import.meta.main) {
  const root = realpathSync(process.argv[2] ?? ".");
  const lock = readJson(resolve(root, "npm-shrinkwrap.json"));
  const differences = compareInstall(lock.packages, Object.fromEntries(installedVersions(root)));
  if (differences.length)
    throw new Error(
      `Installed tree differs from the lock at ${differences.length} paths:\n${differences.slice(0, 10).join("\n")}`,
    );
  console.log("Installed tree matches the locked runtime dependencies");
}
