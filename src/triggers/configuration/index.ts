import { createHash } from "node:crypto";
import { dump } from "js-yaml";
import {
  compileHubConfig,
  isScriptStep,
  type AuthoredAgentStep,
  type AuthoredStep,
  type AuthoredTrigger,
  type CompiledEnvironment,
  type CompiledTrigger,
} from "../../config/compiler.js";
import {
  isScriptRun,
  type TriggerAgentRun,
  type TriggerDocument,
  type TriggerScriptRun,
} from "./schema.js";

import { parseTriggerDocument, TriggerDocumentError } from "./document.js";

export {
  parseTriggerDocument,
  TriggerDocumentError,
  type TriggerDocumentIssue,
} from "./document.js";
export { TriggerDocumentSchema, type TriggerDocument } from "./schema.js";
export {
  migrateLegacyBundle,
  type MigratedLegacyTrigger,
  type SelfContainedLegacyTrigger,
} from "./legacy-migration.js";

export interface CompiledTriggerDocument {
  authored: TriggerDocument;
  environment: CompiledEnvironment;
  events: readonly CompiledTrigger[];
  authoredHash: string;
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
      filters: authoredFilters(event, definition),
      steps: [isScriptRun(run) ? scriptStep(run) : agentStep(run)],
    };
    if (authored.inputs !== undefined) compiledTrigger.inputs = authored.inputs;
    triggers.push(compiledTrigger);
  }
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

function scriptStep(run: TriggerScriptRun): AuthoredStep {
  return { id: "run", environment: "target", max_runtime: run.max_runtime, script: run.script };
}

function agentStep(run: TriggerAgentRun): AuthoredAgentStep {
  const allowOutputs: NonNullable<AuthoredAgentStep["allow_outputs"]> = [];
  for (const [type, output] of Object.entries(run.outputs ?? {})) {
    const grant: NonNullable<AuthoredAgentStep["allow_outputs"]>[number] = { type };
    if (output.max !== undefined) grant.max = output.max;
    if (output.required !== undefined) grant.required = output.required;
    allowOutputs.push(grant);
  }
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

function authoredFilters(
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
  return dump(exported, { noRefs: true, lineWidth: -1, sortKeys: false });
}

function internalEventName(name: string, index: number, named: number): string {
  return index === named ? name : `${name}-event-${String(index + 1)}`;
}
