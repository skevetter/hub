import { isMap, isSeq, parseDocument, type Document } from "yaml";
import { expressionPaths, parseExpression } from "../../workflows/expression.js";
import { ContinuationSchema } from "../continuation.js";
import type { TriggerFieldErrors } from "./editor.js";
import {
  blankToUndefined,
  commaSeparated,
  joinAgentId,
  parsePermissions,
  parseProviderOptions,
  refused,
  splitAgentId,
} from "./editor-text.js";
import {
  deleteIfPresent,
  requireWritableYaml,
  SHARED_YAML_FIELD,
  setIfChanged,
  setOptional,
  sharedYamlPath,
  yamlAliases,
  yamlAliasTargetsChanged,
  type YamlPath,
} from "./editor-yaml.js";
import {
  DEFAULT_SCRIPT_MAX_RUNTIME,
  IDENTIFIER,
  isScriptStep,
  MAX_TRIGGER_STEPS,
  type TriggerAgentStep,
  type TriggerStep,
} from "./schema.js";
import { SHORTHAND_STEP_ID, stepContinuation } from "./steps.js";

export type TriggerAction = "prompt" | "script";

export const DEFAULT_AGENT_MAX_RUNTIME = "2h";

export type TriggerStepField =
  | "id"
  | "action"
  | "agent"
  | "mode"
  | "thinkingOptionId"
  | "providerOptions"
  | "continuationMode"
  | "continuationKey"
  | "maxRuntime"
  | "idleTimeout"
  | "completeOnTurnEnd"
  | "githubConnection"
  | "githubRepositories"
  | "githubPermissions"
  | "githubDuration"
  | "prompt"
  | "script"
  | "runIf"
  | "outputSchema";

/** One step of the form: an agent prompt or a script, with the fields that step owns. */
export interface TriggerStepFormValue {
  /** Where the step sits in the document it was read from. A step added in the form has none. */
  origin?: number;
  id: string;
  action: TriggerAction;
  agent: string;
  mode: string;
  thinkingOptionId: string;
  providerOptions: string;
  continuationMode: string;
  continuationKey: string;
  maxRuntime: string;
  idleTimeout: string;
  /** Count a finished agent turn as done when the agent never calls finish_execution. */
  completeOnTurnEnd: boolean;
  githubConnection: string;
  githubRepositories: string;
  githubPermissions: string;
  githubDuration: string;
  prompt: string;
  script: string;
  /** The `if` expression: the step is skipped when it is false. Empty runs the step always. */
  runIf: string;
  /** The JSON schema of the output the agent must write, as text. Empty means none. */
  outputSchema: string;
  sharedFields?: TriggerStepField[];
}

export function newStepFormValue(
  overrides: Partial<TriggerStepFormValue> = {},
): TriggerStepFormValue {
  return {
    id: SHORTHAND_STEP_ID,
    action: "prompt",
    agent: "",
    mode: "",
    thinkingOptionId: "",
    providerOptions: "",
    continuationMode: "conversation",
    continuationKey: "",
    maxRuntime: DEFAULT_AGENT_MAX_RUNTIME,
    idleTimeout: "10m",
    completeOnTurnEnd: false,
    githubConnection: "",
    githubRepositories: "",
    githubPermissions: "",
    githubDuration: "",
    prompt: "",
    script: "",
    runIf: "",
    outputSchema: "",
    ...overrides,
  };
}

/** The form edits an agent, never a choice between agents. */
export function projectSteps(steps: readonly TriggerStep[]): TriggerStepFormValue[] | undefined {
  const projected: TriggerStepFormValue[] = [];
  for (const [origin, step] of steps.entries()) {
    const value = projectStep(step, origin);
    if (value === undefined) return undefined;
    projected.push(value);
  }
  return projected;
}

function projectStep(step: TriggerStep, origin: number): TriggerStepFormValue | undefined {
  const common = { origin, id: step.id, runIf: step.if ?? "" };
  if (isScriptStep(step)) {
    return newStepFormValue({
      ...common,
      action: "script",
      maxRuntime: step.max_runtime,
      script: step.script,
    });
  }
  if ("choices" in step.agent) return undefined;
  return projectAgentStep(step, {
    ...common,
    agent: joinAgentId(step.agent.provider, step.agent.model),
  });
}

function projectGithub(
  github: TriggerAgentStep["github"],
): Pick<
  TriggerStepFormValue,
  "githubConnection" | "githubRepositories" | "githubPermissions" | "githubDuration"
> {
  return {
    githubConnection: github?.connection ?? "",
    githubRepositories: github?.repositories?.join(", ") ?? "",
    githubPermissions:
      github?.permissions === undefined ? "" : JSON.stringify(github.permissions, null, 2),
    githubDuration: github?.duration ?? "",
  };
}

function projectAgentStep(
  step: TriggerAgentStep,
  common: Partial<TriggerStepFormValue>,
): TriggerStepFormValue {
  if ("choices" in step.agent) throw new Error("expected a single agent");
  const { agent } = step;
  const continuation = stepContinuation(step);
  return newStepFormValue({
    ...common,
    mode: agent.mode ?? "",
    thinkingOptionId: agent.thinkingOptionId ?? "",
    providerOptions: agent.options === undefined ? "" : JSON.stringify(agent.options, null, 2),
    continuationMode: continuation.mode,
    continuationKey: continuation.mode === "key" ? continuation.key : "",
    maxRuntime: step.max_runtime,
    idleTimeout: step.idle_timeout,
    completeOnTurnEnd: step.complete_on_turn_end === true,
    ...projectGithub(step.github),
    prompt: step.prompt,
    outputSchema: step.output === undefined ? "" : JSON.stringify(step.output.schema, null, 2),
  });
}

/** One step with the plain id and no condition or output schema is the `run` shorthand. */
export function isShorthandSteps(steps: readonly TriggerStepFormValue[]): boolean {
  return staysShorthand(undefined, steps);
}

/** A trigger form always holds at least one step. */
export function firstStep(value: { steps: readonly TriggerStepFormValue[] }): TriggerStepFormValue {
  const [first] = value.steps;
  if (first === undefined) throw new Error("A trigger form always has a step.");
  return first;
}

export function patchFirstStep<T extends { steps: TriggerStepFormValue[] }>(
  value: T,
  patch: Partial<TriggerStepFormValue>,
): T {
  return { ...value, steps: [{ ...firstStep(value), ...patch }, ...value.steps.slice(1)] };
}

export function hasScriptStep(value: { steps: readonly TriggerStepFormValue[] }): boolean {
  return value.steps.some((step) => step.action === "script");
}

// -- Editing the list ---------------------------------------------------------------------------

export interface StepOrderMetadata {
  stepOrderSource?: { yaml: string; count: number; shared: boolean };
}

interface StepListValue extends StepOrderMetadata {
  steps: TriggerStepFormValue[];
}

function nextStepId(steps: readonly TriggerStepFormValue[]): string {
  const taken = new Set(steps.map((step) => step.id));
  for (let number = steps.length + 1; ; number++) {
    const id = `step-${String(number)}`;
    if (!taken.has(id)) return id;
  }
}

/** Appends a step. A step in a list starts a new agent, so it continues nothing by default. */
export function addStep<T extends { steps: TriggerStepFormValue[] }>(
  value: T,
  action: TriggerAction = "prompt",
): T {
  if (value.steps.length >= MAX_TRIGGER_STEPS) return value;
  const step = newStepFormValue({
    id: nextStepId(value.steps),
    continuationMode: "new",
    ...(action === "script" ? { action, maxRuntime: DEFAULT_SCRIPT_MAX_RUNTIME } : {}),
  });
  return { ...value, steps: [...value.steps, step] };
}

/** A trigger always has a step, so the last one cannot be removed. */
export function removeStep<T extends { steps: TriggerStepFormValue[] }>(
  value: T,
  index: number,
): T {
  return changeStepList(value, { kind: "remove", index });
}

export function moveStep<T extends { steps: TriggerStepFormValue[] }>(
  value: T,
  from: number,
  to: number,
): T {
  return changeStepList(value, { kind: "move", from, to });
}

function changeStepList<T extends StepListValue>(value: T, change: StepListChange): T {
  const steps = proposedStepOrder(value.steps, change);
  if (steps === undefined || stepOrderError(value, steps) !== undefined) return value;
  return { ...value, steps };
}

export function stepListEditError(
  value: StepListValue,
  change: StepListChange,
): string | undefined {
  const steps = proposedStepOrder(value.steps, change);
  return steps === undefined ? undefined : stepOrderError(value, steps);
}

export function stepOrderError(
  previous: StepOrderMetadata,
  next: readonly TriggerStepFormValue[],
): string | undefined {
  const source = previous.stepOrderSource;
  if (source === undefined) return undefined;
  const matches = matchStepOrigins(source.count, next);
  if (sameStepOrder(source.count, matches)) return undefined;
  if (source.shared) return SHARED_YAML_FIELD;
  return prospectiveStepOrderError(source.yaml, matches);
}

function proposedStepOrder(
  previous: readonly TriggerStepFormValue[],
  change: StepListChange,
): TriggerStepFormValue[] | undefined {
  if (change.kind === "remove") {
    if (previous.length <= 1 || previous[change.index] === undefined) return undefined;
    return previous.filter((_, position) => position !== change.index);
  }
  const { from, to } = change;
  const moved = previous[from];
  if (moved === undefined || from === to || to < 0 || to >= previous.length) return undefined;
  const steps = previous.filter((_, position) => position !== from);
  steps.splice(to, 0, moved);
  return steps;
}

/**
 * Moving between a prompt and a script keeps what the two share and resets what the other
 * action's defaults would get wrong: the run limit, an output schema a script cannot have, and an
 * open audience a script may not have. Values only the other action uses stay in the form.
 */
export function changeStepAction<T extends { steps: TriggerStepFormValue[]; allowedUsers: string }>(
  value: T,
  index: number,
  action: TriggerAction,
): T {
  const step = value.steps[index];
  if (step === undefined || step.action === action) return value;
  const changed: TriggerStepFormValue =
    action === "script"
      ? {
          ...step,
          action,
          outputSchema: "",
          maxRuntime:
            step.maxRuntime === DEFAULT_AGENT_MAX_RUNTIME
              ? DEFAULT_SCRIPT_MAX_RUNTIME
              : step.maxRuntime,
        }
      : {
          ...step,
          action,
          maxRuntime:
            step.maxRuntime === DEFAULT_SCRIPT_MAX_RUNTIME
              ? DEFAULT_AGENT_MAX_RUNTIME
              : step.maxRuntime,
        };
  return {
    ...value,
    allowedUsers:
      action === "script" && value.allowedUsers.trim() === "*" ? "" : value.allowedUsers,
    steps: value.steps.map((candidate, position) => (position === index ? changed : candidate)),
  };
}

export interface StepOutputFields {
  id: string;
  fields: string[];
}

/** The output fields earlier agent steps declare, for writing a condition that reads them. */
export function earlierStepOutputs(
  value: { steps: readonly TriggerStepFormValue[] },
  index: number,
): StepOutputFields[] {
  return value.steps.slice(0, index).flatMap((step) => {
    if (step.action !== "prompt") return [];
    const fields = schemaFields(step.outputSchema);
    return fields.length === 0 ? [] : [{ id: step.id, fields }];
  });
}

function schemaFields(text: string): string[] {
  const schema = refusedValue(() => parseOutputSchema(text));
  const properties: unknown = schema?.["properties"];
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? Object.keys(properties)
    : [];
}

function refusedValue<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export type StepListChange =
  | { kind: "remove"; index: number }
  | { kind: "move"; from: number; to: number };

/** Errors are keyed by step position, so a removed or moved step re-keys them with it. */
export function remapStepErrors(
  errors: TriggerFieldErrors,
  change: StepListChange,
): TriggerFieldErrors {
  const remapped: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors)) {
    if (message === undefined) continue;
    const match = /^steps\.(\d+)\.(.+)$/u.exec(key);
    if (match === null) {
      remapped[key] = message;
      continue;
    }
    const index = remapIndex(Number(match[1]), change);
    if (index !== undefined) remapped[`steps.${String(index)}.${match[2] ?? ""}`] = message;
  }
  return remapped;
}

function remapIndex(index: number, change: StepListChange): number | undefined {
  if (change.kind === "remove") {
    if (index === change.index) return undefined;
    return index > change.index ? index - 1 : index;
  }
  return movedIndex(index, change.from, change.to);
}

function movedIndex(index: number, from: number, to: number): number {
  if (index === from) return to;
  const shift = from < to ? -1 : 1;
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  return index >= low && index <= high ? index + shift : index;
}

// -- Validation ---------------------------------------------------------------------------------

/** What is wrong with the steps, keyed `steps` or `steps.<position>.<field>`. */
export function stepFormErrors(steps: readonly TriggerStepFormValue[]): TriggerFieldErrors {
  const errors: Record<string, string> = {};
  if (steps.length === 0) errors["steps"] = "Add at least one step.";
  if (steps.length > MAX_TRIGGER_STEPS) {
    errors["steps"] = `A trigger can have at most ${String(MAX_TRIGGER_STEPS)} steps.`;
  }
  for (const index of steps.keys()) {
    for (const [field, message] of Object.entries(oneStepErrors(steps, index))) {
      errors[`steps.${String(index)}.${field}`] = message;
    }
  }
  return errors;
}

function oneStepErrors(
  steps: readonly TriggerStepFormValue[],
  index: number,
): Partial<Record<TriggerStepField, string>> {
  const step = steps[index];
  if (step === undefined) return {};
  return {
    ...idErrors(steps, index),
    ...(step.maxRuntime.trim().length === 0 ? { maxRuntime: "Maximum runtime is required." } : {}),
    ...(step.action === "script" ? scriptErrors(step) : agentErrors(step)),
    ...runIfErrors(steps, index),
    ...outputSchemaErrors(step),
  };
}

function idErrors(
  steps: readonly TriggerStepFormValue[],
  index: number,
): Partial<Record<TriggerStepField, string>> {
  const raw = steps[index]?.id ?? "";
  const id = raw.trim();
  if (id.length === 0) return { id: "Step ID is required." };
  if (id !== raw) return { id: "Step ID cannot start or end with a space." };
  if (!IDENTIFIER.test(id)) {
    return { id: "Use lowercase letters, digits, and hyphens, starting with a letter." };
  }
  const earlier = steps.slice(0, index).some((step) => step.id.trim() === id);
  return earlier ? { id: "Another step already uses this ID." } : {};
}

/** A condition reads only steps that run before it. The form flags a stale reference, never edits it. */
function runIfErrors(
  steps: readonly TriggerStepFormValue[],
  index: number,
): Partial<Record<TriggerStepField, string>> {
  const condition = conditionText(steps[index]?.runIf ?? "");
  if (condition === undefined) return {};
  const error = refused(() => validateRunIfOrder(condition, steps.slice(0, index)));
  return error === undefined ? {} : { runIf: error };
}

function validateRunIfOrder(condition: string, earlier: readonly TriggerStepFormValue[]): void {
  const ids = new Set(earlier.map((step) => step.id));
  for (const path of expressionPaths(parseExpression(condition))) {
    if (path.namespace === "steps" && !ids.has(path.stepId)) {
      throw new Error(
        `Step "${path.stepId}" does not run before this step, so its outputs are not available.`,
      );
    }
  }
}

function conditionText(text: string): string | undefined {
  return text.trim() === "" ? undefined : text;
}

export function parseOutputSchema(text: string): Record<string, unknown> | undefined {
  if (text.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Output schema must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Output schema must be a JSON object.");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function outputSchemaErrors(step: TriggerStepFormValue): Partial<Record<TriggerStepField, string>> {
  if (step.action === "script") {
    return step.outputSchema.trim().length === 0
      ? {}
      : { outputSchema: "A script has no agent output, so it has no output schema." };
  }
  const error = refused(() => parseOutputSchema(step.outputSchema));
  return error === undefined ? {} : { outputSchema: error };
}

function scriptErrors(step: TriggerStepFormValue): Partial<Record<TriggerStepField, string>> {
  if (step.script.trim().length === 0) return { script: "Script is required." };
  if (step.script.includes("${{")) {
    return {
      script:
        "Script text is not templated. Read event data from the HUB_EVENT_JSON environment variable.",
    };
  }
  return {};
}

function agentErrors(step: TriggerStepFormValue): Partial<Record<TriggerStepField, string>> {
  const errors: Partial<Record<TriggerStepField, string>> = {};
  if (step.idleTimeout.trim().length === 0) errors.idleTimeout = "Idle timeout is required.";
  const agent = refused(() => splitAgentId(step.agent));
  if (agent !== undefined) errors.agent = agent;
  if (step.mode.trim().length === 0) errors.mode = "Execution mode is required.";
  const options = refused(() => parseProviderOptions(step.providerOptions));
  if (options !== undefined) errors.providerOptions = options;
  if (step.githubConnection.trim().length !== 0) {
    const permissions = refused(() => parsePermissions(step.githubPermissions));
    if (permissions !== undefined) errors.githubPermissions = permissions;
  }
  if (refused(() => formContinuation(step)) !== undefined) {
    errors.continuationKey = "Enter a continuation key or expression.";
  }
  if (step.prompt.trim().length === 0) errors.prompt = "Instructions are required.";
  return errors;
}

export function formContinuation(
  step: Pick<TriggerStepFormValue, "continuationMode" | "continuationKey">,
) {
  return ContinuationSchema.parse(
    step.continuationMode === "key"
      ? { mode: "key", key: step.continuationKey }
      : { mode: step.continuationMode },
  );
}

function githubAuthority(step: TriggerStepFormValue) {
  const connection = blankToUndefined(step.githubConnection);
  if (connection === undefined) return undefined;
  const repositories = commaSeparated(step.githubRepositories);
  const permissions = parsePermissions(step.githubPermissions);
  const duration = blankToUndefined(step.githubDuration);
  return {
    connection,
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(duration === undefined ? {} : { duration }),
  };
}

// -- Writing a new document ---------------------------------------------------------------------

/** A step as a document writes it. The shorthand run carries no id and always names its continuation. */
export function stepDocument(
  step: TriggerStepFormValue,
  shorthand: boolean,
): Record<string, unknown> {
  const runIf = conditionText(step.runIf);
  const head = shorthand ? {} : { id: step.id, ...(runIf === undefined ? {} : { if: runIf }) };
  if (step.action === "script") {
    return { ...head, script: step.script, max_runtime: step.maxRuntime.trim() };
  }
  const github = githubAuthority(step);
  const outputSchema = parseOutputSchema(step.outputSchema);
  return {
    ...head,
    agent: agentDocument(step),
    ...(!shorthand && step.continuationMode === "new"
      ? {}
      : { continuation: formContinuation(step) }),
    max_runtime: step.maxRuntime.trim(),
    idle_timeout: step.idleTimeout.trim(),
    ...(step.completeOnTurnEnd ? { complete_on_turn_end: true } : {}),
    ...(github === undefined ? {} : { github }),
    prompt: step.prompt,
    ...(outputSchema === undefined ? {} : { output: { schema: outputSchema } }),
  };
}

function agentDocument(step: TriggerStepFormValue): Record<string, unknown> {
  const agent = splitAgentId(step.agent);
  const providerOptions = parseProviderOptions(step.providerOptions);
  return {
    provider: agent.provider,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    mode: step.mode.trim(),
    ...(blankToUndefined(step.thinkingOptionId) === undefined
      ? {}
      : { thinkingOptionId: step.thinkingOptionId.trim() }),
    ...(providerOptions === undefined ? {} : { options: providerOptions }),
  };
}

// -- Patching an existing document --------------------------------------------------------------

export interface PlannedStep {
  base: YamlPath;
  /** The step as the document has it now; absent for a step this edit adds. */
  previous: TriggerStepFormValue | undefined;
  shorthand: boolean;
}

export interface StepLayout {
  targetBase: YamlPath;
  steps: PlannedStep[];
}

/**
 * Makes the document's step structure match the form's and says where each step now lives.
 * A `run` document stays one while the form still has just its plain step, and becomes a list
 * the moment it has more or the step needs an id, a condition or an output schema.
 */
export function patchStepLayout(
  document: Document,
  previous: readonly TriggerStepFormValue[],
  next: readonly TriggerStepFormValue[],
): StepLayout {
  if (document.has("run")) {
    const [only] = next;
    if (only !== undefined && staysShorthand(previous[0], next)) {
      return patchShorthandLayout(document, previous[0], only);
    }
    convertRunToSteps(document, previous[0]);
  }
  return patchStepList(document, previous, next);
}

/**
 * A run keeps its form while the form's step is still plain. An output schema the run already
 * had stays on it; one the form adds moves the document to a list, like an id or a condition.
 */
function staysShorthand(
  previous: TriggerStepFormValue | undefined,
  next: readonly TriggerStepFormValue[],
): boolean {
  const [only] = next;
  if (only === undefined) return false;
  const existingSchema = previous !== undefined && previous.outputSchema.trim() !== "";
  return (
    next.length === 1 &&
    only.id === SHORTHAND_STEP_ID &&
    conditionText(only.runIf) === undefined &&
    (existingSchema || only.outputSchema.trim() === "")
  );
}

function patchShorthandLayout(
  document: Document,
  previous: TriggerStepFormValue | undefined,
  next: TriggerStepFormValue,
): StepLayout {
  const kept = next.origin === 0;
  if (!kept) {
    requireWritableYaml(document, ["run"]);
    const target = document.getIn(["run", "target"], true);
    const run = document.createNode(stepDocument(next, true));
    run.items.unshift(document.createPair("target", target));
    document.set("run", run);
  }
  return {
    targetBase: ["run", "target"],
    steps: [{ base: ["run"], previous: kept ? previous : undefined, shorthand: true }],
  };
}

function convertRunToSteps(document: Document, previous: TriggerStepFormValue | undefined): void {
  requireWritableYaml(document, ["run"]);
  const run = document.get("run", true);
  if (!isMap(run)) throw new Error("Expected a run mapping.");
  const target = run.get("target", true);
  run.delete("target");
  // A list step starts a new agent unless it says otherwise; a run continued the conversation.
  if (previous?.action === "prompt" && !run.has("continuation")) {
    run.set("continuation", document.createNode({ mode: "conversation" }));
  }
  run.items.unshift(document.createPair("id", SHORTHAND_STEP_ID));
  document.delete("run");
  document.set("target", target);
  document.set("steps", document.createNode([run]));
}

function patchStepList(
  document: Document,
  previous: readonly TriggerStepFormValue[],
  next: readonly TriggerStepFormValue[],
): StepLayout {
  const sequence = document.get("steps", true);
  if (!isSeq(sequence)) throw new Error("Expected a list of steps.");
  const matches = matchSteps(previous, next);
  if (!sameStepOrder(sequence.items.length, matches)) {
    requireWritableYaml(document, ["steps"]);
    const items = next.map((step, index) => {
      const match = matches[index];
      return match === undefined
        ? document.createNode(stepDocument(step, false))
        : sequence.items[match];
    });
    sequence.items = items;
  }
  return {
    targetBase: ["target"],
    steps: next.map((_, index) => {
      const match = matches[index];
      return {
        base: ["steps", index],
        previous: match === undefined ? undefined : previous[match],
        shorthand: false,
      };
    }),
  };
}

/**
 * Match by source identity so moves and renames retain nodes and new steps start fresh.
 */
export function matchSteps(
  previous: readonly TriggerStepFormValue[],
  next: readonly TriggerStepFormValue[],
): (number | undefined)[] {
  return matchStepOrigins(previous.length, next);
}

function matchStepOrigins(
  count: number,
  next: readonly TriggerStepFormValue[],
): (number | undefined)[] {
  const claimed = new Set<number>();
  return next.map((step) => {
    const { origin } = step;
    if (origin === undefined || !Number.isInteger(origin) || origin < 0 || origin >= count) {
      return undefined;
    }
    if (claimed.has(origin)) return undefined;
    claimed.add(origin);
    return origin;
  });
}

function sameStepOrder(count: number, matches: readonly (number | undefined)[]): boolean {
  return matches.length === count && matches.every((match, index) => match === index);
}

/** Writes what changed in one step, leaving every key the form does not own as it was. */
export function patchStep(
  document: Document,
  planned: PlannedStep,
  next: TriggerStepFormValue,
): void {
  const { base, previous, shorthand } = planned;
  if (previous === undefined) return;
  if (!shorthand && previous.id !== next.id) setIfChanged(document, [...base, "id"], next.id);
  if (previous.runIf !== next.runIf) {
    setOptional(document, [...base, "if"], conditionText(next.runIf));
  }
  patchOutputSchema(document, base, previous, next);
  const actionChanged = previous.action !== next.action;
  if (actionChanged || previous.maxRuntime !== next.maxRuntime) {
    setIfChanged(document, [...base, "max_runtime"], next.maxRuntime.trim());
  }
  if (next.action === "script") {
    patchScript(document, planned, next);
    return;
  }
  if (actionChanged) deleteIfPresent(document, [...base, "script"]);
  patchAgentStep(document, planned, next);
}

function patchOutputSchema(
  document: Document,
  base: YamlPath,
  previous: TriggerStepFormValue,
  next: TriggerStepFormValue,
): void {
  if (next.action === "script") {
    deleteIfPresent(document, [...base, "output"]);
    return;
  }
  if (previous.action === next.action && previous.outputSchema === next.outputSchema) return;
  const schema = parseOutputSchema(next.outputSchema);
  if (schema === undefined) deleteIfPresent(document, [...base, "output"]);
  else setIfChanged(document, [...base, "output", "schema"], schema);
}

const AGENT_ONLY_KEYS = [
  "agent",
  "prompt",
  "continuation",
  "idle_timeout",
  "startup_timeout",
  "github",
  "env",
  "title",
  "output",
  "outputs",
  "auto_archive",
  "background",
  "complete_on_turn_end",
];

function patchScript(document: Document, planned: PlannedStep, next: TriggerStepFormValue): void {
  const { base, previous } = planned;
  const actionChanged = previous?.action !== next.action;
  if (actionChanged) {
    for (const key of AGENT_ONLY_KEYS) {
      deleteIfPresent(document, [...base, key]);
    }
  }
  if (actionChanged || previous?.script !== next.script) {
    setIfChanged(document, [...base, "script"], next.script);
  }
}

function patchAgentStep(
  document: Document,
  { base, previous, shorthand }: PlannedStep,
  next: TriggerStepFormValue,
): void {
  const before = previous ?? next;
  const changed = (...fields: TriggerStepField[]) =>
    before.action !== next.action || fields.some((field) => before[field] !== next[field]);
  patchAgentSettings(document, base, next, changed);
  if (changed("continuationMode", "continuationKey")) {
    if (!shorthand && next.continuationMode === "new") {
      deleteIfPresent(document, [...base, "continuation"]);
    } else {
      setIfChanged(document, [...base, "continuation"], formContinuation(next));
    }
  }
  if (changed("idleTimeout")) {
    setIfChanged(document, [...base, "idle_timeout"], next.idleTimeout.trim());
  }
  if (changed("completeOnTurnEnd")) {
    setOptional(document, [...base, "complete_on_turn_end"], next.completeOnTurnEnd || undefined);
  }
  if (changed("githubConnection", "githubRepositories", "githubPermissions", "githubDuration")) {
    patchGitHubAuthority(document, base, next);
  }
  if (changed("prompt")) setIfChanged(document, [...base, "prompt"], next.prompt);
}

function patchAgentSettings(
  document: Document,
  base: YamlPath,
  next: TriggerStepFormValue,
  changed: (...fields: TriggerStepField[]) => boolean,
): void {
  if (changed("agent")) {
    const agent = splitAgentId(next.agent);
    setIfChanged(document, [...base, "agent", "provider"], agent.provider);
    setOptional(document, [...base, "agent", "model"], agent.model);
  }
  if (changed("mode")) setIfChanged(document, [...base, "agent", "mode"], next.mode.trim());
  if (changed("thinkingOptionId")) {
    setOptional(
      document,
      [...base, "agent", "thinkingOptionId"],
      blankToUndefined(next.thinkingOptionId),
    );
  }
  if (changed("providerOptions")) {
    setOptional(
      document,
      [...base, "agent", "options"],
      parseProviderOptions(next.providerOptions),
    );
  }
}

function patchGitHubAuthority(
  document: Document,
  base: YamlPath,
  step: TriggerStepFormValue,
): void {
  const path = [...base, "github"];
  const github = githubAuthority(step);
  if (github === undefined || !isMap(document.getIn(path, true))) {
    setOptional(document, path, github);
    return;
  }
  setIfChanged(document, [...path, "connection"], github.connection);
  setOptional(document, [...path, "repositories"], github.repositories);
  setOptional(document, [...path, "permissions"], github.permissions);
  setOptional(document, [...path, "duration"], github.duration);
}

// -- YAML anchors -------------------------------------------------------------------------------

export function stepOrderMetadata(source: Document, yaml: string): StepOrderMetadata {
  const sequence = source.get("steps", true);
  if (!isSeq(sequence)) return {};
  const aliases = yamlAliases(source);
  if (aliases.size === 0) return {};
  return {
    stepOrderSource: {
      yaml,
      count: sequence.items.length,
      shared: sharedYamlPath(source, ["steps"], aliases),
    },
  };
}

function prospectiveStepOrderError(
  yaml: string,
  matches: readonly (number | undefined)[],
): string | undefined {
  const document = parseDocument(yaml, { compat: ["timestamp"] });
  const sequence = document.get("steps", true);
  if (!isSeq(sequence)) return undefined;
  const aliases = yamlAliases(document);
  sequence.items = matches.map((match) => (match === undefined ? null : sequence.items[match]));
  return yamlAliasTargetsChanged(document, aliases)
    ? "This change would break a YAML alias. Edit the anchor or alias in YAML first."
    : undefined;
}

const STEP_FIELD_PATHS: [TriggerStepField, ...string[]][] = [
  ["id", "id"],
  ["runIf", "if"],
  ["outputSchema", "output"],
  ["agent", "agent", "provider"],
  ["agent", "agent", "model"],
  ["mode", "agent", "mode"],
  ["thinkingOptionId", "agent", "thinkingOptionId"],
  ["providerOptions", "agent", "options"],
  ["continuationMode", "continuation"],
  ["continuationKey", "continuation"],
  ["maxRuntime", "max_runtime"],
  ["idleTimeout", "idle_timeout"],
  ["completeOnTurnEnd", "complete_on_turn_end"],
  ["githubConnection", "github", "connection"],
  ["githubRepositories", "github", "repositories"],
  ["githubPermissions", "github", "permissions"],
  ["githubDuration", "github", "duration"],
  ["prompt", "prompt"],
  ["script", "script"],
];

/** The fields of one step that another node of the document shares through a YAML anchor. */
export function sharedStepFields(source: Document, base: YamlPath): TriggerStepField[] {
  const aliases = yamlAliases(source);
  const shared = new Set<TriggerStepField>();
  for (const [field, ...path] of STEP_FIELD_PATHS) {
    if (sharedYamlPath(source, [...base, ...path], aliases)) shared.add(field);
  }
  return [...shared];
}
