import {
  recurrenceSummary,
  RecurrenceSchema,
  DEFAULT_RECURRENCE,
  type Recurrence,
} from "../schedule/recurrence.js";
import { ContinuationSchema } from "../continuation.js";
import { hasProgressDestination, PROGRESS_DESTINATION_REQUIRED } from "../progress-events.js";
import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  visit,
  type Document,
  type Alias,
  type Node,
  type YAMLSeq,
} from "yaml";
import { z } from "zod";
import { parseTriggerDocument } from "./document.js";
import {
  DEFAULT_SCRIPT_MAX_RUNTIME,
  IDENTIFIER,
  isScriptRun,
  TriggerDocumentSchema,
  TriggerFilterSchema,
  type TriggerAgentRun,
  type TriggerDocument,
  type TriggerScriptRun,
} from "./schema.js";

import {
  eventDefinition,
  isEditorEvent,
  SCRIPT_NOTIFICATION_REASONS,
  type EditorEvent,
  type QualifierValues,
  type QualifierDefinition,
  type QualifierKey,
} from "./events.js";

export type TriggerAction = "prompt" | "script";

const DEFAULT_AGENT_MAX_RUNTIME = "2h";

export interface TriggerFormValue {
  name: string;
  enabled: boolean;
  progressMessage?: boolean;
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
  /** What the trigger runs: an agent prompt, or a shell script on the daemon host. */
  action: TriggerAction;
  script: string;
}

export type TriggerFormField = keyof TriggerFormValue | `qualifiers.${QualifierKey}`;

export const SHARED_YAML_FIELD =
  "This field is shared with another field through a YAML anchor. Edit it in YAML.";

export function sharedYamlField(
  form: TriggerFormValue,
  field: TriggerFormField,
): { disabled?: true; description?: string } {
  return form.sharedFields?.includes(field) === true
    ? { disabled: true, description: SHARED_YAML_FIELD }
    : {};
}

const GITHUB_TEXT_KEYS: readonly QualifierKey[] = ["pattern", "contains", "exclude_contains"];

export type TriggerFormProjection =
  | { status: "editable"; value: TriggerFormValue }
  | { status: "yaml_only"; reason: string };

const ProviderOptionsSchema = z.record(z.string(), z.unknown());
const GitHubPermissionsSchema = z.record(z.string(), z.enum(["read", "write", "admin"]));

export function projectTriggerForm(yaml: string): TriggerFormProjection {
  const parsed = parseEditorDocument(yaml);
  if (!parsed.success) return { status: "yaml_only", reason: parsed.error };
  const trigger = parsed.data;
  const events = Object.entries(trigger.on);
  if (events.length !== 1) {
    return { status: "yaml_only", reason: "The form supports exactly one event." };
  }
  const [event, definition] = events[0]!;
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
  const run = trigger.run;
  if (isScriptRun(run)) {
    return {
      status: "editable",
      value: { ...toScriptFormValue(trigger, run, event, definition), ...metadata },
    };
  }
  if ("choices" in run.agent) {
    return { status: "yaml_only", reason: "Agent choices can only be edited in YAML." };
  }
  return {
    status: "editable",
    value: { ...toFormValue(trigger, run, event, definition, run.agent), ...metadata },
  };
}

function sharedTriggerFields(source: Document, event: EditorEvent): TriggerFormField[] {
  const aliases = yamlAliases(source);
  if (aliases.size === 0) return [];

  const eventPath = ["on", event];
  const fields: [TriggerFormField, ...string[]][] = [
    ["name", "name"],
    ["enabled", "enabled"],
    ["progressMessage", "progress_message"],
    ["event", "on"],
    ["connection", ...eventPath, "connection"],
    ["allowedUsers", ...eventPath, "filters", "from_users"],
    ["recurrence", ...eventPath, "recurrence"],
    ["daemon", "run", "target", "daemon"],
    ["cwd", "run", "target", "cwd"],
    ["agent", "run", "agent", "provider"],
    ["agent", "run", "agent", "model"],
    ["mode", "run", "agent", "mode"],
    ["thinkingOptionId", "run", "agent", "thinkingOptionId"],
    ["providerOptions", "run", "agent", "options"],
    ["continuationMode", "run", "continuation"],
    ["continuationKey", "run", "continuation"],
    ["maxRuntime", "run", "max_runtime"],
    ["idleTimeout", "run", "idle_timeout"],
    ["completeOnTurnEnd", "run", "complete_on_turn_end"],
    ["githubConnection", "run", "github", "connection"],
    ["githubRepositories", "run", "github", "repositories"],
    ["githubPermissions", "run", "github", "permissions"],
    ["githubDuration", "run", "github", "duration"],
    ["prompt", "run", "prompt"],
    ["script", "run", "script"],
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
    ...(trigger.progress_message === undefined
      ? {}
      : { progressMessage: trigger.progress_message }),
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

function toScriptFormValue(
  trigger: TriggerDocument,
  run: TriggerScriptRun,
  event: EditorEvent,
  definition: TriggerDocument["on"][string],
): TriggerFormValue {
  return {
    ...toBaseFormValue(trigger, event, definition),
    daemon: run.target.daemon,
    cwd: run.target.cwd,
    agent: "",
    mode: "",
    thinkingOptionId: "",
    providerOptions: "",
    continuationMode: "conversation",
    continuationKey: "",
    maxRuntime: run.max_runtime,
    idleTimeout: "10m",
    completeOnTurnEnd: false,
    githubConnection: "",
    githubRepositories: "",
    githubPermissions: "",
    githubDuration: "",
    prompt: "",
    action: "script",
    script: run.script,
  };
}

function toFormValue(
  trigger: TriggerDocument,
  run: TriggerAgentRun,
  event: EditorEvent,
  definition: TriggerDocument["on"][string],
  agent: Extract<TriggerAgentRun["agent"], { provider: string }>,
): TriggerFormValue {
  return {
    ...toBaseFormValue(trigger, event, definition),
    daemon: run.target.daemon,
    cwd: run.target.cwd,
    agent: joinAgentId(agent.provider, agent.model),
    mode: agent.mode ?? "",
    thinkingOptionId: agent.thinkingOptionId ?? "",
    providerOptions: agent.options === undefined ? "" : JSON.stringify(agent.options, null, 2),
    continuationMode: run.continuation.mode,
    continuationKey: run.continuation.mode === "key" ? run.continuation.key : "",
    maxRuntime: run.max_runtime,
    idleTimeout: run.idle_timeout,
    completeOnTurnEnd: run.complete_on_turn_end === true,
    githubConnection: run.github?.connection ?? "",
    githubRepositories: run.github?.repositories?.join(", ") ?? "",
    githubPermissions:
      run.github?.permissions === undefined ? "" : JSON.stringify(run.github.permissions, null, 2),
    githubDuration: run.github?.duration ?? "",
    prompt: run.prompt,
    action: "prompt",
    script: "",
  };
}

/** Patch only form-owned YAML nodes, retaining comments, ordering, and advanced nodes. */
export function patchTriggerYaml(yaml: string, value: TriggerFormValue): string {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const previous = projection.value;
  const unchanged = sameFormValue(previous, value);
  if (unchanged && value.progressMessage !== false) return yaml;
  if (!unchanged) validateFormValue(value);

  const document = parseDocument(yaml, { compat: ["timestamp"] });
  assertDocument(document);
  const progressPath = ["progress_message"];
  const progressLinked =
    previous.sharedFields?.includes("progressMessage") ||
    isAlias(document.getIn(progressPath, true));
  if (!progressLinked || previous.progressMessage !== value.progressMessage) {
    setOptional(document, progressPath, value.progressMessage === true ? true : undefined);
  }
  if (unchanged) return document.toString({ lineWidth: 0 });
  if (previous.name !== value.name) setIfChanged(document, ["name"], value.name);
  if (previous.enabled !== value.enabled) setIfChanged(document, ["enabled"], value.enabled);
  patchEvent(document, previous, value);
  patchRun(document, previous, value);
  return document.toString({ lineWidth: 0 });
}

function patchRun(document: Document, previous: TriggerFormValue, next: TriggerFormValue): void {
  if (previous.daemon !== next.daemon)
    setIfChanged(document, ["run", "target", "daemon"], next.daemon);
  if (previous.cwd !== next.cwd) setIfChanged(document, ["run", "target", "cwd"], next.cwd);
  const actionChanged = previous.action !== next.action;
  if (actionChanged || previous.maxRuntime !== next.maxRuntime) {
    setIfChanged(document, ["run", "max_runtime"], next.maxRuntime.trim());
  }
  if (next.action === "script") {
    if (actionChanged) {
      for (const key of [
        "agent",
        "prompt",
        "continuation",
        "idle_timeout",
        "github",
        "complete_on_turn_end",
      ]) {
        deleteIfPresent(document, ["run", key]);
      }
    }
    if (actionChanged || previous.script !== next.script) {
      setIfChanged(document, ["run", "script"], next.script);
    }
    return;
  }
  if (actionChanged) deleteIfPresent(document, ["run", "script"]);
  patchAgentRun(document, previous, next);
}

function patchAgentRun(
  document: Document,
  previous: TriggerFormValue,
  next: TriggerFormValue,
): void {
  const changed = (...fields: (keyof TriggerFormValue)[]) =>
    previous.action !== next.action || fields.some((field) => previous[field] !== next[field]);
  if (changed("agent")) {
    const agent = splitAgentId(next.agent);
    setIfChanged(document, ["run", "agent", "provider"], agent.provider);
    setOptional(document, ["run", "agent", "model"], agent.model);
  }
  if (changed("mode")) setIfChanged(document, ["run", "agent", "mode"], next.mode.trim());
  if (changed("thinkingOptionId")) {
    setOptional(
      document,
      ["run", "agent", "thinkingOptionId"],
      blankToUndefined(next.thinkingOptionId),
    );
  }
  if (changed("providerOptions")) {
    setOptional(document, ["run", "agent", "options"], parseProviderOptions(next.providerOptions));
  }
  if (changed("continuationMode", "continuationKey")) {
    setIfChanged(document, ["run", "continuation"], formContinuation(next));
  }
  if (changed("idleTimeout")) {
    setIfChanged(document, ["run", "idle_timeout"], next.idleTimeout.trim());
  }
  if (changed("completeOnTurnEnd")) {
    setOptional(document, ["run", "complete_on_turn_end"], next.completeOnTurnEnd || undefined);
  }
  if (changed("githubConnection", "githubRepositories", "githubPermissions", "githubDuration")) {
    patchGitHubAuthority(document, next);
  }
  if (changed("prompt")) setIfChanged(document, ["run", "prompt"], next.prompt);
}

function patchGitHubAuthority(document: Document, value: TriggerFormValue): void {
  const path = ["run", "github"];
  const github = githubAuthority(value);
  if (github === undefined || !isMap(document.getIn(path, true))) {
    setOptional(document, path, github);
    return;
  }
  setIfChanged(document, [...path, "connection"], github.connection);
  setOptional(document, [...path, "repositories"], github.repositories);
  setOptional(document, [...path, "permissions"], github.permissions);
  setOptional(document, [...path, "duration"], github.duration);
}

function patchEvent(document: Document, previous: TriggerFormValue, next: TriggerFormValue) {
  const changed = previous.event !== next.event;
  if (changed) renameEvent(document, previous.event, next.event);

  const eventPath = ["on", next.event];
  if (eventDefinition(next.event).origin === "hub") {
    if (changed) deleteIfPresent(document, [...eventPath, "connection"]);
  } else if (changed || previous.connection !== next.connection) {
    setIfChanged(document, [...eventPath, "connection"], next.connection);
  }
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
  for (const key of previous.advancedFilters ?? []) {
    if (sameProvider && carriedGitHubText(next, key)) continue;
    if (previous.event !== next.event || next.advancedFilters?.length === 0) {
      deleteIfPresent(document, [...path, key]);
    }
  }
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

function incompleteReason(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "The trigger is invalid.";
}

export function createTriggerYaml(value: TriggerFormValue): string {
  validateFormValue(value);
  const trigger = {
    name: value.name,
    enabled: value.enabled,
    on: { [value.event]: formEventDefinition(value) },
    ...(value.progressMessage === true ? { progress_message: true } : {}),
  };
  if (value.action === "script") {
    return stringify(
      {
        ...trigger,
        run: {
          target: { daemon: value.daemon, cwd: value.cwd },
          script: value.script,
          max_runtime: value.maxRuntime.trim(),
        },
      },
      { lineWidth: 0, compat: ["timestamp"] },
    );
  }
  const agent = splitAgentId(value.agent);
  const providerOptions = parseProviderOptions(value.providerOptions);
  const github = githubAuthority(value);
  return stringify(
    {
      ...trigger,
      run: {
        target: { daemon: value.daemon, cwd: value.cwd },
        agent: {
          provider: agent.provider,
          ...(agent.model === undefined ? {} : { model: agent.model }),
          mode: value.mode.trim(),
          ...(blankToUndefined(value.thinkingOptionId) === undefined
            ? {}
            : { thinkingOptionId: value.thinkingOptionId.trim() }),
          ...(providerOptions === undefined ? {} : { options: providerOptions }),
        },
        continuation: formContinuation(value),
        max_runtime: value.maxRuntime.trim(),
        idle_timeout: value.idleTimeout.trim(),
        ...(value.completeOnTurnEnd ? { complete_on_turn_end: true } : {}),
        ...(github === undefined ? {} : { github }),
        prompt: value.prompt,
      },
    },
    { lineWidth: 0, compat: ["timestamp"] },
  );
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
    value.action === "prompt" &&
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
  return parsed.success ? {} : { recurrence: parsed.error.issues[0]!.message };
}

function githubAuthority(value: TriggerFormValue) {
  const connection = blankToUndefined(value.githubConnection);
  if (connection === undefined) return undefined;
  const repositories = commaSeparated(value.githubRepositories);
  const permissions = parsePermissions(value.githubPermissions);
  const duration = blankToUndefined(value.githubDuration);
  return {
    connection,
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(duration === undefined ? {} : { duration }),
  };
}

function parsePermissions(value: string): Record<string, "read" | "write" | "admin"> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GitHub permissions must be valid JSON.");
  }
  const permissions = GitHubPermissionsSchema.safeParse(parsed);
  if (!permissions.success) {
    throw new Error('GitHub permissions map a scope to "read", "write", or "admin".');
  }
  return permissions.data;
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
  if (needsActorFilter(value)) Object.assign(errors, actorErrors(value));
  Object.assign(errors, qualifierErrors(value));
  Object.assign(errors, scriptEventErrors(value));
  Object.assign(errors, recurrenceErrors(value));
  if (value.daemon.trim().length === 0) errors.daemon = "Daemon is required.";
  Object.assign(errors, workingDirectoryErrors(value));
  if (value.maxRuntime.trim().length === 0) errors.maxRuntime = "Maximum runtime is required.";
  if (value.action === "script") return Object.assign(errors, scriptErrors(value));
  if (value.idleTimeout.trim().length === 0) errors.idleTimeout = "Idle timeout is required.";
  const agent = refused(() => splitAgentId(value.agent));
  if (agent !== undefined) errors.agent = agent;
  if (value.mode.trim().length === 0) errors.mode = "Execution mode is required.";
  const options = refused(() => parseProviderOptions(value.providerOptions));
  if (options !== undefined) errors.providerOptions = options;
  if (value.githubConnection.trim().length !== 0) {
    const permissions = refused(() => parsePermissions(value.githubPermissions));
    if (permissions !== undefined) errors.githubPermissions = permissions;
  }
  Object.assign(errors, continuationErrors(value));
  if (value.prompt.trim().length === 0) errors.prompt = "Instructions are required.";
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

function scriptErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (value.script.trim().length === 0) return { script: "Script is required." };
  if (value.script.includes("${{")) {
    return {
      script:
        "Script text is not templated. Read event data from the HUB_EVENT_JSON environment variable.",
    };
  }
  return {};
}

function actorErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (isManualNoCallers(value)) return {};
  const named = commaSeparated(value.allowedUsers);
  if (value.action === "script") {
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
  if (value.action !== "script") return {};
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

/** The message a parse refused with, or `undefined` when it accepted the value. */
function refused(parse: () => unknown): string | undefined {
  try {
    parse();
    return undefined;
  } catch (cause) {
    return incompleteReason(cause);
  }
}

function validateFormValue(value: TriggerFormValue): void {
  const [message] = Object.values(triggerFormErrors(value));
  if (message !== undefined) throw new Error(message);
}

export function parseProviderOptions(value: string): Record<string, unknown> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Provider options must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Provider options must be a JSON object.");
  }
  return ProviderOptionsSchema.parse(parsed);
}

export function joinAgentId(provider: string, model: string | undefined): string {
  return model === undefined ? provider : `${provider}/${model}`;
}

export function splitAgentId(value: string): { provider: string; model?: string } {
  const normalized = value.trim();
  const separator = normalized.indexOf("/");
  if (separator < 0) {
    if (normalized.length === 0) throw new Error("Agent is required.");
    return { provider: normalized };
  }
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error("Agent must look like provider/model.");
  }
  return { provider, model };
}

const EditorEventFiltersSchema = z.looseObject({
  on: z.record(
    z.string(),
    z.looseObject({ filters: z.record(z.string(), z.unknown()).optional() }),
  ),
});

function parseEditorDocument(
  yaml: string,
):
  | { success: true; data: TriggerDocument; unknownFilters: string[]; source: Document }
  | { success: false; error: string } {
  const document = parseDocument(yaml, { compat: ["timestamp"] });
  if (document.errors.length > 0) return { success: false, error: document.errors[0]!.message };
  const raw: unknown = document.toJS();
  const parsed = TriggerDocumentSchema.safeParse(raw);
  if (parsed.success)
    return { success: true, data: parsed.data, unknownFilters: [], source: document };

  // The editor can preserve unrecognized filter nodes without extending the saved schema.
  const shape = EditorEventFiltersSchema.safeParse(raw);
  const events = shape.success ? Object.entries(shape.data.on) : [];
  if (shape.success && events.length === 1) {
    const [event, definition] = events[0]!;
    const entries = Object.entries(definition.filters ?? {});
    const unknownFilters = entries
      .filter(([key]) => !Object.hasOwn(TriggerFilterSchema.shape, key))
      .map(([key]) => key);
    if (unknownFilters.length > 0) {
      const filters = Object.fromEntries(
        entries.filter(([key]) => Object.hasOwn(TriggerFilterSchema.shape, key)),
      );
      const projected = TriggerDocumentSchema.safeParse({
        ...shape.data,
        on: { [event]: { ...definition, filters } },
      });
      if (projected.success)
        return { success: true, data: projected.data, unknownFilters, source: document };
    }
  }
  const issue = parsed.error.issues[0]!;
  return { success: false, error: `${issue.path.join(".") || "YAML"}: ${issue.message}` };
}

function assertDocument(document: Document): void {
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
}

function updateSequence(document: Document, sequence: YAMLSeq, values: readonly unknown[]): void {
  const oldItems = new Map<unknown, unknown[]>();
  for (const item of sequence.items) {
    const value: unknown = isNode(item) ? item.toJS(document) : item;
    const matches = oldItems.get(value) ?? [];
    matches.push(item);
    oldItems.set(value, matches);
  }
  const aliases = yamlAliases(document);
  sequence.items = values.map(
    (value) => oldItems.get(value)?.shift() ?? document.createNode(value),
  );
  restoreSequenceAliases(document, aliases);
}

function yamlAliases(document: Document): Map<Alias, Node> {
  const aliases = new Map<Alias, Node>();
  visit(document, {
    Alias(_key, alias) {
      const target = alias.resolve(document);
      if (target !== undefined) aliases.set(alias, target);
    },
  });
  return aliases;
}

function sharedYamlPath(
  document: Document,
  path: readonly string[],
  aliases: Map<Alias, Node>,
  includeDescendants = true,
): boolean {
  if (aliases.size === 0) return false;
  let node: unknown = document.contents;
  for (const key of path) {
    if (isAlias(node)) return true;
    if (!isMap(node)) return false;
    if (hasExternalReference(node, aliases, false)) return true;
    node = node.get(key, true);
  }
  return (
    isNode(node) &&
    ((isAlias(node) && !includeDescendants) ||
      hasExternalReference(node, aliases, includeDescendants))
  );
}

function hasExternalReference(
  node: Node,
  aliases: Map<Alias, Node>,
  includeDescendants: boolean,
): boolean {
  for (const [alias, target] of aliases) {
    if (
      (target === node || (includeDescendants && yamlContains(node, target))) &&
      !yamlContains(node, alias)
    ) {
      return true;
    }
  }
  return false;
}

function yamlContains(parent: Node, child: Node): boolean {
  if (parent === child) return true;
  return (
    parent.range != null &&
    child.range != null &&
    parent.range[0] <= child.range[0] &&
    child.range[2] <= parent.range[2]
  );
}

function requireWritableYaml(document: Document, path: readonly string[]): void {
  if (sharedYamlPath(document, path, yamlAliases(document))) throw new Error(SHARED_YAML_FIELD);
}

function restoreSequenceAliases(document: Document, aliases: Map<Alias, Node>): void {
  // Promote the first surviving alias if a list edit removed its anchor.
  visit(document, {
    Alias(_key, alias) {
      return alias.resolve(document) === undefined ? aliases.get(alias) : undefined;
    },
  });
}

function setIfChanged(document: Document, path: readonly string[], value: unknown): void {
  const node = document.getIn(path, true);
  const current: unknown = isNode(node) ? node.toJS(document) : node;
  if (sameValue(current, value)) return;
  requireWritableYaml(document, path);
  if (isSeq(node) && Array.isArray(value)) {
    updateSequence(document, node, value);
    return;
  }
  if (isAlias(node) || isCollection(node)) {
    // Write at the alias site so a field edit cannot change the value at its anchor.
    const replacement = document.createNode(value);
    if (node.comment !== undefined) replacement.comment = node.comment;
    if (node.commentBefore !== undefined) replacement.commentBefore = node.commentBefore;
    if (node.spaceBefore !== undefined) replacement.spaceBefore = node.spaceBefore;
    if (isCollection(node) && isCollection(replacement) && node.flow !== undefined)
      replacement.flow = node.flow;
    document.setIn(path, replacement);
    return;
  }
  document.setIn(path, value);
}

function setOptional(document: Document, path: readonly string[], value: unknown): void {
  if (value === undefined) deleteIfPresent(document, path);
  else setIfChanged(document, path, value);
}

function deleteIfPresent(document: Document, path: readonly string[]): void {
  if (!document.hasIn(path)) return;
  requireWritableYaml(document, path);
  document.deleteIn(path);
}

function sameFormValue(left: TriggerFormValue, right: TriggerFormValue): boolean {
  return sameValue(left, right);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function blankToUndefined(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

/** Provider-bound state and qualifier compatibility belong to the form model. */
export function changeTriggerEvent(value: TriggerFormValue, event: EditorEvent): TriggerFormValue {
  if (value.event === event) return value;
  const previous = eventDefinition(value.event);
  const next = eventDefinition(event);
  const sameProvider = previous.provider === next.provider;
  const qualifiers: QualifierValues = {};
  if (sameProvider) {
    for (const qualifier of next.qualifiers) {
      if (
        (next.provider === "github" && GITHUB_TEXT_KEYS.includes(qualifier.key)) ||
        previous.qualifiers.some(
          (candidate) => candidate.key === qualifier.key && candidate.kind === qualifier.kind,
        )
      ) {
        const selection = value.qualifiers[qualifier.key];
        if (selection !== undefined) qualifiers[qualifier.key] = selection;
      }
    }
  }
  const namedAudience = value.allowedUsers !== "" && value.allowedUsers !== "*";
  const nextAudience = namedAudience ? "" : defaultAudience(event);
  const result = {
    ...value,
    event,
    qualifiers,
    allowedUsers: sameProvider ? value.allowedUsers : nextAudience,
    connection: sameProvider ? value.connection : "",
    ...(event === "schedule.tick" ? {} : { recurrence: DEFAULT_RECURRENCE }),

    ...(value.progressMessage === true && !hasProgressDestination(event)
      ? { progressMessage: false }
      : {}),
  };
  if (value.advancedFilters !== undefined) result.advancedFilters = [];
  delete result.manualNoCallers;
  return result;
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
  if (
    !sameProvider &&
    needsActorFilter(previous) &&
    (isManualNoCallers(previous) || (previous.allowedUsers !== "" && previous.allowedUsers !== "*"))
  ) {
    dropped.push("Audience");
  }
  if (previous.event === "schedule.tick" && next.event !== previous.event) dropped.push("Schedule");
  if (previous.progressMessage === true && next.progressMessage === false) {
    dropped.push("Live progress messages");
  }
  return dropped;
}

/**
 * Moving between a prompt and a script keeps what the two share and resets what the other
 * action's defaults would get wrong: the run limit, and an open audience a script may not have.
 */
export function changeTriggerAction(
  value: TriggerFormValue,
  action: TriggerAction,
): TriggerFormValue {
  if (value.action === action) return value;
  const next = { ...value, action };
  if (action === "script") {
    return {
      ...next,
      maxRuntime:
        value.maxRuntime === DEFAULT_AGENT_MAX_RUNTIME
          ? DEFAULT_SCRIPT_MAX_RUNTIME
          : value.maxRuntime,
      allowedUsers: value.allowedUsers.trim() === "*" ? "" : value.allowedUsers,
    };
  }
  return {
    ...next,
    maxRuntime:
      value.maxRuntime === DEFAULT_SCRIPT_MAX_RUNTIME
        ? DEFAULT_AGENT_MAX_RUNTIME
        : value.maxRuntime,
  };
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
  if (qualifier.kind === "inputs") {
    if (value.trim() === "") return undefined;
    try {
      return TriggerFilterSchema.shape.inputs.unwrap().parse(JSON.parse(value));
    } catch {
      throw new Error(
        "Input matches must be a JSON object with string, number, or boolean values.",
      );
    }
  }
  if (
    qualifier.key === "pattern" ||
    qualifier.key === "contains" ||
    qualifier.key === "exclude_contains"
  ) {
    return value;
  }
  return blankToUndefined(value);
}

function formContinuation(value: TriggerFormValue) {
  return ContinuationSchema.parse(
    value.continuationMode === "key"
      ? { mode: "key", key: value.continuationKey }
      : { mode: value.continuationMode },
  );
}

function continuationErrors(value: TriggerFormValue): TriggerFieldErrors {
  return refused(() => formContinuation(value)) === undefined
    ? {}
    : { continuationKey: "Enter a continuation key or expression." };
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
