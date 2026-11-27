import { isScriptStep, type CompiledStep } from "../config/compiler.js";

interface ReplyTrigger {
  replyMessage?: boolean | undefined;
  steps: readonly CompiledStep[];
}

/**
 * Whether this step is the last agent step by position, the one that holds the automatic reply
 * output grant and whose final answer is posted when it is also the last agent step that ran.
 */
export function capturesReply(trigger: ReplyTrigger, step: CompiledStep): boolean {
  if (trigger.replyMessage !== true) return false;
  const agentSteps = trigger.steps.filter((candidate) => !isScriptStep(candidate));
  return agentSteps.at(-1)?.id === step.id;
}

/**
 * Whether the run's reply could be this step's final answer. Hub posts the answer of the last
 * agent step that ran, so it watches every agent step that could be last: the last one by
 * position, and each earlier one while every agent step after it can be skipped by its `if`.
 * Watching a step posts nothing and grants no tool.
 */
export function isReplyCaptureCandidate(trigger: ReplyTrigger, step: CompiledStep): boolean {
  if (trigger.replyMessage !== true || isScriptStep(step)) return false;
  const agentSteps = trigger.steps.filter((candidate) => !isScriptStep(candidate));
  for (let index = agentSteps.length - 1; index >= 0; index--) {
    const candidate = agentSteps[index];
    if (candidate === undefined) break;
    if (candidate.id === step.id) return true;
    if (candidate.condition === undefined) return false;
  }
  return false;
}
