import {
  recurrenceSummary,
  RecurrenceSchema,
  DEFAULT_RECURRENCE,
  type Recurrence,
} from "../schedule/recurrence.js";
import { hasProgressDestination, PROGRESS_DESTINATION_REQUIRED } from "../progress-events.js";
import { isAlias, isMap, isScalar, parseDocument, stringify, type Document } from "yaml";
import { z } from "zod";
import { parseTriggerDocument } from "./document.js";
import {
  addStep,
  changeStepAction,
  earlierStepOutputs,
  firstStep,
  patchFirstStep,
  hasScriptStep,
  isShorthandSteps,
  moveStep,
  newStepFormValue,
  patchStep,
  patchStepLayout,
  projectSteps,
  remapStepErrors,
  removeStep,
  sharedStepFields,
  stepDocument,
  stepFormErrors,
  type TriggerAction,
  type TriggerStepField,
  type TriggerStepFormValue,
} from "./editor-steps.js";
import { blankToUndefined, commaSeparated, incompleteReason, refused } from "./editor-text.js";
import {
  assertDocument,
  deleteIfPresent,
  sameValue,
  setIfChanged,
  setOptional,
  SHARED_YAML_FIELD,
  sharedYamlPath,
  yamlAliases,
} from "./editor-yaml.js";
import {
  IDENTIFIER,
  TriggerDocumentSchema,
  TriggerFilterSchema,
  type TriggerDocument,
} from "./schema.js";
import { normalizeSteps } from "./steps.js";

import {
  eventDefinition,
  hasReplyDestination,
  isEditorEvent,
  replyMessageError,
  SCRIPT_NOTIFICATION_REASONS,
  type EditorEvent,
  type QualifierValues,
  type QualifierDefinition,
  type QualifierKey,
} from "./events.js";

export {
  addStep,
  changeStepAction,
  earlierStepOutputs,
  firstStep,
  patchFirstStep,
  moveStep,
  newStepFormValue,
  remapStepErrors,
  removeStep,
  SHARED_YAML_FIELD,
};
export type { TriggerAction, TriggerStepField, TriggerStepFormValue };
export { joinAgentId, parseProviderOptions, splitAgentId } from "./editor-text.js";

export interface TriggerFormValue {
  name: string;
  enabled: boolean;
  progressMessage?: boolean;
  replyMessage?: boolean;
  event: EditorEvent;
  connection: string;
  allowedUsers: string;
  manualNoCallers?: boolean;
  qualifiers: QualifierValues;
  advancedFilters?: string[];
  sharedFields?: TriggerFormField[];
  recurrence?: Recurrence;
  daemon: string;
  cwd: string;
  /** The whole-run deadline. Empty leaves it to the steps' own limits. */
  runMaxRuntime: string;
  /** What the trigger runs, in order. One plain step is written as `run`, several as `steps`. */
  steps: TriggerStepFormValue[];
}

export type TriggerFormField =
  | keyof TriggerFormValue
  | `qualifiers.${QualifierKey}`
  | `steps.${number}.${TriggerStepField}`;

const STEP_FIELD_KEY = /^steps\.(\d+)\.(.+)$/u;

/** Whether a field, or a field of one step, is shared with another through a YAML anchor. */
export function sharedYamlField(
  form: TriggerFormValue,
  field: TriggerFormField,
): { disabled?: true; description?: string } {
  const step = STEP_FIELD_KEY.exec(field);
  const shared =
    step === null
      ? form.sharedFields?.includes(field) === true
      : (form.steps[Number(step[1])]?.sharedFields as readonly string[] | undefined)?.includes(
          step[2] ?? "",
        ) === true;
  return shared ? { disabled: true, description: SHARED_YAML_FIELD } : {};
}

const GITHUB_TEXT_KEYS: readonly QualifierKey[] = ["pattern", "contains", "exclude_contains"];

export type TriggerFormProjection =
  | { status: "editable"; value: TriggerFormValue }
  | { status: "yaml_only"; reason: string };

export function projectTriggerForm(yaml: string): TriggerFormProjection {
  const parsed = parseEditorDocument(yaml);
  if (!parsed.success) return { status: "yaml_only", reason: parsed.error };
  const events = Object.entries(parsed.data.on);
  const [entry] = events;
  if (events.length !== 1 || entry === undefined) {
    return { status: "yaml_only", reason: "The form supports exactly one event." };
  }
  return projectEditorEvent(parsed, entry);
}

function projectEditorEvent(
  parsed: ParsedEditorDocument,
  [event, definition]: [string, TriggerDocument["on"][string]],
): TriggerFormProjection {
  const trigger = parsed.data;
  if (!isEditorEvent(event)) {
    return { status: "yaml_only", reason: `The form does not support the ${event} event.` };
  }
  const ownedKeys = eventFilterKeys(event);
  const advancedFilters = [
    ...Object.keys(definition.filters ?? {}),
    ...parsed.unknownFilters,
  ].filter((key) => !ownedKeys.has(key));
  const sharedFields = sharedTriggerFields(parsed.source, event);
  const metadata = {
    ...(advancedFilters.length === 0 ? {} : { advancedFilters }),
    ...(sharedFields.length === 0 ? {} : { sharedFields }),
  };
  const { target, steps, shorthand } = normalizeSteps(trigger);
  const projected = projectSteps(steps);
  if (projected === undefined) {
    return { status: "yaml_only", reason: "Agent choices can only be edited in YAML." };
  }
  const value: TriggerFormValue = {
    ...toBaseFormValue(trigger, event, definition),
    daemon: target.daemon,
    cwd: target.cwd,
    runMaxRuntime: trigger.max_runtime ?? "",
    steps: projected.map((step, index) =>
      withSharedFields(
        step,
        sharedStepFields(parsed.source, shorthand ? ["run"] : ["steps", index]),
      ),
    ),
    ...metadata,
  };
  return { status: "editable", value };
}

function withSharedFields(
  step: TriggerStepFormValue,
  shared: TriggerStepField[],
): TriggerStepFormValue {
  return shared.length === 0 ? step : { ...step, sharedFields: shared };
}

function sharedTriggerFields(source: Document, event: EditorEvent): TriggerFormField[] {
  const aliases = yamlAliases(source);
  if (aliases.size === 0) return [];

  const eventPath = ["on", event];
  const targetBase = source.has("run") ? ["run", "target"] : ["target"];
  const fields: [TriggerFormField, ...string[]][] = [
    ["name", "name"],
    ["enabled", "enabled"],
    ["progressMessage", "progress_message"],
    ["replyMessage", "reply_message"],
    ["event", "on"],
    ["connection", ...eventPath, "connection"],
    ["allowedUsers", ...eventPath, "filters", "from_users"],
    ["recurrence", ...eventPath, "recurrence"],
    ["daemon", ...targetBase, "daemon"],
    ["cwd", ...targetBase, "cwd"],
    ["runMaxRuntime", "max_runtime"],
    ["steps", "steps"],
  ];
  const definition = eventDefinition(event);
  const keys = new Set(definition.qualifiers.map(({ key }) => key));
  if (definition.provider === "github") {
    for (const key of GITHUB_TEXT_KEYS) keys.add(key);
  }
  for (const key of keys) fields.push([`qualifiers.${key}`, ...eventPath, "filters", key]);
  const shared = new Set<TriggerFormField>();
  for (const [field, ...path] of fields) {
    if (sharedYamlPath(source, path, aliases, field !== "event")) shared.add(field);
  }
  return [...shared];
}

function toBaseFormValue(
  trigger: TriggerDocument,
  event: EditorEvent,
  definition: TriggerDocument["on"][string],
) {
  return {
    name: trigger.name,
    enabled: trigger.enabled,
    ...messageFormFields(trigger),
    event,
    connection: definition.connection ?? "",
    allowedUsers: definition.filters?.from_users?.join(", ") ?? defaultAudience(event),
    ...(event === "manual.run" && definition.filters?.from_users?.length === 0
      ? { manualNoCallers: true }
      : {}),
    qualifiers: readQualifiers(event, definition.filters),
    recurrence: definition.recurrence ?? DEFAULT_RECURRENCE,
  };
}

function messageFormFields(trigger: TriggerDocument) {
  return {
    ...(trigger.progress_message === undefined
      ? {}
      : { progressMessage: trigger.progress_message }),
    ...(trigger.reply_message === undefined ? {} : { replyMessage: trigger.reply_message }),
  };
}

/** Patch only form-owned YAML nodes, retaining comments, ordering, and advanced nodes. */
export function patchTriggerYaml(yaml: string, value: TriggerFormValue): string {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const previous = projection.value;
  const unchanged = sameFormValue(previous, value);
  if (unchanged && value.progressMessage !== false && value.replyMessage !== false) return yaml;
  if (!unchanged) validateFormValue(value);

  const document = parseDocument(yaml, { compat: ["timestamp"] });
  assertDocument(document);
  patchMessageFlags(document, previous, value);
  if (unchanged) return document.toString({ lineWidth: 0 });
  if (previous.name !== value.name) setIfChanged(document, ["name"], value.name);
  if (previous.enabled !== value.enabled) setIfChanged(document, ["enabled"], value.enabled);
  patchEvent(document, previous, value);
  patchRun(document, previous, value);
  return document.toString({ lineWidth: 0 });
}

function patchMessageFlags(
  document: Document,
  previous: TriggerFormValue,
  value: TriggerFormValue,
) {
  for (const [field, key] of [
    ["progressMessage", "progress_message"],
    ["replyMessage", "reply_message"],
  ] as const) {
    const path = [key];
    const linked = previous.sharedFields?.includes(field) || isAlias(document.getIn(path, true));
    if (!linked || previous[field] !== value[field])
      setOptional(document, path, value[field] === true ? true : undefined);
  }
}

function patchRun(document: Document, previous: TriggerFormValue, next: TriggerFormValue): void {
  if (previous.runMaxRuntime !== next.runMaxRuntime) {
    setOptional(document, ["max_runtime"], blankToUndefined(next.runMaxRuntime));
  }
  const layout = patchStepLayout(document, previous.steps, next.steps);
  if (previous.daemon !== next.daemon) {
    setIfChanged(document, [...layout.targetBase, "daemon"], next.daemon);
  }
  if (previous.cwd !== next.cwd) setIfChanged(document, [...layout.targetBase, "cwd"], next.cwd);
  for (const [index, planned] of layout.steps.entries()) {
    const step = next.steps[index];
    if (step !== undefined) patchStep(document, planned, step);
  }
}

function patchEvent(document: Document, previous: TriggerFormValue, next: TriggerFormValue) {
  const changed = previous.event !== next.event;
  if (changed) renameEvent(document, previous.event, next.event);

  const eventPath = ["on", next.event];
  patchEventConnection(document, [...eventPath, "connection"], { previous, next, changed });
  if (changed || !sameValue(previous.recurrence, next.recurrence)) {
    setOptional(
      document,
      [...eventPath, "recurrence"],
      next.event === "schedule.tick" ? (next.recurrence ?? DEFAULT_RECURRENCE) : undefined,
    );
  }
  const filterPath = [...eventPath, "filters"];
  if (next.event === "schedule.tick") deleteIfPresent(document, filterPath);
  else patchEventFilters(document, filterPath, previous, next);
}

function patchEventConnection(
  document: Document,
  path: string[],
  {
    previous,
    next,
    changed,
  }: { previous: TriggerFormValue; next: TriggerFormValue; changed: boolean },
): void {
  if (eventDefinition(next.event).origin === "hub") {
    if (changed) deleteIfPresent(document, path);
  } else if (changed || previous.connection !== next.connection) {
    setIfChanged(document, path, next.connection);
  }
}

function renameEvent(document: Document, previous: EditorEvent, next: EditorEvent): void {
  if (sharedYamlPath(document, ["on"], yamlAliases(document), false)) {
    throw new Error(SHARED_YAML_FIELD);
  }
  const events = document.getIn(["on"], true);
  if (!isMap(events)) throw new Error("Expected an event mapping.");
  const entry = events.items.find(({ key }) => isScalar(key) && key.value === previous);
  if (!isScalar(entry?.key)) throw new Error("Expected an event name.");
  entry.key.value = next;
}

function patchEventFilters(
  document: Document,
  path: string[],
  previous: TriggerFormValue,
  next: TriggerFormValue,
): void {
  const after = eventDefinition(next.event);
  const sameProvider = eventDefinition(previous.event).provider === after.provider;
  removeAdvancedFilters(document, path, { previous, next, sameProvider });
  const owned = eventFilterKeys(next.event);
  for (const key of eventFilterKeys(previous.event)) {
    if (!owned.has(key) || !sameProvider) deleteIfPresent(document, [...path, key]);
  }
  if (needsActorFilter(next) && audienceChanged(previous, next)) {
    setOptional(document, [...path, "from_users"], authoredAudience(next));
  }
  for (const qualifier of after.qualifiers) {
    const draft = next.qualifiers[qualifier.key];
    if (!sameProvider || previous.qualifiers[qualifier.key] !== draft) {
      setOptional(document, [...path, qualifier.key], authoredQualifier(qualifier, draft));
    }
  }
}

function removeAdvancedFilters(
  document: Document,
  path: string[],
  {
    previous,
    next,
    sameProvider,
  }: { previous: TriggerFormValue; next: TriggerFormValue; sameProvider: boolean },
): void {
  for (const key of previous.advancedFilters ?? []) {
    if (sameProvider && carriedGitHubText(next, key)) continue;
    if (previous.event !== next.event || next.advancedFilters?.length === 0) {
      deleteIfPresent(document, [...path, key]);
    }
  }
}

function audienceChanged(previous: TriggerFormValue, next: TriggerFormValue): boolean {
  return (
    (previous.event !== next.event &&
      eventDefinition(previous.event).provider !== eventDefinition(next.event).provider) ||
    previous.allowedUsers !== next.allowedUsers ||
    previous.manualNoCallers !== next.manualNoCallers
  );
}

export type TriggerYamlResult =
  | { status: "ok"; yaml: string }
  | { status: "invalid_document"; yaml: string; reason: string }
  | { status: "incomplete"; reason: string };

/**
 * The YAML a form amounts to: the canonical document patched where one exists, a fresh document
 * where it does not.
 *
 * A half-filled trigger has no document at all — `run.target.daemon` and `run.agent.provider` have
 * no empty representation — so the caller is told which field is still missing. Handing back a
 * reason rather than throwing is what lets a screen disable the YAML view and say why beside the
 * control, instead of surfacing a stray exception somewhere far from the field that caused it.
 */
export function mergeTriggerForm(yaml: string, value: TriggerFormValue): TriggerYamlResult {
  let patched: string;
  try {
    patched = yaml.trim() === "" ? createTriggerYaml(value) : patchTriggerYaml(yaml, value);
  } catch (cause) {
    return { status: "incomplete", reason: incompleteReason(cause) };
  }
  try {
    parseTriggerDocument(patched);
    return { status: "ok", yaml: patched };
  } catch (cause) {
    return { status: "invalid_document", yaml: patched, reason: incompleteReason(cause) };
  }
}

export function createTriggerYaml(value: TriggerFormValue): string {
  validateFormValue(value);
  const trigger = {
    name: value.name,
    enabled: value.enabled,
    on: { [value.event]: formEventDefinition(value) },
    ...(value.progressMessage === true ? { progress_message: true } : {}),
    ...(value.replyMessage === true ? { reply_message: true } : {}),
  };
  const runMaxRuntime = blankToUndefined(value.runMaxRuntime);
  const target = { daemon: value.daemon, cwd: value.cwd };
  const document = {
    ...trigger,
    ...(runMaxRuntime === undefined ? {} : { max_runtime: runMaxRuntime }),
    ...(isShorthandSteps(value.steps)
      ? { run: { target, ...stepDocument(firstStep(value), true) } }
      : { target, steps: value.steps.map((step) => stepDocument(step, false)) }),
  };
  return stringify(document, { lineWidth: 0, compat: ["timestamp"] });
}

function formEventDefinition(value: TriggerFormValue): TriggerDocument["on"][string] {
  if (value.event === "schedule.tick")
    return { recurrence: value.recurrence ?? DEFAULT_RECURRENCE };
  const definition = eventDefinition(value.event);
  const filters = Object.fromEntries(
    definition.qualifiers.flatMap((qualifier) => {
      const selection = authoredQualifier(qualifier, value.qualifiers[qualifier.key]);
      return selection === undefined ? [] : [[qualifier.key, selection]];
    }),
  );
  const audience = authoredAudience(value);
  if (audience !== undefined) filters["from_users"] = audience;
  return {
    ...(definition.origin === "provider" ? { connection: value.connection } : {}),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
  };
}

export function needsActorFilter(value: Pick<TriggerFormValue, "event">): boolean {
  return eventDefinition(value.event).audience !== "none";
}

function defaultAudience(event: EditorEvent): string {
  return eventDefinition(event).audience === "wildcard" ? "*" : "";
}

function authoredAudience(value: TriggerFormValue): string[] | undefined {
  if (!needsActorFilter(value)) return undefined;
  const names = commaSeparated(value.allowedUsers);
  if (isManualNoCallers(value)) return [];
  if (value.event === "manual.run" && names.length === 1 && names[0] === "*") return undefined;
  return names.length === 0 ? undefined : names;
}

export function isManualNoCallers(value: TriggerFormValue): boolean {
  return (
    value.event === "manual.run" &&
    !hasScriptStep(value) &&
    value.manualNoCallers === true &&
    value.allowedUsers === ""
  );
}

function eventFilterKeys(event: EditorEvent): Set<string> {
  return new Set([
    ...eventDefinition(event).qualifiers.map(({ key }) => key),
    ...(needsActorFilter({ event }) ? ["from_users"] : []),
  ]);
}

function workingDirectoryErrors(value: TriggerFormValue): TriggerFieldErrors {
  const cwd = value.cwd.trim();
  if (cwd.length === 0) return { cwd: "Working directory is required." };
  return cwd.startsWith("/") ? {} : { cwd: "Working directory must be an absolute path." };
}

function progressMessageErrors(value: TriggerFormValue): TriggerFieldErrors {
  return value.progressMessage === true && !hasProgressDestination(value.event)
    ? { progressMessage: PROGRESS_DESTINATION_REQUIRED }
    : {};
}

function recurrenceErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (value.event !== "schedule.tick") return {};
  const parsed = RecurrenceSchema.safeParse(value.recurrence ?? DEFAULT_RECURRENCE);
  if (parsed.success) return {};
  const [issue] = parsed.error.issues;
  if (issue === undefined)
    throw new TypeError("Cannot read properties of undefined (reading 'message')");
  return { recurrence: issue.message };
}

/** What is wrong with each field, keyed by the field that has to change. */
export type TriggerFieldErrors = Partial<Record<TriggerFormField, string>>;

/**
 * Every reason this form cannot become a trigger document, addressed to the field that owns it.
 *
 * One list, because a form that refuses to submit and a form that marks its fields have to agree
 * about why: the same call feeds the errors drawn beside each control and the single sentence
 * `mergeTriggerForm` reports when the document cannot be written at all. Insertion order is the
 * order the fields appear on screen, so "the first problem" is the topmost one.
 */
export function triggerFormErrors(value: TriggerFormValue): TriggerFieldErrors {
  const errors = triggerEventErrors(value);
  if (value.daemon.trim().length === 0) errors.daemon = "Daemon is required.";
  Object.assign(errors, workingDirectoryErrors(value));
  Object.assign(errors, stepFormErrors(value.steps));
  return errors;
}

function triggerEventErrors(value: TriggerFormValue): TriggerFieldErrors {
  const errors: TriggerFieldErrors = {};
  const name = value.name.trim();
  if (name.length === 0) errors.name = "Trigger name is required.";
  else if (!IDENTIFIER.test(name)) {
    errors.name = "Use lowercase letters, digits, and hyphens, starting with a letter.";
  }
  if (eventDefinition(value.event).origin === "provider") {
    if (value.connection.trim().length === 0) errors.connection = "Connection is required.";
  }
  Object.assign(errors, progressMessageErrors(value));
  if (value.replyMessage === true) {
    const error = replyMessageError(value.event, commaSeparated(value.allowedUsers));
    if (error !== undefined) errors.replyMessage = error;
  }
  if (needsActorFilter(value)) Object.assign(errors, actorErrors(value));
  Object.assign(errors, qualifierErrors(value));
  Object.assign(errors, scriptEventErrors(value));
  Object.assign(errors, recurrenceErrors(value));
  return errors;
}

function qualifierErrors(value: TriggerFormValue): TriggerFieldErrors {
  const errors: TriggerFieldErrors = {};
  for (const qualifier of eventDefinition(value.event).qualifiers) {
    const selection = value.qualifiers[qualifier.key];
    const error =
      qualifier.required && (selection === undefined || selection.trim().length === 0)
        ? `${qualifier.label} is required.`
        : refused(() => authoredQualifier(qualifier, selection));
    if (error !== undefined) errors[`qualifiers.${qualifier.key}`] = error;
  }
  return errors;
}

function actorErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (isManualNoCallers(value)) return {};
  const named = commaSeparated(value.allowedUsers);
  if (hasScriptStep(value)) {
    return named.length === 0 || named.includes("*")
      ? { allowedUsers: "Name the people allowed to start a script. It cannot run for everyone." }
      : {};
  }
  const audience = eventDefinition(value.event).audience;
  if (audience === "wildcard") {
    return named.length === 0
      ? { allowedUsers: "Name at least one caller, or let everyone trigger it." }
      : {};
  }
  return named.includes("*") || (audience === "named" && named.length === 0)
    ? { allowedUsers: "Enter specific Linear user IDs." }
    : {};
}

/** A notification has no actor, so a script on it must narrow by repository or reason. */
function scriptEventErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (!hasScriptStep(value)) return {};
  if (value.event !== "github.notification") return {};
  const errors: TriggerFieldErrors = {};
  const repo = value.qualifiers.repo?.trim() ?? "";
  const reason = value.qualifiers.reason?.trim() ?? "";
  const allowed = SCRIPT_NOTIFICATION_REASONS.join(", ");
  if (repo === "") {
    errors["qualifiers.repo"] =
      "A script on a notification needs a repository, so unrelated notifications cannot run code.";
  }
  if (reason === "") {
    errors["qualifiers.reason"] = `A script on a notification needs a reason: ${allowed}.`;
  } else if (!(SCRIPT_NOTIFICATION_REASONS as readonly string[]).includes(reason)) {
    errors["qualifiers.reason"] =
      `A script cannot run for "${reason}": third parties can cause that notification. Use one of ${allowed}.`;
  }
  return errors;
}

function validateFormValue(value: TriggerFormValue): void {
  const [message] = Object.values(triggerFormErrors(value));
  if (message !== undefined) throw new Error(message);
}

const EditorEventFiltersSchema = z.looseObject({
  on: z.record(
    z.string(),
    z.looseObject({ filters: z.record(z.string(), z.unknown()).optional() }),
  ),
});

interface ParsedEditorDocument {
  success: true;
  data: TriggerDocument;
  unknownFilters: string[];
  source: Document;
}

function parseEditorDocument(
  yaml: string,
): ParsedEditorDocument | { success: false; error: string } {
  const document = parseDocument(yaml, { compat: ["timestamp"] });
  const [error] = document.errors;
  if (error !== undefined) return { success: false, error: error.message };
  const raw: unknown = document.toJS();
  const parsed = TriggerDocumentSchema.safeParse(raw);
  if (parsed.success)
    return { success: true, data: parsed.data, unknownFilters: [], source: document };

  return projectUnknownFilters(raw, document) ?? editorSchemaError(parsed.error);
}

function editorSchemaError(error: z.ZodError): { success: false; error: string } {
  const [issue] = error.issues;
  if (issue === undefined)
    throw new TypeError("Cannot read properties of undefined (reading 'path')");
  return { success: false, error: `${issue.path.join(".") || "YAML"}: ${issue.message}` };
}

// The editor can preserve unrecognized filter nodes without extending the saved schema.
function projectUnknownFilters(raw: unknown, document: Document): ParsedEditorDocument | undefined {
  const shape = EditorEventFiltersSchema.safeParse(raw);
  const events = shape.success ? Object.entries(shape.data.on) : [];
  const [entry] = events;
  if (!shape.success || events.length !== 1 || entry === undefined) return undefined;
  const [event, definition] = entry;
  const entries = Object.entries(definition.filters ?? {});
  const unknownFilters = entries
    .filter(([key]) => !Object.hasOwn(TriggerFilterSchema.shape, key))
    .map(([key]) => key);
  if (unknownFilters.length === 0) return undefined;
  const filters = Object.fromEntries(
    entries.filter(([key]) => Object.hasOwn(TriggerFilterSchema.shape, key)),
  );
  const projected = TriggerDocumentSchema.safeParse({
    ...shape.data,
    on: { [event]: { ...definition, filters } },
  });
  return projected.success
    ? { success: true, data: projected.data, unknownFilters, source: document }
    : undefined;
}

function sameFormValue(left: TriggerFormValue, right: TriggerFormValue): boolean {
  return sameValue(left, right);
}

/** Provider-bound state and qualifier compatibility belong to the form model. */
export function changeTriggerEvent(value: TriggerFormValue, event: EditorEvent): TriggerFormValue {
  if (value.event === event) return value;
  const previous = eventDefinition(value.event);
  const next = eventDefinition(event);
  const sameProvider = previous.provider === next.provider;
  const qualifiers = sameProvider ? carriedQualifiers(value, previous, next) : {};
  const namedAudience = value.allowedUsers !== "" && value.allowedUsers !== "*";
  const nextAudience = namedAudience ? "" : defaultAudience(event);
  const result = {
    ...value,
    event,
    qualifiers,
    allowedUsers: sameProvider ? value.allowedUsers : nextAudience,
    connection: sameProvider ? value.connection : "",
    ...(event === "schedule.tick" ? {} : { recurrence: DEFAULT_RECURRENCE }),
    ...disabledMessageFields(value, event),
  };
  if (value.advancedFilters !== undefined) result.advancedFilters = [];
  delete result.manualNoCallers;
  return result;
}

function carriedQualifiers(
  value: TriggerFormValue,
  previous: ReturnType<typeof eventDefinition>,
  next: ReturnType<typeof eventDefinition>,
): QualifierValues {
  const qualifiers: QualifierValues = {};
  for (const qualifier of next.qualifiers) {
    const compatible =
      (next.provider === "github" && GITHUB_TEXT_KEYS.includes(qualifier.key)) ||
      previous.qualifiers.some(
        (candidate) => candidate.key === qualifier.key && candidate.kind === qualifier.kind,
      );
    if (!compatible) continue;
    const selection = value.qualifiers[qualifier.key];
    if (selection !== undefined) qualifiers[qualifier.key] = selection;
  }
  return qualifiers;
}

function disabledMessageFields(value: TriggerFormValue, event: EditorEvent) {
  return {
    ...(value.progressMessage === true && !hasProgressDestination(event)
      ? { progressMessage: false }
      : {}),
    ...(value.replyMessage === true && !hasReplyDestination(event) ? { replyMessage: false } : {}),
  };
}

export function droppedTriggerRules(previous: TriggerFormValue, next: TriggerFormValue): string[] {
  if (previous.event === next.event) return [];
  const before = eventDefinition(previous.event);
  const after = eventDefinition(next.event);
  const sameProvider = before.provider === after.provider;
  const dropped = before.qualifiers
    .filter(
      ({ key }) => previous.qualifiers[key] !== undefined && next.qualifiers[key] === undefined,
    )
    .map(({ label }) => label);
  dropped.push(
    ...(previous.advancedFilters ?? []).filter(
      (key) => !sameProvider || !carriedGitHubText(next, key),
    ),
  );
  if (!sameProvider && previous.connection !== "") dropped.push("Connection");
  if (!sameProvider && hasAuthoredAudience(previous)) dropped.push("Audience");
  appendDroppedEventOptions(dropped, previous, next);
  return dropped;
}

function hasAuthoredAudience(previous: TriggerFormValue): boolean {
  return (
    needsActorFilter(previous) &&
    (isManualNoCallers(previous) || (previous.allowedUsers !== "" && previous.allowedUsers !== "*"))
  );
}

function appendDroppedEventOptions(
  dropped: string[],
  previous: TriggerFormValue,
  next: TriggerFormValue,
): void {
  if (previous.event === "schedule.tick" && next.event !== previous.event) dropped.push("Schedule");
  if (previous.progressMessage === true && next.progressMessage === false) {
    dropped.push("Live progress messages");
  }
  if (previous.replyMessage === true && next.replyMessage === false) dropped.push("Agent reply");
}

function carriedGitHubText(value: TriggerFormValue, key: string): boolean {
  const definition = eventDefinition(value.event);
  return (
    definition.provider === "github" &&
    definition.qualifiers.some(
      (qualifier) =>
        qualifier.key === key &&
        GITHUB_TEXT_KEYS.includes(qualifier.key) &&
        value.qualifiers[qualifier.key] !== undefined,
    )
  );
}

function readQualifiers(
  event: EditorEvent,
  filters: TriggerDocument["on"][string]["filters"],
): QualifierValues {
  const values: QualifierValues = {};
  const definition = eventDefinition(event);
  if (definition.provider === "github") {
    for (const key of GITHUB_TEXT_KEYS) {
      const value = filters?.[key];
      if (typeof value === "string") values[key] = value;
    }
  }
  for (const qualifier of definition.qualifiers) {
    const value = filters?.[qualifier.key];
    if (Array.isArray(value)) values[qualifier.key] = value.join("\n");
    else if (typeof value === "string") values[qualifier.key] = value;
    else if (value !== undefined) values[qualifier.key] = JSON.stringify(value, null, 2);
  }
  return values;
}

function authoredQualifier(qualifier: QualifierDefinition, value: string | undefined) {
  if (value === undefined || value === "") return undefined;
  if (qualifier.kind === "list") {
    const entries = value.split("\n").filter((entry) => entry.trim() !== "");
    return entries.length === 0 ? undefined : entries;
  }
  return qualifier.kind === "inputs" ? authoredInputs(value) : authoredText(qualifier.key, value);
}

function authoredText(key: QualifierKey, value: string): string | undefined {
  return GITHUB_TEXT_KEYS.includes(key) ? value : blankToUndefined(value);
}

function authoredInputs(value: string) {
  if (value.trim() === "") return undefined;
  try {
    return TriggerFilterSchema.shape.inputs.unwrap().parse(JSON.parse(value));
  } catch {
    throw new Error("Input matches must be a JSON object with string, number, or boolean values.");
  }
}

/**
 * A trigger's event as a list row reads it: the kind first, so a schedule never passes for a
 * manual run, then what narrows it — when a schedule fires, or which connection an event
 * arrives through.
 */
export function describeTriggerEvent(
  value: TriggerFormValue | null,
  event: string,
): { kind: string; detail?: string } {
  const kind = isEditorEvent(event) ? eventDefinition(event).label : event;
  if (value?.event === "schedule.tick") {
    return { kind, detail: recurrenceSummary(value.recurrence ?? DEFAULT_RECURRENCE) };
  }
  if (value === null || value.connection === "") return { kind };
  return { kind, detail: value.connection };
}
