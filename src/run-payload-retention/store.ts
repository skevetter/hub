import type { ReceiptPayloadStore } from "./receipt-store.js";
import type { RunProgressMessage } from "../run-timeline/store.js";

export type RunPayloadDisposition =
  | "eligible"
  | "live"
  | "fan_out_unresolved"
  | "cleanup_blocked"
  | "missing_completion"
  | "notification_pending"
  | "reporter_pending"
  | "not_old_enough";

export interface RunPayloadCandidate {
  id: string;
  disposition: RunPayloadDisposition;
  ageFrom: Date;
}

export type AuxiliaryPayloadKind = "launchIntent" | "session" | "machine";

export type AuxiliaryPayloadDisposition =
  | "eligible"
  | "flag_unknown"
  | "pending_hub_action"
  | "live_owner"
  | "unbound_session"
  | "incomplete_bootstrap"
  | "unused_session"
  | "not_old_enough"
  | "machine_legacy";

export interface AuxiliaryPayloadCandidate {
  id: string;
  disposition: AuxiliaryPayloadDisposition;
  ageFrom: Date | null;
}

export interface RunPayloadRetentionStore extends ReceiptPayloadStore {
  scanUnknownTemporaryCredentials(after: string | null, limit: number): Promise<string[]>;
  backfillTemporaryCredentialFact(id: string): Promise<boolean>;
  scanAuxiliaryPayloads(
    kind: AuxiliaryPayloadKind,
    after: string | null,
    cutoff: Date,
    limit: number,
  ): Promise<AuxiliaryPayloadCandidate[]>;
  expireLaunchIntent(id: string, cutoff: Date, now: Date): Promise<boolean>;
  reduceSessionOptions(id: string, cutoff: Date, now: Date): Promise<boolean>;
  scanRunPayloads(
    after: string | null,
    cutoff: Date,
    limit: number,
    countOnly: boolean,
  ): Promise<RunPayloadCandidate[]>;
  expireRunPayloadChunk(
    id: string,
    cutoff: Date,
    now: Date,
  ): Promise<"expiring" | "expired" | "skipped">;
}

export function isProgressUnsettled(message: RunProgressMessage): boolean {
  return (
    message.leaseOwner !== null ||
    message.leaseExpiresAt !== null ||
    message.state === "pending" ||
    message.state === "creating" ||
    message.state === "active" ||
    message.settleAt !== null ||
    message.repeatFinal ||
    message.compensationRequestedGen > message.compensationDoneGen
  );
}

export const PROGRESS_UNSETTLED_SQL = `(
  message.lease_owner is not null or message.lease_expires_at is not null
  or message.state in ('pending', 'creating', 'active') or message.settle_at is not null
  or message.repeat_final or message.compensation_requested_gen > message.compensation_done_gen
)`;

export const PENDING_SCRIPT_CLEANUP_SQL = `step.agent_execution_id is null
  and step.status in ('succeeded', 'failed', 'timed_out')
  and ((step.output ->> 'daemon_id') is not null or (step.output -> 'cleanup') is not null)`;

export const SCRIPT_CLEANUP_SQL = `(${PENDING_SCRIPT_CLEANUP_SQL}) or
  (step.agent_execution_id is null and (step.output ->> 'daemon_id') is not null and (step.output ->> 'cwd') is not null)`;
