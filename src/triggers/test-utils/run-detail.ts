import type { RunDetailSnapshot, RunEvent, RunEventPage } from "../run-events.js";

export const emptyTimeline: RunEventPage = {
  events: [],
  status: "running",
  sealedSeq: null,
  stepRowsOmitted: 0,
  origin: "captured",
  expired: false,
  timelineEnabled: true,
  streamEnabled: true,
  retentionDays: 30,
  droppedCount: 0,
};
export const runDetailFixture: RunDetailSnapshot = {
  run: {
    id: "00000000-0000-4000-8000-000000000001",
    provider: "github",
    source: "pull_request_opened",
    repo: "example/service",
    receivedAt: "2026-11-16T10:00:00.000Z",
    configuredTriggerName: "Review changes",
    createdAt: "2026-11-16T10:00:00.000Z",
    completedAt: null,
    outcome: "accepted",
    status: "running",
    failureReason: null,
  },
  steps: [
    {
      id: "step-1",
      stepId: "review",
      timelineStepId: "review",
      ordinal: 0,
      status: "running",
      startedAt: "2026-11-16T10:00:00.000Z",
      completedAt: null,
      output: null,
      failureReason: null,
      isAgent: true,
      completion: null,
    },
  ],
  timeline: emptyTimeline,
  progress: null,
  progressMessagesEnabled: false,
};
export function runEvent(
  seq: number,
  kind: RunEvent["kind"],
  data: RunEvent["data"] = {},
  stepId = "review",
): RunEvent {
  return {
    seq,
    kind,
    data,
    stepId,
    at: new Date(Date.parse("2026-11-16T10:00:00.000Z") + seq * 1000).toISOString(),
  };
}
