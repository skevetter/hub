import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function compareInstall(locked, installed) {
  const differences = [];
  for (const [path, version] of Object.entries(installed)) {
    if (locked[path]?.version !== version) differences.push(path || "<root>");
  }
  for (const [path, entry] of Object.entries(locked)) {
    if (entry.dev || entry.optional || entry.devOptional || Object.hasOwn(installed, path))
      continue;
    differences.push(path || "<root>");
  }
  return differences.sort();
}

function installedVersions(prefix, packageName) {
  const tree = execFileSync("npm", ["ls", "--all", "--global", "--prefix", prefix, "--parseable"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const root = realpathSync(resolve(prefix, "lib/node_modules", packageName));
  return Object.fromEntries(
    tree
      .filter((path) => path === root || path.startsWith(`${root}/`))
      .map((path) => [relative(root, path), readJson(resolve(path, "package.json")).version]),
  );
}

if (import.meta.main) {
  const [lockPath, prefix] = process.argv.slice(2);
  const lock = readJson(lockPath);
  const differences = compareInstall(lock.packages, installedVersions(prefix, lock.name));
  if (differences.length)
    throw new Error(
      `Installed tree differs from the lock at ${differences.length} paths:\n${differences.slice(0, 10).join("\n")}`,
    );
  console.log("Installed tree matches the locked runtime dependencies");
}
