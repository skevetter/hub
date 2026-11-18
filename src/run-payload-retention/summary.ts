import type {
  AgentExecutionRecord,
  ProviderEventReceiptSummary,
  TriggerRunRecord,
  WorkflowStepRunRecord,
} from "../db/types.js";
import type { RunProgressMessage, RunTimelineState } from "../run-timeline/store.js";
import type { InvocationRejection } from "../triggers/invocation.js";
import { readScriptStepResult } from "../workflows/script-output.js";

export type PayloadCompletion = "explicit_finish" | "inferred_from_turn_end";
export type PayloadFailureCode = "run_failed" | "step_failed" | "timed_out" | "step_skipped";

export interface RunPayloadSummary {
  version: 1;
  workflowKey: string;
  repository: string | null;
  providerLink: string | null;
  failureCode: PayloadFailureCode | null;
  stepCounts: Partial<Record<WorkflowStepRunRecord["status"], number>>;
  timelineCounts: { events: number; dropped: number } | null;
  progress: { status: "posted" | "failed" | "unknown"; link: string | null };
}

export interface StepPayloadSummary {
  version: 1;
  stepKey: string;
  status: WorkflowStepRunRecord["status"];
  durationMs: number | null;
  hadOutput: boolean;
  exitCode: number | null;
  truncated: boolean | null;
  provider: string | null;
  model: string | null;
  failureCode: PayloadFailureCode | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function repositoryName(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u.test(value) &&
    !value.endsWith("/.") &&
    !value.endsWith("/..")
    ? value
    : null;
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && value > 0 && Number.isSafeInteger(value) ? value : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : null;
}

function providerLink(
  run: TriggerRunRecord,
  receipt: Pick<ProviderEventReceiptSummary, "provider">,
  repo: string | null,
): string | null {
  const event = field(run.triggerContext, "event");
  if (receipt.provider === "linear") {
    const id = uuid(field(run.outputContext, "issueId"));
    return id === null ? null : `https://linear.app/issue/${id}`;
  }
  if (repo === null) return null;
  if (receipt.provider === "github_notification") {
    const notification = field(event, "github_notification");
    const number = positiveId(field(notification, "number"));
    const type = field(notification, "type");
    return number === null
      ? null
      : `https://github.com/${repo}/${type === "PullRequest" ? "pull" : "issues"}/${number}`;
  }
  if (receipt.provider !== "github") return null;
  const github = field(event, "github");
  const number = positiveId(field(field(github, "item"), "number"));
  if (number === null) return `https://github.com/${repo}`;
  const pull = field(field(github, "item"), "kind") === "pull_request";
  return `https://github.com/${repo}/${pull ? "pull" : "issues"}/${number}`;
}

function progressSummary(message: RunProgressMessage | undefined): RunPayloadSummary["progress"] {
  if (message?.state !== "finished") {
    return {
      status: message === undefined || message.state === "abandoned" ? "unknown" : "failed",
      link: null,
    };
  }
  if (message.provider === "github") {
    const ref = message.externalRef;
    const repo = repositoryName(field(ref, "repository"));
    const issue = positiveId(field(ref, "issueNumber"));
    const comment = positiveId(field(ref, "commentId"));
    if (repo !== null && issue !== null && comment !== null) {
      return {
        status: "posted",
        link: `https://github.com/${repo}/issues/${issue}#issuecomment-${comment}`,
      };
    }
  }
  if (message.provider === "linear") {
    const issue = uuid(field(message.externalRef, "issueId"));
    const comment = uuid(field(message.externalRef, "commentId"));
    if (issue !== null && comment !== null) {
      return { status: "posted", link: `https://linear.app/issue/${issue}#comment-${comment}` };
    }
  }
  return { status: "posted", link: null };
}

export function summarizeRunPayload(
  run: TriggerRunRecord,
  receipt: Pick<ProviderEventReceiptSummary, "provider" | "repo">,
  stepCounts: RunPayloadSummary["stepCounts"],
  timeline: Pick<RunTimelineState, "eventCount" | "droppedCount"> | undefined,
  progress: RunProgressMessage | undefined,
): RunPayloadSummary {
  const repo = repositoryName(receipt.repo);
  return {
    version: 1,
    workflowKey: run.configuredTriggerName,
    repository: repo,
    providerLink: providerLink(run, receipt, repo),
    failureCode: runFailureCode(run.status),
    stepCounts,
    timelineCounts:
      timeline === undefined
        ? null
        : { events: timeline.eventCount, dropped: timeline.droppedCount },
    progress: progressSummary(progress),
  };
}

export function summarizeStepPayload(step: WorkflowStepRunRecord): StepPayloadSummary {
  const script = step.agentExecutionId === null ? readScriptStepResult(step.output) : undefined;
  const provider = step.dispatchIntent?.agent.provider;
  const model = step.dispatchIntent?.agent.model;
  return {
    version: 1,
    stepKey: step.stepId,
    status: step.status,
    durationMs:
      step.startedAt === null || step.completedAt === null
        ? null
        : Math.max(0, step.completedAt.getTime() - step.startedAt.getTime()),
    hadOutput: step.output !== null,
    exitCode: script?.exit_code ?? null,
    truncated: script?.truncated ?? null,
    provider:
      typeof provider === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(provider) ? provider : null,
    model:
      typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/u.test(model)
        ? model
        : null,
    failureCode: stepFailureCode(step.status),
  };
}

function runFailureCode(status: TriggerRunRecord["status"]): PayloadFailureCode | null {
  if (status === "timed_out") return "timed_out";
  return status === "failed" ? "run_failed" : null;
}

function stepFailureCode(status: WorkflowStepRunRecord["status"]): PayloadFailureCode | null {
  if (status === "timed_out") return "timed_out";
  if (status === "failed") return "step_failed";
  return status === "skipped" ? "step_skipped" : null;
}

export function payloadCompletion(
  execution: Pick<AgentExecutionRecord, "completedByAgentAt" | "result">,
): PayloadCompletion | null {
  if (execution.completedByAgentAt !== null) return "explicit_finish";
  return field(execution.result, "completion") === "inferred_from_turn_end"
    ? "inferred_from_turn_end"
    : null;
}

export function reduceRejection(rejection: InvocationRejection): InvocationRejection {
  if (rejection.code === "invalid_choice") {
    return { code: rejection.code, inputName: "value", value: null, choices: [] };
  }
  return { ...rejection, inputName: "value" };
}
