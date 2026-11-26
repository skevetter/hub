import type {
  AuthoredAgentStep,
  AuthoredStep,
  CompiledAgent,
  CompiledAgentStep,
  CompiledTrigger,
} from "../../config/compiler.js";
import type { Continuation } from "../continuation.js";
import { canonicalJson } from "./canonical-json.js";
import type { TriggerDocumentIssue } from "./document.js";
import { isScriptStep, MAX_DURATION_MS, parseDurationMs } from "../../config/compiler.js";
import {
  isScriptStep as isAuthoredScriptStep,
  type TriggerAgentStep,
  type TriggerScriptStep,
  type TriggerStep,
} from "./schema.js";
import { stepContinuation } from "./steps.js";

export function authoredSteps(steps: readonly TriggerStep[]): AuthoredStep[] {
  return steps.map((step) => (isAuthoredScriptStep(step) ? scriptStep(step) : agentStep(step)));
}

/**
 * The whole-run deadline when the document sets none: one step keeps its own, several get the sum of
 * theirs, up to the 24 hour limit every deadline has.
 */
export function defaultRunDeadline(steps: readonly TriggerStep[]): string {
  const [only] = steps;
  if (steps.length === 1 && only !== undefined) return only.max_runtime;
  const total = steps.reduce(
    (sum, step) => sum + parseDurationMs(step.max_runtime, `step ${step.id} max_runtime`),
    0,
  );
  return `${String(Math.min(total, MAX_DURATION_MS))}ms`;
}

/** Steps that choose between agents list the same choices, which the schema enforces. */
export function sharedNamedAgents(
  steps: readonly TriggerStep[],
): Readonly<Record<string, CompiledAgent>> | undefined {
  for (const step of steps) {
    if (!isAuthoredScriptStep(step) && "choices" in step.agent) return step.agent.choices;
  }
  return undefined;
}

/** Each agent step keeps the continuation its own document step declares. */
export function withStepContinuation(
  trigger: CompiledTrigger,
  steps: readonly TriggerStep[],
): CompiledTrigger {
  return {
    ...trigger,
    steps: trigger.steps.map((step, index) => {
      const authored = steps[index];
      if (authored === undefined || isScriptStep(step) || isAuthoredScriptStep(authored)) {
        return step;
      }
      return { ...step, continuation: stepContinuation(authored) };
    }),
  };
}

/** The automatic reply output goes on the last agent step, where the final answer is written. */
export function withAutomaticReply(trigger: CompiledTrigger): CompiledTrigger {
  const replyType = automaticReplyType(trigger.on);
  if (replyType === undefined) return trigger;
  const last = lastAgentIndex(trigger.steps);
  return {
    ...trigger,
    steps: trigger.steps.map((step, index) =>
      index !== last || isScriptStep(step)
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

/**
 * Agent steps that continue the same conversation share one session, and a session only accepts
 * steps with the same agent, env, github grant, output schema and allowed outputs. Refuse that at
 * save time instead of failing the second step when it dispatches.
 */
export function continuationIssues(trigger: CompiledTrigger): TriggerDocumentIssue[] {
  const issues: TriggerDocumentIssue[] = [];
  const firstWith = new Map<string, { id: string; step: CompiledAgentStep }>();
  for (const [index, step] of trigger.steps.entries()) {
    const key = isScriptStep(step) ? undefined : sharedSessionKey(step.continuation, trigger.on);
    if (isScriptStep(step) || key === undefined) continue;
    const first = firstWith.get(key);
    if (first === undefined) {
      firstWith.set(key, { id: step.id, step });
      continue;
    }
    const differing = sessionDifferences(first.step, step);
    if (differing.length > 0) {
      issues.push({
        path: ["steps", index, "continuation"],
        message: `Step "${step.id}" continues the same conversation as step "${first.id}" but differs in ${differing.join(", ")}. A conversation only continues across steps that match in those. Give one of them continuation: new, or a different key.`,
      });
    }
  }
  return issues;
}

function sharedSessionKey(
  continuation: Continuation | undefined,
  event: string,
): string | undefined {
  if (continuation === undefined || continuation.mode === "new") return undefined;
  if (continuation.mode === "key") return `key:${continuation.key}`;
  // Without a conversation to continue, conversation mode starts a new agent.
  return automaticReplyType(event) === undefined ? undefined : "conversation";
}

function sessionDifferences(left: CompiledAgentStep, right: CompiledAgentStep): string[] {
  const outputs = (step: CompiledAgentStep) =>
    [...step.allowOutputs].sort((a, b) => a.type.localeCompare(b.type));
  const fields: [string, unknown, unknown][] = [
    ["agent", left.agent, right.agent],
    ["env", left.env, right.env],
    ["github", left.github, right.github],
    ["output schema", left.output, right.output],
    ["allowed outputs", outputs(left), outputs(right)],
  ];
  return fields
    .filter(([, before, after]) => canonicalJson(before) !== canonicalJson(after))
    .map(([name]) => name);
}

function lastAgentIndex(steps: CompiledTrigger["steps"]): number {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step !== undefined && !isScriptStep(step)) return index;
  }
  return -1;
}

function scriptStep(step: TriggerScriptStep): AuthoredStep {
  return {
    id: step.id,
    environment: "target",
    max_runtime: step.max_runtime,
    script: step.script,
    ...(step.if === undefined ? {} : { if: step.if }),
  };
}

function agentStep(step: TriggerAgentStep): AuthoredAgentStep {
  const allowOutputs = authoredOutputGrants(step.outputs);
  return {
    id: step.id,
    environment: "target",
    max_runtime: step.max_runtime,
    idle_timeout: step.idle_timeout,
    ...(step.startup_timeout === undefined ? {} : { startup_timeout: step.startup_timeout }),
    agent: "choices" in step.agent ? step.agent.select : step.agent,
    ...(step.title === undefined ? {} : { title: step.title }),
    prompt: [{ text: step.prompt }],
    ...(step.env === undefined ? {} : { env: step.env }),
    ...(step.github === undefined ? {} : { github: step.github }),
    ...(step.if === undefined ? {} : { if: step.if }),
    ...(step.output === undefined ? {} : { output: step.output }),
    ...(allowOutputs.length === 0 ? {} : { allow_outputs: allowOutputs }),
    auto_archive: step.auto_archive,
    background: step.background,
    ...(step.complete_on_turn_end === true ? { complete_on_turn_end: true } : {}),
  };
}

function authoredOutputGrants(
  outputs: TriggerAgentStep["outputs"],
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
