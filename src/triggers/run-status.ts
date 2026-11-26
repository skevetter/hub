import type { TriggerRunRecord } from "../db/types.js";

export const FAILED_RUN_FILTER = "unsuccessful";
export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "timed_out",
  "rejected",
]);

/** Failed and timed out read as one outcome in lists; the run page keeps the exact status. */
export const DID_NOT_FINISH_FILTER = "did_not_finish";
export const DID_NOT_FINISH_STATUSES: ReadonlySet<string> = new Set(["failed", "timed_out"]);

export type RunStatusFilter =
  | TriggerRunRecord["status"]
  | typeof FAILED_RUN_FILTER
  | typeof DID_NOT_FINISH_FILTER;

export function runStatusesFor(filter: RunStatusFilter): ReadonlySet<string> {
  if (filter === FAILED_RUN_FILTER) return FAILED_RUN_STATUSES;
  return filter === DID_NOT_FINISH_FILTER ? DID_NOT_FINISH_STATUSES : new Set([filter]);
}
