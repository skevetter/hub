import type { JsonValue } from "../config/compiler.js";
import type { AcceptedTriggerRunRecord, TriggerRunRecord } from "../db/types.js";

export const TIMELINE_KINDS = [
  "run_started",
  "step_started",
  "agent_started",
  "turn_started",
  "turn_ended",
  "tool_started",
  "tool_finished",
  "permission_requested",
  "permission_resolved",
  "turn_failed",
  "turn_canceled",
  "step_finished",
  "run_finished",
  "truncated",
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];
export interface TimelineData {
  [key: string]: JsonValue;
}
export type TimelineOrigin = "captured" | "derived";
export interface RunTimelineEvent {
  triggerRunId: string;
  organizationId: string;
  seq: number;
  kind: TimelineKind;
  at: Date;
  stepId: string;
  data: TimelineData;
}
export interface RunTimelineState {
  triggerRunId: string;
  organizationId: string;
  eventCount: number;
  byteCount: number;
  stepEndCount: number;
  stepEndBytes: number;
  stepRowsOmitted: number;
  droppedCount: number;
  sealedSeq: number | null;
  sealedAt: Date | null;
  origin: TimelineOrigin;
  expiredAt: Date | null;
}
export interface AppendRunTimelineEventInput {
  triggerRunId: string;
  organizationId: string;
  kind: TimelineKind;
  at: Date;
  stepId?: string;
  data: TimelineData;
  origin: TimelineOrigin;
  maxEvents?: number;
}
export type AppendRunTimelineEventResult =
  | { seq: number; inserted: boolean }
  | { reason: "sealed" | "cap" | "expired" }
  | undefined;
export type ProgressProviderName = "github" | "linear" | "slack";
export type ProgressMessageState =
  | "pending"
  | "creating"
  | "active"
  | "finished"
  | "gone"
  | "unavailable"
  | "refused"
  | "abandoned";
export interface RunProgressMessage {
  triggerRunId: string;
  organizationId: string;
  provider: ProgressProviderName;
  state: ProgressMessageState;
  externalRef: JsonValue | null;
  version: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastRenderedHash: string | null;
  lastEditAt: Date | null;
  lastRegularAttemptAt: Date | null;
  editCount: number;
  failedEdits: number;
  finalFailures: number;
  retryAt: Date | null;
  credentialKey: string | null;
  credentialRetryAt: Date | null;
  credentialRejectedUntil: Date | null;
  settleAt: Date | null;
  repeatFinal: boolean;
  visibility: "public" | "private" | "unknown" | null;
  visibilityCheckedAt: Date | null;
  failure: string | null;
  compensationRequestedGen: number;
  compensationDoneGen: number;
  compensationNotBefore: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface InsertRunProgressMessageInput {
  triggerRunId: string;
  organizationId: string;
  provider: ProgressProviderName;
  now: Date;
}
export interface ProgressCredentialCooldown {
  retryAt: Date | null;
  rejectedUntil: Date | null;
}
export interface RecordProgressCredentialCooldownInput extends ProgressCredentialCooldown {
  organizationId: string;
  triggerRunId: string;
  key: string;
}
export interface RunProgressLeaseInput {
  triggerRunId: string;
  organizationId: string;
  owner: string;
  now: Date;
}
export interface AdmitProgressWriteInput extends RunProgressLeaseInput {
  version: number;
  state: ProgressMessageState;
  key: string;
  reservation: "create" | "regular" | undefined;
}

type ProgressCooldownDecision = { status: "retry"; at: Date } | { status: "rejected" };
export type ProgressWriteAdmission =
  | { status: "admitted" }
  | { status: "lease_lost" }
  | ProgressCooldownDecision;

export function progressCooldownDecision(
  { retryAt, rejectedUntil }: ProgressCredentialCooldown,
  now: Date,
): ProgressCooldownDecision | undefined {
  if (rejectedUntil !== null && rejectedUntil > now) return { status: "rejected" };
  if (retryAt !== null && retryAt > now) return { status: "retry", at: retryAt };
  return undefined;
}

export interface UpdateRunProgressMessageInput extends RunProgressLeaseInput {
  version: number;
  releaseLease?: boolean;
  patch: Partial<
    Pick<
      RunProgressMessage,
      | "state"
      | "externalRef"
      | "lastRenderedHash"
      | "lastEditAt"
      | "lastRegularAttemptAt"
      | "editCount"
      | "failedEdits"
      | "finalFailures"
      | "retryAt"
      | "settleAt"
      | "repeatFinal"
      | "visibility"
      | "visibilityCheckedAt"
      | "failure"
    >
  >;
}
export function timelineAccountingBatchId(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new RangeError("Invalid timeline accounting batch ID");
  return value.toLowerCase();
}

export interface RunTimelineStore {
  appendRunTimelineEvent(input: AppendRunTimelineEventInput): Promise<AppendRunTimelineEventResult>;
  recordRunTimelineDrops(
    organizationId: string,
    runId: string,
    count: number,
    at: Date,
    batchId: string,
  ): Promise<{ seq: number; inserted: boolean; noticeSeq?: number } | undefined>;
  listRunTimelineEvents(
    organizationId: string,
    runId: string,
    page: { afterSeq: number; limit: number },
  ): Promise<RunTimelineEvent[]>;
  readRunTimelineState(
    organizationId: string,
    runId: string,
  ): Promise<RunTimelineState | undefined>;
  findTriggerRunForOrganization(
    organizationId: string,
    runId: string,
  ): Promise<TriggerRunRecord | undefined>;
  resolveRunForExecution(
    executionId: string,
  ): Promise<{ triggerRunId: string; organizationId: string; stepId: string } | undefined>;
  listUnsealedTerminalRuns(
    olderThan: Date,
    cutoff: Date,
    limit: number,
  ): Promise<AcceptedTriggerRunRecord[]>;
  expireRunTimelines(cutoff: Date, batch: number): Promise<number>;
  insertRunProgressMessageIfAbsent(
    input: InsertRunProgressMessageInput,
  ): Promise<RunProgressMessage | undefined>;
  findRunProgressMessage(
    organizationId: string,
    runId: string,
  ): Promise<RunProgressMessage | undefined>;
  acquireRunProgressLease(input: RunProgressLeaseInput): Promise<RunProgressMessage | undefined>;
  updateRunProgressMessage(
    input: UpdateRunProgressMessageInput,
  ): Promise<RunProgressMessage | undefined>;
  admitProgressWrite(input: AdmitProgressWriteInput): Promise<ProgressWriteAdmission>;
  readProgressCredentialCooldown(key: string): Promise<ProgressCredentialCooldown>;
  recordProgressCredentialCooldown(input: RecordProgressCredentialCooldownInput): Promise<void>;
  listRunProgressMessagesToFinish(
    now: Date,
    limit: number,
    settleThrough?: Date,
  ): Promise<RunProgressMessage[]>;
  listOpenRunProgressMessages(
    afterRunId: string | null,
    limit: number,
  ): Promise<RunProgressMessage[]>;
  requestCompensation(
    organizationId: string,
    runId: string,
    notBefore?: Date,
  ): Promise<number | undefined>;
  completeCompensation(organizationId: string, runId: string, observedGen: number): Promise<void>;
}
