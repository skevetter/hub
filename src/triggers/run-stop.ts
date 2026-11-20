import type { AgentExecutionRecord, TenantRouteAccess, TriggerRunRecord } from "../db/types.js";

export const stopCleanupStates = [
  "confirmed",
  "waiting_for_daemon",
  "delivery_unconfirmed",
  "target_gone",
  "not_needed",
] as const;
export type StopCleanupState = (typeof stopCleanupStates)[number];

export const stopCleanupNotes: Record<StopCleanupState, string | null> = {
  confirmed: "The daemon confirmed cleanup.",
  waiting_for_daemon: "Hub is waiting for the daemon to finish cleanup.",
  delivery_unconfirmed: "Hub could not confirm interrupt delivery.",
  target_gone: "The target agent or daemon is no longer available.",
  not_needed: "No daemon cleanup was needed.",
};

export const stopCoalescedNote = "Another Stop covered this run with the same interrupt.";

export interface StopConfirmation {
  confirmedPeerCount: number;
  retryAttemptId?: string;
}

export interface RunStopActor {
  organizationId: string;
  userId: string;
  role: TenantRouteAccess["membership"]["role"];
}

export interface RunStopDetails {
  stoppedByName: string | null;
  cleanupState: StopCleanupState;
  coalesced: boolean;
  retryAttemptId: string | null;
  otherAttachedRunCount: number;
}

export type StopRunResult =
  | { status: "conflict"; otherAttachedRunCount: number }
  | {
      status: "stopped";
      runId: string;
      runStatus: TriggerRunRecord["status"];
      cleanupState: StopCleanupState;
      coalesced?: true;
    }
  | { status: "forbidden" | "run_not_found" };

export type BrowserStopResult = Extract<StopRunResult, { status: "conflict" | "stopped" }>;

export type StopRun = (
  actor: RunStopActor,
  runId: string,
  confirmedPeerCount?: number,
  retryAttemptId?: string,
) => Promise<StopRunResult>;

export function canStopRun(actor: RunStopActor, run: TriggerRunRecord): boolean {
  return (
    actor.organizationId === run.organizationId &&
    (actor.role === "admin" || actor.role === "owner" || actor.userId === run.startedByUserId)
  );
}

export function isCanceledExecution(execution: AgentExecutionRecord): boolean {
  const { result, status } = execution;
  return (
    status === "failed" &&
    result !== null &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "canceled"
  );
}
