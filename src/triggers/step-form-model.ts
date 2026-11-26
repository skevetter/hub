import { stepFormErrors } from "./configuration/editor-steps.js";
import type { StepListChange } from "./configuration/editor-steps.js";
import type {
  TriggerFieldErrors,
  TriggerFormField,
  TriggerFormValue,
  TriggerStepField,
  TriggerStepFormValue,
} from "./configuration/editor.js";

export interface TriggerFieldProps {
  form: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}

export interface StepFieldProps extends TriggerFieldProps {
  index: number;
}

/** The error slot a field carries, absent while that field is fine. */
export function fieldError(errors: TriggerFieldErrors, key: TriggerFormField) {
  const error = errors[key];
  return error === undefined ? {} : { error };
}

export function stepAt(form: Pick<TriggerFormValue, "steps">, index: number): TriggerStepFormValue {
  const step = form.steps[index];
  if (step === undefined) throw new Error(`The form has no step ${String(index)}.`);
  return step;
}

export function patchStepAt(
  form: TriggerFormValue,
  index: number,
  patch: Partial<TriggerStepFormValue>,
): TriggerFormValue {
  return {
    ...form,
    steps: form.steps.map((step, position) => (position === index ? { ...step, ...patch } : step)),
  };
}

export function stepFieldKey(index: number, field: TriggerStepField): TriggerFormField {
  return `steps.${index}.${field}`;
}

/** The first step keeps the ids a one-step trigger has always had. */
export function stepFieldId(base: string, index: number): string {
  return index === 0 ? base : `${base}-${String(index + 1)}`;
}

/** A trigger lists its steps once it has several, or one that is more than the plain `run`. */
export function startsAsList(steps: TriggerFormValue["steps"], plain: boolean): boolean {
  return steps.length > 1 || !plain;
}

/** Row keys follow their rows through a move or a removal, so a row keeps its own field state. */
export function reorderRowKeys(keys: readonly string[], change: StepListChange): string[] {
  if (change.kind === "remove") return keys.filter((_, position) => position !== change.index);
  const moved = keys[change.from];
  if (moved === undefined) return [...keys];
  const rest = keys.filter((_, position) => position !== change.from);
  rest.splice(change.to, 0, moved);
  return rest;
}

const STALE_REFERENCE = /does not run before this step/u;

/**
 * A condition that reads a step which no longer runs before it. Moving or renaming a step causes
 * this without touching the condition, so it is flagged at once instead of waiting for a save.
 */
export function staleRunIfError(
  form: Pick<TriggerFormValue, "steps">,
  index: number,
): string | undefined {
  const message = stepFormErrors(form.steps)[stepFieldKey(index, "runIf")];
  return message !== undefined && STALE_REFERENCE.test(message) ? message : undefined;
}

const SAVE_STEP_ISSUE = /^steps\.(\d+)\.continuation: (.+)$/gmu;

/**
 * The save check names the step whose continuity it refuses as `steps.N.continuation`. The form
 * has no such field, so the message is placed on the continuity control of that step.
 */
export function saveFieldErrors(message: string | undefined): TriggerFieldErrors {
  if (message === undefined) return {};
  const errors: Record<string, string> = {};
  for (const [, position, reason] of message.matchAll(SAVE_STEP_ISSUE)) {
    if (position === undefined || reason === undefined) continue;
    errors[`steps.${position}.continuationMode`] = reason;
  }
  return errors;
}

/** Earlier output references, written the way a condition reads them. */
export function outputReferences(
  outputs: readonly { id: string; fields: readonly string[] }[],
): string[] {
  return outputs.flatMap(({ id, fields }) => fields.map((field) => `steps.${id}.outputs.${field}`));
}
