import type { DaemonAgentStreamEvent } from "../daemons/protocol.js";
import type { TimelineData, TimelineKind } from "./store.js";

export interface TimelineRunScope {
  organizationId: string;
  triggerRunId: string;
}

export interface ProjectedTimelineEvent {
  kind: TimelineKind;
  data: TimelineData;
}

export interface TimelineStepCounts {
  succeeded: number;
  failed: number;
  timed_out: number;
  skipped: number;
  not_run: number;
  total: number;
}

export type TimelineScrubber = (value: string, maxBytes: number) => string;

export type TimelineProjectionInput =
  | { kind: "agent_event"; event: DaemonAgentStreamEvent }
  | { kind: "run_started"; trigger: string; steps: number }
  | { kind: "step_started"; type: "agent" | "script"; agent?: { provider: string; mode?: string } }
  | {
      kind: "step_finished";
      status: "succeeded" | "failed" | "timed_out" | "skipped";
      durationMs: number;
      exitCode?: number | null;
      completion?: "inferred_from_turn_end";
      failure?: string | null;
    }
  | {
      kind: "run_finished";
      status: "succeeded" | "failed" | "timed_out";
      durationMs: number;
      failure?: string | null;
      steps: TimelineStepCounts;
      stepRowsOmitted: number;
    };

export interface TimelineQueue {
  run(scope: TimelineRunScope, operation: () => Promise<void>): Promise<void>;
}
