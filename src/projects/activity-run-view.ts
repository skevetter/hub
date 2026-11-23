import {
  payloadCompletion,
  type RunPayloadSummary,
  type StepPayloadSummary,
} from "../run-payload-retention/summary.js";
import type {
  AgentExecutionRecord,
  Database,
  ProjectActivityRunRecord,
  ProviderEventReceiptRecord,
  TriggerRunRecord,
  WorkflowStepRunRecord,
} from "../db/types.js";
import { formatInvocationRejection } from "../triggers/invocation.js";
import {
  decodeEntitlementDenialFailureReason,
  entitlementDenialSummary,
} from "../entitlements/denial.js";
import { summarizeTrigger, type TriggerSummary } from "./activity-summary.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ActivityRunDetail {
  run: {
    id: string;
    provider: ProviderEventReceiptRecord["provider"];
    source: string;
    repo: string | null;
    receivedAt: string;
    configuredTriggerName: string;
    prompt: string | null;
    payloadExpiredAt?: string | null;
    payloadSummary?: RunPayloadSummary | null;
    createdAt: string;
    completedAt: string | null;
    outcome: TriggerRunRecord["outcome"];
    status: TriggerRunRecord["status"];
    failureReason: string | null;
    webhookSummary?: TriggerSummary;
  };
  steps: {
    id: string;
    stepId: string;
    ordinal: number;
    status: WorkflowStepRunRecord["status"];
    startedAt: string | null;
    output: JsonValue;
    payloadSummary?: StepPayloadSummary | null;
    outputExpired?: boolean;
    failureReason: string | null;
    completedAt: string | null;
    isAgent: boolean;
    completion: "explicit_finish" | "inferred_from_turn_end" | null;
  }[];
}

export async function readActivityExecutions(
  database: Database,
  read: () => Promise<ProjectActivityRunRecord | undefined>,
) {
  const activity = await read();
  if (activity === undefined) return undefined;
  const executions = await executionsForActivity(database, activity);
  if (activity.run.payloadExpiredAt == null) {
    const [current, receipt] = await Promise.all([
      database.findTriggerRunForOrganization(activity.run.organizationId, activity.run.id),
      database.findProviderEventReplayMetadata(activity.run.organizationId, {
        id: activity.receipt.id,
      }),
    ]);
    if (current === undefined) return undefined;
    if (
      current.payloadExpiredAt != null ||
      (activity.receipt.payloadExpiryState == null && receipt?.payloadExpiryState != null)
    ) {
      const expired = await read();
      if (expired === undefined) return undefined;
      return { activity: expired, executions: await executionsForActivity(database, expired) };
    }
  }
  return { activity, executions };
}

function executionsForActivity(database: Database, activity: ProjectActivityRunRecord) {
  return Promise.all(
    activity.steps.map(async (step) =>
      step.agentExecutionId === null
        ? undefined
        : database.findAgentExecutionById(step.agentExecutionId),
    ),
  );
}

export function activityRunDetailView(
  activity: ProjectActivityRunRecord,
  executions: (AgentExecutionRecord | undefined)[],
): ActivityRunDetail {
  const { run, receipt, steps } = activity;
  const expired = run.payloadExpiredAt != null;
  return {
    run: {
      id: run.id,
      provider: receipt.provider,
      source: receipt.source,
      ...detailRunPayload(run, receipt, expired),
      receivedAt: receipt.receivedAt.toISOString(),
      configuredTriggerName: run.configuredTriggerName,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      outcome: run.outcome,
      status: run.status,
      failureReason:
        run.outcome === "rejected"
          ? formatInvocationRejection(run.rejection)
          : displayFailureReason(run.failureReason),
    },
    steps: steps.map((step, index) => activityStepDetailView(step, executions[index], expired)),
  };
}

function activityStepDetailView(
  step: WorkflowStepRunRecord,
  execution: AgentExecutionRecord | undefined,
  expired: boolean,
): ActivityRunDetail["steps"][number] {
  return {
    id: step.id,
    stepId: step.stepId,
    ordinal: step.ordinal,
    status: step.status,
    startedAt: isoOrNull(step.startedAt),
    completedAt: isoOrNull(step.completedAt),
    output: expired ? null : jsonValue(step.output),
    payloadSummary: expired ? (step.payloadSummary ?? null) : null,
    outputExpired: expired && (step.payloadSummary?.hadOutput ?? step.startedAt !== null),
    failureReason: stepFailureReason(step, expired),
    isAgent: step.agentExecutionId !== null,
    completion: executionCompletion(execution, expired),
  };
}

function detailRunPayload(
  run: TriggerRunRecord,
  receipt: ProviderEventReceiptRecord,
  expired: boolean,
) {
  const receiptHidden = expired || receipt.payloadExpiryState != null;
  return {
    ...webhookSummaryView(receipt, receiptHidden),
    ...runPayloadMetadata(run, receipt, expired),
    prompt: detailPrompt(run.prompt, receipt.source, receiptHidden),
  };
}

function webhookSummaryView(receipt: ProviderEventReceiptRecord, receiptHidden: boolean) {
  return !receiptHidden && receipt.source === "webhook.received"
    ? { webhookSummary: summarizeTrigger(receipt.source, receipt.payload) }
    : {};
}

function runPayloadMetadata(
  run: TriggerRunRecord,
  receipt: ProviderEventReceiptRecord,
  expired: boolean,
) {
  return {
    repo: expired ? (run.payloadSummary?.repository ?? null) : receipt.repo,
    payloadExpiredAt: isoOrNull(run.payloadExpiredAt),
    payloadSummary: run.payloadSummary ?? null,
  };
}

function detailPrompt(prompt: string, source: string, receiptHidden: boolean): string | null {
  if (receiptHidden || source === "webhook.received" || prompt === "") return null;
  return prompt;
}

export function activityRunView(
  activity: ProjectActivityRunRecord,
  executions: (AgentExecutionRecord | undefined)[],
) {
  const { run, receipt, steps } = activity;
  const expired = run.payloadExpiredAt != null;
  const receiptHidden = expired || receipt.payloadExpiryState != null;
  const base = {
    id: run.id,
    providerEventReceiptId: run.providerEventReceiptId,
    provider: receipt.provider,
    deliveryId: receipt.deliveryId,
    source: receipt.source,
    ...webhookSummaryView(receipt, receiptHidden),
    ...runPayloadMetadata(run, receipt, expired),
    receivedAt: receipt.receivedAt.toISOString(),
    rawPayload: receiptHidden ? null : jsonValue(receipt.payload),
    configuredTriggerName: run.configuredTriggerName,
    ...activityRunContent(run, expired),
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    steps: steps.map((step, index) => activityStepRunView(step, executions[index], expired)),
  };
  if (run.outcome === "rejected")
    return {
      ...base,
      outcome: run.outcome,
      status: run.status,
      deadlineAt: null,
      deadlineKind: null,
      failureReason: formatInvocationRejection(run.rejection),
      rejectionReason: formatInvocationRejection(run.rejection),
    };
  return {
    ...base,
    outcome: run.outcome,
    status: run.status,
    deadlineAt: run.deadlineAt.toISOString(),
    deadlineKind: run.deadlineKind,
    failureReason: displayFailureReason(run.failureReason),
    rejectionReason: null,
  };
}

function activityRunContent(run: TriggerRunRecord, expired: boolean) {
  return {
    prompt: expired ? null : run.prompt,
    inputs: expired ? null : jsonValue(run.inputs),
    values: expired ? null : jsonValue(run.values),
    triggerContext: expired ? null : jsonValue(run.triggerContext),
    outputContext: expired ? null : jsonValue(run.outputContext),
  };
}

function activityStepRunView(
  step: WorkflowStepRunRecord,
  execution: AgentExecutionRecord | undefined,
  expired: boolean,
) {
  return {
    agentId: execution?.daemonAgentId ?? null,
    agentSessionId: execution?.agentSessionId ?? null,
    agentSessionAction: execution?.agentSessionAction ?? null,
    agentExecutionId: step.agentExecutionId,
    id: step.id,
    stepId: step.stepId,
    ordinal: step.ordinal,
    status: step.status,
    deadlineAt: isoOrNull(step.deadlineAt),
    idleDeadlineAt: isoOrNull(step.idleDeadlineAt),
    deadlineKind: step.deadlineKind,
    startedAt: isoOrNull(step.startedAt),
    output: expired ? null : jsonValue(step.output),
    payloadSummary: step.payloadSummary,
    completion: executionCompletion(execution, expired),
    failureReason: stepFailureReason(step, expired),
    completedAt: isoOrNull(step.completedAt),
  };
}

function stepFailureReason(step: WorkflowStepRunRecord, expired: boolean) {
  return expired
    ? (step.payloadSummary?.failureCode ?? null)
    : displayFailureReason(step.failureReason);
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function executionCompletion(execution: AgentExecutionRecord | undefined, expired: boolean) {
  if (execution === undefined) return null;
  return expired ? (execution.payloadCompletion ?? null) : payloadCompletion(execution);
}

export function displayFailureReason(reason: string | null): string | null {
  const denial = decodeEntitlementDenialFailureReason(reason);
  return denial === undefined ? reason : entitlementDenialSummary(denial);
}

export function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]));
  return null;
}
