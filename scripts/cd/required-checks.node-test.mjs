import assert from "node:assert/strict";
import test from "node:test";
import { requiredChecks } from "./required-checks.mjs";

function needs() {
  return {
    changes: { result: "success", outputs: { ui: "false", e2e: "false", workflows: "false" } },
    static: { result: "success" },
    "docker-smoke": { result: "success" },
    unit: { result: "success" },
    browser: { result: "skipped" },
    "hub-e2e": { result: "skipped" },
    "workflow-lint": { result: "skipped" },
  };
}

test("requires mandatory jobs and a complete classifier", () => {
  assert.equal(requiredChecks({}, false), false);
  const result = needs();
  assert.equal(requiredChecks(result, false), true);
  result.unit.result = "skipped";
  assert.equal(requiredChecks(result, false), false);
  result.unit.result = "success";
  delete result.changes.outputs.workflows;
  assert.equal(requiredChecks(result, false), false);
});

test("only skips suites explicitly excluded by the path or nightly tier", () => {
  const result = needs();
  result.changes.outputs.ui = "true";
  assert.equal(requiredChecks(result, false), false);
  result.browser.result = "success";
  assert.equal(requiredChecks(result, false), true);
  result.static.result = "skipped";
  result["hub-e2e"].result = "success";
  assert.equal(requiredChecks(result, true), true);
  result["workflow-lint"].result = "cancelled";
  assert.equal(requiredChecks(result, true), false);
});
