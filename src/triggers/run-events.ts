import { z } from "zod";
import { TIMELINE_KINDS } from "../run-timeline/store.js";
import type { ActivityRunDetail } from "../projects/activity-run-view.js";
import type { RunStopDetails } from "./run-stop.js";
import type { ProgressMessageState, ProgressProviderName } from "../run-timeline/store.js";
import type { RunReplyRecord } from "../run-replies/store.js";

export interface RunDetailSnapshot extends Omit<ActivityRunDetail, "steps"> {
  steps: (ActivityRunDetail["steps"][number] & { timelineStepId: string })[];
  timeline: RunEventPage;
  canStop?: boolean;
  stopDetails?: RunStopDetails;
  progressMessagesEnabled: boolean;
  progressUnavailable?: boolean;
  reply?: Pick<RunReplyRecord, "state" | "failure">;
  progress: {
    state: ProgressMessageState;
    provider: ProgressProviderName;
    failure: string | null;
  } | null;
}

export const runEventSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(TIMELINE_KINDS),
  at: z.string().datetime(),
  stepId: z.string(),
  data: z.record(z.string(), z.json()),
});
export type RunEvent = z.infer<typeof runEventSchema>;
export const runEventStatusSchema = z.object({
  status: z.string(),
  sealedSeq: z.number().int().nonnegative().nullable(),
  stepRowsOmitted: z.number().int().nonnegative(),
  origin: z.enum(["captured", "derived"]).nullable().optional(),
});
export interface RunEventPage {
  events: RunEvent[];
  status: string;
  sealedSeq: number | null;
  stepRowsOmitted: number;
  origin: "captured" | "derived" | null;
  expired: boolean;
  timelineEnabled: boolean;
  timelineUnavailable: boolean;
  streamEnabled: boolean;
  retentionDays: number;
  droppedCount: number;
}
export type RunConnection = "Live" | "Reconnecting" | "Polling" | null;

export function timelineRead(lastSeq: number, sealedSeq: number | null): boolean {
  return sealedSeq !== null && lastSeq >= sealedSeq;
}

export function mergeRunEvents(
  current: readonly RunEvent[],
  incoming: readonly RunEvent[],
): RunEvent[] {
  const rows = new Map(current.map((row) => [row.seq, row]));
  for (const row of incoming) if (!rows.has(row.seq)) rows.set(row.seq, row);
  return [...rows.values()].sort((left, right) => left.seq - right.seq);
}
