import { createHash } from "node:crypto";
import { dump } from "js-yaml";
import { compileHubBundle, type HubBundleFile } from "../../config/bundle.js";
import type {
  AuthoredAgentStep,
  AuthoredStep,
  AuthoredTrigger,
  CompiledAgent,
  CompiledAgentSelection,
  CompiledAgentStep,
  CompiledEnvironment,
  CompiledHubConfig,
  CompiledInput,
  CompiledTrigger,
  JsonPrimitive,
} from "../../config/compiler.js";
import { compileHubConfig, isScriptStep, parseCompiledHubConfig } from "../../config/compiler.js";
import { parseTriggerDocument, TriggerDocumentError } from "./document.js";
import type { CompiledTriggerDocument } from "./index.js";
import {
  isScriptRun,
  type TriggerAgentRun,
  type TriggerDocument,
  type TriggerScriptRun,
} from "./schema.js";

export type MigratedLegacyTrigger =
  | {
      format: "single_run";
      name: string;
      yaml: string;
      compiled: ReturnType<typeof compileTriggerDocument>;
      legacySourceFile: string | null;
      legacyStepIds: readonly string[];
    }
  | {
      format: "legacy_multistep";
      name: string;
      yaml: string;
      normalized: SelfContainedLegacyTrigger;
      legacySourceFile: string | null;
      conversionBlockers: readonly string[];
      authoredYaml: string;
      legacyStepIds: readonly string[];
    };

export interface SelfContainedLegacyTrigger {
  trigger: CompiledTrigger;
  environments: readonly CompiledEnvironment[];
}

export function migrateLegacyBundle(input: {
  files: readonly HubBundleFile[];
  normalizedConfiguration?: unknown;
}): readonly MigratedLegacyTrigger[] {
  const bundle = compileHubBundle(input.files);
  const configuration =
    input.normalizedConfiguration === undefined
      ? bundle.configuration
      : parseCompiledHubConfig(input.normalizedConfiguration);
  const authoredByPath = new Map(bundle.files.map((file) => [file.path, file.content]));
  return configuration.triggers.map((trigger) => {
    const sourceFile = trigger.sourceFile ?? null;
    const authoredYaml =
      sourceFile === null
        ? dump(trigger, { noRefs: true, lineWidth: -1 })
        : (authoredByPath.get(sourceFile) ?? dump(trigger, { noRefs: true, lineWidth: -1 }));
    const converted = convertSingleRun(trigger, configuration);
    return converted.success
      ? {
          format: "single_run" as const,
          name: trigger.name,
          yaml: serializeTriggerDocument(converted.trigger),
          compiled: compileTriggerDocument(serializeTriggerDocument(converted.trigger)),
          legacySourceFile: sourceFile,
          legacyStepIds: trigger.steps.map(({ id }) => id),
        }
      : {
          format: "legacy_multistep" as const,
          name: trigger.name,
          yaml: serializeLegacyTrigger({ trigger, environments: configuration.environments }),
          normalized: { trigger, environments: configuration.environments },
          legacySourceFile: sourceFile,
          conversionBlockers: converted.blockers,
          authoredYaml,
          legacyStepIds: trigger.steps.map(({ id }) => id),
        };
  });
}

function serializeLegacyTrigger(snapshot: SelfContainedLegacyTrigger): string {
  return dump(
    { name: snapshot.trigger.name, legacy_multistep: snapshot },
    { noRefs: true, lineWidth: -1, sortKeys: false },
  );
}

type SingleRunConversion =
  | { success: true; trigger: TriggerDocument }
  | { success: false; blockers: readonly string[] };

function convertSingleRun(
  trigger: CompiledTrigger,
  configuration: CompiledHubConfig,
): SingleRunConversion {
  const blockers: string[] = [];
  if (trigger.steps.length !== 1) blockers.push("trigger has multiple steps");
  if (Object.keys(trigger.values).length > 0) blockers.push("trigger defines workflow values");
  const step = trigger.steps[0];
  if (step === undefined) return { success: false, blockers };
  if (isScriptStep(step)) return { success: false, blockers: [...blockers, "run is a script"] };
  if (step.condition !== undefined) blockers.push("run is conditional");
  if (hasNullableInputs(trigger.inputs)) blockers.push("trigger inputs allow null values");
  const environment = legacyTarget(step, configuration, blockers);
  if (blockers.length > 0 || environment === undefined || environment.kind !== "daemon") {
    return { success: false, blockers };
  }

  return { success: true, trigger: singleRunDocument(trigger, step, environment) };
}

function legacyTarget(
  step: CompiledAgentStep,
  configuration: CompiledHubConfig,
  blockers: string[],
): CompiledEnvironment | undefined {
  const environment = configuration.environments.find(
    (candidate) => candidate.name === step.environment,
  );
  if (environment === undefined) blockers.push("target environment is selected dynamically");
  else if (environment.kind !== "daemon")
    blockers.push(`target kind ${environment.kind} is legacy`);
  if (hasDuplicateOutputs(step)) blockers.push("run contains duplicate output grants");
  return environment;
}

function singleRunDocument(
  trigger: CompiledTrigger,
  step: CompiledAgentStep,
  environment: Extract<CompiledEnvironment, { kind: "daemon" }>,
): TriggerDocument {
  const filters = trigger.filters === undefined ? undefined : authoredFilters(trigger.filters);
  const connection = trigger.filters?.connection;
  const outputs = Object.fromEntries(
    step.allowOutputs.map((output) => [
      output.type,
      {
        max: output.max,
        ...(output.required ? { required: true } : {}),
      },
    ]),
  );
  const event = {
    ...(connection === undefined ? {} : { connection }),
    ...(filters === undefined || Object.keys(filters).length === 0 ? {} : { filters }),
  };
  return {
    name: trigger.name,
    enabled: true,
    on: { [trigger.on]: event },
    ...(Object.keys(trigger.inputs).length === 0 ? {} : { inputs: authoredInputs(trigger.inputs) }),
    ...(trigger.maxRuntimeMs === step.maxRuntimeMs
      ? {}
      : { max_runtime: duration(trigger.maxRuntimeMs) }),
    ...(trigger.progressMessage === true ? { progress_message: true } : {}),
    ...(trigger.replyMessage === true ? { reply_message: true } : {}),
    run: singleAgentRun(step, environment, outputs),
  };
}

function singleAgentRun(
  step: CompiledAgentStep,
  environment: Extract<CompiledEnvironment, { kind: "daemon" }>,
  outputs: NonNullable<TriggerAgentRun["outputs"]>,
): TriggerAgentRun {
  return {
    continuation: { mode: "new" },
    target: {
      daemon: environment.daemon,
      cwd: environment.cwd,
      ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
    },
    agent: authoredAgent(step.agent),
    ...(step.title === undefined ? {} : { title: step.title }),
    prompt: step.prompt
      .map((block) => (block.kind === "text" ? block.value : block.content))
      .join("\n"),
    max_runtime: duration(step.maxRuntimeMs),
    idle_timeout: duration(step.idleTimeoutMs),
    ...(step.startupTimeoutMs === undefined
      ? {}
      : { startup_timeout: duration(step.startupTimeoutMs) }),
    ...(step.env === undefined ? {} : { env: { ...step.env } }),
    ...(step.github === undefined
      ? {}
      : {
          github: {
            connection: step.github.connection,
            ...(step.github.repositories === undefined
              ? {}
              : { repositories: [...step.github.repositories] }),
            permissions: { ...step.github.permissions },
            duration: duration(step.github.durationMs),
          },
        }),
    ...(step.output === undefined
      ? {}
      : { output: { schema: structuredClone(asJsonObject(step.output.schema)) } }),
    ...(Object.keys(outputs).length === 0 ? {} : { outputs }),
    auto_archive: step.autoArchive,
    background: step.background,
    ...(step.completeOnTurnEnd === true ? { complete_on_turn_end: true } : {}),
  };
}

function authoredAgent(agent: CompiledAgentSelection): TriggerAgentRun["agent"] {
  if (!("selector" in agent)) return cloneAgent(agent);
  return {
    select: agent.selector,
    choices: Object.fromEntries(
      Object.entries(agent.choices).map(([name, choice]) => [name, cloneAgent(choice)]),
    ),
  };
}

function cloneAgent(agent: CompiledAgent): CompiledAgent {
  return {
    ...agent,
    ...(agent.options === undefined ? {} : { options: structuredClone(agent.options) }),
  };
}

function authoredInputs(
  inputs: Readonly<Record<string, CompiledInput>>,
): NonNullable<TriggerDocument["inputs"]> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, input]) => [
      name,
      {
        type: input.type,
        ...(input.required ? { required: true } : {}),
        ...(input.default === undefined || input.default === null
          ? {}
          : { default: input.default }),
        ...(input.choices === undefined
          ? {}
          : { choices: input.choices.filter((choice) => choice !== null) }),
      },
    ]),
  );
}

function authoredFilters(
  filters: NonNullable<CompiledTrigger["filters"]>,
): TriggerDocument["on"][string]["filters"] | undefined {
  const {
    connection: _connection,
    connectionId: _connectionId,
    resourceId: _resourceId,
    ...rest
  } = filters;
  if (Object.keys(rest).length === 0) return undefined;
  return {
    pattern: rest.pattern,
    contains: rest.contains,
    label: rest.label,
    labels: rest.labels === undefined ? undefined : [...rest.labels],
    repo: rest.repo,
    guild: rest.guild,
    workspace: rest.workspace,
    project: rest.project,
    states: rest.states === undefined ? undefined : [...rest.states],
    exclude_labels: rest.exclude_labels === undefined ? undefined : [...rest.exclude_labels],
    assignees: rest.assignees === undefined ? undefined : [...rest.assignees],
    channels: rest.channels === undefined ? undefined : [...rest.channels],
    from_users: rest.from_users === undefined ? undefined : [...rest.from_users],
    inputs: rest.inputs === undefined ? undefined : { ...rest.inputs },
  };
}

function hasNullableInputs(inputs: Readonly<Record<string, CompiledInput>>): boolean {
  return Object.values(inputs).some(
    (input) => input.default === null || input.choices?.some((choice) => choice === null) === true,
  );
}

function asJsonObject(value: JsonPrimitive | readonly unknown[] | object): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("compiled output schema is not an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function hasDuplicateOutputs(step: CompiledAgentStep): boolean {
  return new Set(step.allowOutputs.map(({ type }) => type)).size !== step.allowOutputs.length;
}

function duration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${String(milliseconds / 3_600_000)}h`;
  if (milliseconds % 60_000 === 0) return `${String(milliseconds / 60_000)}m`;
  if (milliseconds % 1000 === 0) return `${String(milliseconds / 1000)}s`;
  return `${String(milliseconds)}ms`;
}

export function compileTriggerDocument(yaml: string): CompiledTriggerDocument {
  const authored = parseTriggerDocument(yaml);
  const run = authored.run;
  const namedAgents = isScriptRun(run) || !("choices" in run.agent) ? undefined : run.agent.choices;
  const environment = {
    name: "target",
    kind: "daemon" as const,
    ...run.target,
  };
  const triggers = authoredEventTriggers(authored, run);
  let compiled: ReturnType<typeof compileHubConfig>;
  try {
    compiled = compileHubConfig(
      {
        environments: [environment],
        triggers,
      },
      namedAgents === undefined ? {} : { namedAgents },
    );
  } catch (error) {
    throw new TriggerDocumentError([
      { path: [], message: error instanceof Error ? error.message : "trigger compilation failed" },
    ]);
  }
  const compiledEnvironment = compiled.environments[0];
  if (compiledEnvironment === undefined) {
    throw new Error("compiled trigger target is missing");
  }
  return {
    authored,
    environment: compiledEnvironment,
    events: compiled.triggers.map((trigger) =>
      withAutomaticReply({
        ...trigger,
        steps: trigger.steps.map((step) =>
          isScriptRun(run) ? step : { ...step, continuation: run.continuation },
        ),
      }),
    ),
    authoredHash: createHash("sha256").update(yaml).digest("hex"),
  };
}

function authoredEventTriggers(
  authored: TriggerDocument,
  run: TriggerDocument["run"],
): AuthoredTrigger[] {
  const triggers: AuthoredTrigger[] = [];
  const events = Object.entries(authored.on);
  // A manual dispatch addresses the trigger by its name, so `manual.run` carries it wherever it
  // is declared; otherwise the first event does.
  const named = Math.max(
    0,
    events.findIndex(([event]) => event === "manual.run"),
  );
  for (const [index, [event, definition]] of events.entries()) {
    const compiledTrigger: AuthoredTrigger = {
      name: internalEventName(authored.name, index, named),
      on: event,
      max_runtime: authored.max_runtime ?? run.max_runtime,
      ...(authored.progress_message === true ? { progress_message: true } : {}),
      ...(authored.reply_message === true ? { reply_message: true } : {}),
      filters: compileEventFilters(event, definition),
      steps: [isScriptRun(run) ? scriptStep(run) : agentStep(run)],
    };
    if (authored.inputs !== undefined) compiledTrigger.inputs = authored.inputs;
    triggers.push(compiledTrigger);
  }
  return triggers;
}

function scriptStep(run: TriggerScriptRun): AuthoredStep {
  return { id: "run", environment: "target", max_runtime: run.max_runtime, script: run.script };
}

function agentStep(run: TriggerAgentRun): AuthoredAgentStep {
  const allowOutputs = authoredOutputGrants(run.outputs);
  return {
    id: "run",
    environment: "target",
    max_runtime: run.max_runtime,
    idle_timeout: run.idle_timeout,
    ...(run.startup_timeout === undefined ? {} : { startup_timeout: run.startup_timeout }),
    agent: "choices" in run.agent ? run.agent.select : run.agent,
    ...(run.title === undefined ? {} : { title: run.title }),
    prompt: [{ text: run.prompt }],
    ...(run.env === undefined ? {} : { env: run.env }),
    ...(run.github === undefined ? {} : { github: run.github }),
    ...(run.output === undefined ? {} : { output: run.output }),
    ...(allowOutputs.length === 0 ? {} : { allow_outputs: allowOutputs }),
    auto_archive: run.auto_archive,
    background: run.background,
    ...(run.complete_on_turn_end === true ? { complete_on_turn_end: true } : {}),
  };
}

function authoredOutputGrants(
  outputs: TriggerAgentRun["outputs"],
): NonNullable<AuthoredAgentStep["allow_outputs"]> {
  const allowOutputs: NonNullable<AuthoredAgentStep["allow_outputs"]> = [];
  for (const [type, output] of Object.entries(outputs ?? {})) {
    const grant: NonNullable<AuthoredAgentStep["allow_outputs"]>[number] = { type };
    if (output.max !== undefined) grant.max = output.max;
    if (output.required !== undefined) grant.required = output.required;
    allowOutputs.push(grant);
  }
  return allowOutputs;
}

function withAutomaticReply(trigger: CompiledTrigger): CompiledTrigger {
  const replyType = automaticReplyType(trigger.on);
  if (replyType === undefined) return trigger;
  return {
    ...trigger,
    steps: trigger.steps.map((step) =>
      isScriptStep(step)
        ? step
        : {
            ...step,
            allowOutputs: step.allowOutputs.some(({ type }) => type === replyType)
              ? step.allowOutputs
              : [...step.allowOutputs, { type: replyType, required: false }],
          },
    ),
  };
}

function automaticReplyType(event: string): string | undefined {
  // A notification has no installation to reply through.
  if (event === "github.notification") return undefined;
  const provider = event.split(".", 1)[0];
  return provider === "slack" ||
    provider === "discord" ||
    provider === "linear" ||
    provider === "github"
    ? `${provider}.reply`
    : undefined;
}

function compileEventFilters(
  event: string,
  definition: TriggerDocument["on"][string],
): NonNullable<AuthoredTrigger["filters"]> {
  return {
    ...definition.filters,
    ...(event === "manual.run" && definition.filters?.from_users === undefined
      ? { from_users: ["*"] }
      : {}),
    ...(definition.connection === undefined ? {} : { connection: definition.connection }),
  };
}

export function serializeTriggerDocument(trigger: TriggerDocument): string {
  const exported = { ...trigger };
  if (exported.progress_message !== true) delete exported.progress_message;
  if (exported.reply_message !== true) delete exported.reply_message;
  return dump(exported, { noRefs: true, lineWidth: -1, sortKeys: false });
}

function internalEventName(name: string, index: number, named: number): string {
  return index === named ? name : `${name}-event-${String(index + 1)}`;
}
