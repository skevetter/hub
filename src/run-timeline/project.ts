import { createHash } from "node:crypto";
import type { DaemonAgentStreamEvent } from "../daemons/protocol.js";
import { toolCategory } from "./categories.js";
import type {
  ProjectedTimelineEvent,
  TimelineProjectionInput,
  TimelineScrubber,
  TimelineStepCounts,
} from "./capture-types.js";
import type { TimelineData } from "./store.js";

export const TOOL_NAME = /^[A-Za-z0-9_.:/ -]{1,64}(?![\s\S])/u;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}(?![\s\S])/u;
const STEP_STATUSES: Readonly<Record<string, true>> = {
  succeeded: true,
  failed: true,
  timed_out: true,
  canceled: true,
  skipped: true,
};
const RUN_STATUSES: Readonly<Record<string, true>> = {
  succeeded: true,
  failed: true,
  timed_out: true,
  canceled: true,
};
const TOOL_STATUSES: Readonly<Record<string, true>> = {
  completed: true,
  failed: true,
  canceled: true,
};

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function duration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function toolName(value: unknown, scrub: TimelineScrubber): string {
  if (typeof value !== "string") return "unnamed";
  const safe = scrub(value, 64);
  return TOOL_NAME.test(safe) ? safe : "unnamed";
}

function identifier(value: unknown, scrub: TimelineScrubber): string {
  if (typeof value !== "string") return "unknown";
  const safe = scrub(value, 64);
  return IDENTIFIER.test(safe) ? safe : "unknown";
}

function toolEvent(
  item: Extract<DaemonAgentStreamEvent, { type: "timeline" }>["item"],
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  if (item.type !== "tool_call") return undefined;
  const { status, callId } = item;
  if (typeof status !== "string") return undefined;
  const finished = Object.hasOwn(TOOL_STATUSES, status);
  const hasCallId = typeof callId === "string" && callId.length > 0;
  if (!finished && (status !== "running" || !hasCallId)) return undefined;
  const tool = toolName(item.name, scrub);
  const data: TimelineData = { tool, category: toolCategory(tool) };
  if (hasCallId) data["callId"] = projectCallId(callId, scrub);
  if (finished) data["status"] = status;
  return { kind: finished ? "tool_finished" : "tool_started", data };
}

function projectCallId(callId: string, scrub: TimelineScrubber) {
  const safe = scrub(callId, 64);
  return IDENTIFIER.test(callId) && safe === callId
    ? callId
    : createHash("sha256").update(callId).digest("hex").slice(0, 16);
}

function turnFailure(
  kind: "turn_failed" | "turn_canceled",
  value: unknown,
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  if (typeof value !== "string") return undefined;
  return kind === "turn_failed"
    ? { kind, data: { error: scrub(value, 240) } }
    : { kind, data: { reason: scrub(value, 120) } };
}

function permissionRequested(candidate: unknown, scrub: TimelineScrubber): ProjectedTimelineEvent {
  const safe = typeof candidate === "string" ? scrub(candidate, 64) : undefined;
  return {
    kind: "permission_requested",
    data: safe !== undefined && TOOL_NAME.test(safe) ? { tool: safe } : {},
  };
}

function agentEvent(
  event: DaemonAgentStreamEvent,
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  switch (event.type) {
    case "thread_started":
      return { kind: "agent_started", data: { provider: identifier(event.provider, scrub) } };
    case "turn_started":
      return { kind: "turn_started", data: {} };
    case "turn_completed":
      return { kind: "turn_ended", data: {} };
    case "turn_failed":
      return turnFailure(event.type, event.error, scrub);
    case "turn_canceled":
      return turnFailure(event.type, event.reason, scrub);
    case "permission_requested":
      return permissionRequested(event.request["toolName"], scrub);
    case "permission_resolved":
      return { kind: "permission_resolved", data: {} };
    case "attention_required":
      return undefined;
    case "timeline":
      return toolEvent(event.item, scrub);
    default: {
      const exhaustive: never = event;
      void exhaustive;
      return undefined;
    }
  }
}

function validStepCounts(steps: TimelineStepCounts | null | undefined): boolean {
  return (
    steps !== null &&
    steps !== undefined &&
    count(steps.succeeded) &&
    count(steps.failed) &&
    count(steps.timed_out) &&
    count(steps.skipped) &&
    (steps.canceled === undefined || count(steps.canceled)) &&
    count(steps.not_run) &&
    count(steps.total)
  );
}

function validStepResult(input: Extract<TimelineProjectionInput, { kind: "step_finished" }>) {
  return (
    (input.completion === undefined || input.completion === "inferred_from_turn_end") &&
    (input.exitCode == null || (count(input.exitCode) && input.exitCode <= 255)) &&
    (input.failure == null || typeof input.failure === "string")
  );
}

function stepFinished(
  input: Extract<TimelineProjectionInput, { kind: "step_finished" }>,
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  if (
    typeof input.status !== "string" ||
    !Object.hasOwn(STEP_STATUSES, input.status) ||
    !duration(input.durationMs)
  )
    return undefined;
  if (!validStepResult(input)) return undefined;
  const data: TimelineData = { status: input.status, durationMs: input.durationMs };
  if (input.exitCode !== undefined) data["exitCode"] = input.exitCode;
  if (input.completion !== undefined) data["completion"] = input.completion;
  if (input.failure != null) data["failure"] = scrub(input.failure, 120);
  return { kind: "step_finished", data };
}

function validRunHeader(input: Extract<TimelineProjectionInput, { kind: "run_finished" }>) {
  return (
    typeof input.status === "string" &&
    Object.hasOwn(RUN_STATUSES, input.status) &&
    duration(input.durationMs) &&
    count(input.stepRowsOmitted)
  );
}

function runFinished(
  input: Extract<TimelineProjectionInput, { kind: "run_finished" }>,
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  if (!validRunHeader(input) || !validStepCounts(input.steps)) return undefined;
  if (input.failure != null && typeof input.failure !== "string") return undefined;
  const steps = input.steps;
  const terminal =
    steps.succeeded + steps.failed + steps.timed_out + steps.skipped + (steps.canceled ?? 0);
  if (terminal + steps.not_run !== steps.total || input.stepRowsOmitted > terminal)
    return undefined;
  const data: TimelineData = {
    status: input.status,
    durationMs: input.durationMs,
    steps: {
      succeeded: steps.succeeded,
      failed: steps.failed,
      timed_out: steps.timed_out,
      skipped: steps.skipped,
      ...(steps.canceled === undefined ? {} : { canceled: steps.canceled }),
      not_run: steps.not_run,
      total: steps.total,
    },
    stepRowsOmitted: input.stepRowsOmitted,
  };
  if (input.failure != null) data["failure"] = scrub(input.failure, 120);
  return { kind: "run_finished", data };
}

function stepStarted(
  input: Extract<TimelineProjectionInput, { kind: "step_started" }>,
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  if (input.type !== "agent" && input.type !== "script") return undefined;
  const data: TimelineData = { type: input.type };
  if (input.type === "agent" && input.agent !== undefined) {
    const agent: TimelineData = { provider: identifier(input.agent.provider, scrub) };
    if (input.agent.mode !== undefined) agent["mode"] = identifier(input.agent.mode, scrub);
    data["agent"] = agent;
  }
  return { kind: "step_started", data };
}

export function projectTimelineEvent(
  input: TimelineProjectionInput,
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  switch (input.kind) {
    case "agent_event":
      return agentEvent(input.event, scrub);
    case "run_started":
      if (typeof input.trigger !== "string" || !count(input.steps)) return undefined;
      return {
        kind: "run_started",
        data: { trigger: scrub(input.trigger, 120), steps: input.steps },
      };
    case "step_started":
      return stepStarted(input, scrub);
    case "step_finished":
      return stepFinished(input, scrub);
    case "run_finished":
      return runFinished(input, scrub);
    default: {
      const exhaustive: never = input;
      void exhaustive;
      return undefined;
    }
  }
}
