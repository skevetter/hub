import assert from "node:assert/strict";
import test from "node:test";
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
