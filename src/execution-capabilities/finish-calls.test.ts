import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { FinishCallRegistry } from "./finish-calls.js";

describe("finish call registry", () => {
  it("owns the outcome from the start of a call until it fails", () => {
    const registry = new FinishCallRegistry();
    assert.equal(registry.ownsOutcome("a"), false);
    registry.start("a");
    assert.equal(registry.ownsOutcome("a"), true);
    registry.resolve("a", "failed");
    assert.equal(registry.ownsOutcome("a"), false);
  });

  it("keeps owning the outcome after a call completed", () => {
    const registry = new FinishCallRegistry();
    registry.start("a");
    registry.resolve("a", "completed");
    assert.equal(registry.ownsOutcome("a"), true);
  });

  it("blocks while any of several overlapping calls is unresolved", () => {
    const registry = new FinishCallRegistry();
    registry.start("a");
    registry.start("a");
    registry.resolve("a", "failed");
    assert.equal(registry.ownsOutcome("a"), true);
    registry.resolve("a", "failed");
    assert.equal(registry.ownsOutcome("a"), false);
  });

  it("never lets an extra resolve hide a call that is still running", () => {
    const registry = new FinishCallRegistry();
    registry.start("a");
    registry.start("a");
    registry.resolve("a", "failed");
    registry.resolve("a", "failed");
    registry.resolve("a", "failed");
    registry.start("a");
    assert.equal(registry.ownsOutcome("a"), true);
  });

  it("attributes a call to its own execution only", () => {
    const registry = new FinishCallRegistry();
    registry.start("b");
    registry.start("a");
    registry.resolve("a", "completed");
    assert.equal(registry.ownsOutcome("a"), true);
    registry.release("a");
    assert.equal(registry.ownsOutcome("a"), false);
    assert.equal(registry.ownsOutcome("b"), true);
    assert.equal(registry.ownsOutcome("c"), false);
  });

  it("frees an entry on release and ignores a call that ends afterwards", () => {
    const registry = new FinishCallRegistry();
    registry.start("a");
    registry.release("a");
    registry.resolve("a", "completed");
    assert.equal(registry.size, 0);
    assert.equal(registry.ownsOutcome("a"), false);
  });
});
