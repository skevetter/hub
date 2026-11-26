import { isScriptStep, type CompiledStep } from "../config/compiler.js";

/**
 * Whether the agent's final reply is captured to post as the run's reply. Only the last agent step
 * of the trigger is: if it is skipped, no reply is posted, rather than an earlier step's answer.
 */
export function capturesReply(
  trigger: { replyMessage?: boolean | undefined; steps: readonly CompiledStep[] },
  step: CompiledStep,
): boolean {
  if (trigger.replyMessage !== true) return false;
  const agentSteps = trigger.steps.filter((candidate) => !isScriptStep(candidate));
  return agentSteps.at(-1)?.id === step.id;
}
