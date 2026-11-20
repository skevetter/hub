import type { AgentExecutionRecord, TenantRouteAccess, TriggerRunRecord } from "../db/types.js";

export const CANCELED_RUN_NOTE =
  "If the daemon was offline, Hub will retry cleanup when it reconnects.";

export interface RunStopActor {
  organizationId: string;
  userId: string;
  role: TenantRouteAccess["membership"]["role"];
}

export interface RunStopDetails {
  stoppedByName: string | null;
  cleanupPending: boolean;
  otherAttachedRunCount: number;
}

export type StopRunResult =
  | { status: "conflict"; otherAttachedRunCount: number }
  | {
      status: "stopped";
      runId: string;
      runStatus: TriggerRunRecord["status"];
      cleanupPending?: boolean;
    }
  | { status: "forbidden" | "run_not_found" };

export type BrowserStopResult = Extract<StopRunResult, { status: "conflict" | "stopped" }>;

export type StopRun = (
  actor: RunStopActor,
  runId: string,
  confirmedPeerCount?: number,
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
