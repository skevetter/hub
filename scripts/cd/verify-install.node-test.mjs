import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareInstall } from "./verify-install.mjs";

const locked = {
  "": { version: "1.0.0" },
  "node_modules/a": { version: "1.2.0" },
  "node_modules/a/node_modules/b": { version: "1.0.0" },
  "node_modules/c": { version: "3.0.0", optional: true },
  "node_modules/d": { version: "4.0.0", dev: true },
};

test("accepts the runtime tree without platform optional and development packages", () => {
  assert.deepEqual(
    compareInstall(locked, {
      "": "1.0.0",
      "node_modules/a": "1.2.0",
      "node_modules/a/node_modules/b": "1.0.0",
    }),
    [],
  );
});

test("reports drift, missing dependencies, and extra paths", () => {
  assert.deepEqual(
    compareInstall(locked, {
      "": "1.0.0",
      "node_modules/a": "1.3.0",
      "node_modules/extra": "1.0.0",
    }),
    ["node_modules/a", "node_modules/a/node_modules/b", "node_modules/extra"],
  );
});

function writeInstalled(root, path, version) {
  const directory = join(root, path);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
}

test("verifies a physical production tree and rejects deliberate drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-installed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "npm-shrinkwrap.json"), JSON.stringify({ packages: locked }));
  writeInstalled(root, "", "1.0.0");
  writeInstalled(root, "node_modules/a", "1.2.0");
  writeInstalled(root, "node_modules/a/node_modules/b", "1.0.0");
  const script = fileURLToPath(new URL("./verify-install.mjs", import.meta.url));
  const check = () => spawnSync(process.execPath, [script, root], { encoding: "utf8" });
  const clean = check();
  assert.equal(clean.status, 0, clean.stderr);
  writeInstalled(root, "node_modules/a/node_modules/b", "1.0.1");
  const drift = check();
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /node_modules\/a\/node_modules\/b/u);
});
