import type { TriggerRunRecord } from "../db/types.js";

export const FAILED_RUN_FILTER = "unsuccessful";
export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "timed_out",
  "rejected",
]);

export type RunStatusFilter = TriggerRunRecord["status"] | typeof FAILED_RUN_FILTER;
