import {
  isScriptRun,
  type TriggerDocument,
  type TriggerRun,
  type TriggerStep,
  type TriggerTarget,
} from "./schema.js";

/** The id the one step of a `run` document carries, in compiled triggers and in run history. */
export const SHORTHAND_STEP_ID = "run";

export interface NormalizedSteps {
  target: TriggerTarget;
  steps: readonly TriggerStep[];
  /** True when the document was written with `run`, so tools keep that form for one step. */
  shorthand: boolean;
}

/**
 * Both document forms as one list of steps and the target they share. Every reader of a trigger
 * document goes through this instead of reading `run` or `steps` itself.
 */
export function normalizeSteps(
  document: Pick<TriggerDocument, "run" | "steps" | "target">,
): NormalizedSteps {
  const { run, steps, target } = document;
  if (run !== undefined) {
    return { target: run.target, steps: [runAsStep(run)], shorthand: true };
  }
  if (steps === undefined || target === undefined) {
    throw new Error("a trigger document has run, or steps with a target");
  }
  return { target, steps, shorthand: false };
}

function runAsStep(run: TriggerRun): TriggerStep {
  if (isScriptRun(run)) {
    const { target: _target, ...fields } = run;
    return { ...fields, id: SHORTHAND_STEP_ID };
  }
  const { target: _target, ...fields } = run;
  return { ...fields, id: SHORTHAND_STEP_ID };
}

/** The `run` of a one-step document, for callers that only accept that form. */
export function documentRun(document: Pick<TriggerDocument, "run">): TriggerRun {
  if (document.run === undefined) throw new Error("the trigger document uses steps, not run");
  return document.run;
}
