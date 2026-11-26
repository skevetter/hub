import { describe, expect, it } from "vitest";
import { moveStep, newStepFormValue, type TriggerFormValue } from "./configuration/editor.js";
import {
  outputReferences,
  patchStepAt,
  reorderRowKeys,
  saveFieldErrors,
  staleRunIfError,
  startsAsList,
  stepAt,
  stepFieldId,
  stepFieldKey,
} from "./step-form-model.js";

function form(...ids: string[]): TriggerFormValue {
  return {
    name: "t",
    enabled: true,
    event: "manual.run",
    connection: "",
    allowedUsers: "*",
    qualifiers: {},
    daemon: "d",
    cwd: "/w",
    runMaxRuntime: "",
    steps: ids.map((id) => newStepFormValue({ id })),
  };
}

describe("step form model", () => {
  it("patches one step and leaves the others as they are", () => {
    const value = form("a", "b", "c");
    const next = patchStepAt(value, 1, { prompt: "hi" });
    expect(next.steps.map((step) => step.prompt)).toEqual(["", "hi", ""]);
    expect(next.steps[0]).toBe(value.steps[0]);
    expect(next.steps[2]).toBe(value.steps[2]);
  });

  it("refuses a step the form does not have", () => {
    expect(() => stepAt(form("a"), 1)).toThrow("The form has no step 1.");
  });

  it("keeps the one-step ids for the first step and suffixes the rest", () => {
    expect(stepFieldId("trigger-prompt", 0)).toBe("trigger-prompt");
    expect(stepFieldId("trigger-prompt", 2)).toBe("trigger-prompt-3");
    expect(stepFieldKey(2, "runIf")).toBe("steps.2.runIf");
  });

  it("lists steps when there are several or the one step is not plain", () => {
    expect(startsAsList(form("run").steps, true)).toBe(false);
    expect(startsAsList(form("run").steps, false)).toBe(true);
    expect(startsAsList(form("a", "b").steps, true)).toBe(true);
  });

  it("moves and removes row keys with their rows", () => {
    expect(reorderRowKeys(["a", "b", "c"], { kind: "move", from: 0, to: 2 })).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(reorderRowKeys(["a", "b", "c"], { kind: "move", from: 2, to: 1 })).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(reorderRowKeys(["a", "b", "c"], { kind: "remove", index: 1 })).toEqual(["a", "c"]);
  });

  it("places the save check's continuity refusal on that step", () => {
    const message =
      'steps.1.continuation: Step "b" continues an incompatible conversation.\nsteps.3.continuation: Differs in agent.';
    expect(saveFieldErrors(message)).toEqual({
      "steps.1.continuationMode": 'Step "b" continues an incompatible conversation.',
      "steps.3.continuationMode": "Differs in agent.",
    });
    expect(saveFieldErrors("name: Already taken")).toEqual({});
    expect(saveFieldErrors(undefined)).toEqual({});
  });

  it("flags a condition that reads a step which no longer runs before it", () => {
    const value = form("review", "fix");
    const guarded = patchStepAt(value, 1, {
      runIf: "${{ steps.review.outputs.verdict == 'fix' }}",
    });
    expect(staleRunIfError(guarded, 1)).toBeUndefined();
    const moved = moveStep(guarded, 1, 0);
    expect(staleRunIfError(moved, 0)).toBe(
      'Step "review" does not run before this step, so its outputs are not available.',
    );
    expect(moved.steps[0]?.runIf).toBe("${{ steps.review.outputs.verdict == 'fix' }}");
  });

  it("does not flag a half-typed condition", () => {
    const typing = patchStepAt(form("a", "b"), 1, { runIf: "${{ steps." });
    expect(staleRunIfError(typing, 1)).toBeUndefined();
  });

  it("spells earlier outputs the way a condition reads them", () => {
    expect(outputReferences([{ id: "review", fields: ["verdict", "score"] }])).toEqual([
      "steps.review.outputs.verdict",
      "steps.review.outputs.score",
    ]);
  });
});
