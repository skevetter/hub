import assert from "node:assert/strict";
import test from "node:test";
import { nextVersion } from "./next-version.mjs";

test("starts at v1.0.0 when there is no tag", () => {
  assert.equal(nextVersion("", ["feat!: first feature"]), "v1.0.0");
});

test("uses the largest conventional bump", () => {
  assert.equal(
    nextVersion("v2.3.4", ["fix: repair", "feat(ui): add", "fix(core)!: remove"]),
    "v3.0.0",
  );
  assert.equal(nextVersion("v2.3.4", ["feat(ui): add", "fix: repair"]), "v2.4.0");
  assert.equal(nextVersion("v2.3.4", ["remove a warning"]), "v2.3.5");
});

test("uses breaking footers and starts fresh after an upstream v0 tag", () => {
  assert.equal(
    nextVersion("v2.3.4", ["chore: rename"], ["Notes\n\nBREAKING CHANGE: rename"]),
    "v3.0.0",
  );
  assert.equal(nextVersion("v0.11.0", ["feat!: breaking"]), "v1.0.0");
  assert.equal(nextVersion("v2.3", []), "v1.0.0");
});
