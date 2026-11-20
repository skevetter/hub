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

const TOOL_NAME = /^[A-Za-z0-9_.:/ -]{1,64}(?![\s\S])/u;
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

function toolName(value: unknown, scrub: TimelineScrubber): string {
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
  const finished = typeof item.status === "string" && Object.hasOwn(TOOL_STATUSES, item.status);
  if (!finished && item.status !== "running") return undefined;
  const hasCallId = typeof item.callId === "string" && item.callId.length > 0;
  if (!finished && !hasCallId) return undefined;
  const tool = toolName(item.name, scrub);
  const data: TimelineData = { tool, category: toolCategory(tool) };
  if (hasCallId) {
    const callId = item.callId!;
    const safe = scrub(callId, 64);
    data["callId"] =
      IDENTIFIER.test(callId) && safe === callId
        ? callId
        : createHash("sha256").update(callId).digest("hex").slice(0, 16);
  }
  if (finished) data["status"] = item.status!;
  return { kind: finished ? "tool_finished" : "tool_started", data };
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
      if (typeof event.error !== "string") return undefined;
      return { kind: "turn_failed", data: { error: scrub(event.error, 240) } };
    case "turn_canceled":
      if (typeof event.reason !== "string") return undefined;
      return { kind: "turn_canceled", data: { reason: scrub(event.reason, 120) } };
    case "permission_requested": {
      const candidate = event.request["toolName"];
      const safe = typeof candidate === "string" ? scrub(candidate, 64) : undefined;
      return {
        kind: "permission_requested",
        data: safe !== undefined && TOOL_NAME.test(safe) ? { tool: safe } : {},
      };
    }
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
  if (input.completion !== undefined && input.completion !== "inferred_from_turn_end")
    return undefined;
  if (input.exitCode != null && (!count(input.exitCode) || input.exitCode > 255)) return undefined;
  if (input.failure != null && typeof input.failure !== "string") return undefined;
  const data: TimelineData = { status: input.status, durationMs: input.durationMs };
  if (input.exitCode !== undefined) data["exitCode"] = input.exitCode;
  if (input.completion !== undefined) data["completion"] = input.completion;
  if (input.failure != null) data["failure"] = scrub(input.failure, 120);
  return { kind: "step_finished", data };
}

function runFinished(
  input: Extract<TimelineProjectionInput, { kind: "run_finished" }>,
  scrub: TimelineScrubber,
): ProjectedTimelineEvent | undefined {
  if (
    typeof input.status !== "string" ||
    !Object.hasOwn(RUN_STATUSES, input.status) ||
    !duration(input.durationMs) ||
    !count(input.stepRowsOmitted) ||
    !validStepCounts(input.steps)
  )
    return undefined;
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
    case "step_started": {
      if (input.type !== "agent" && input.type !== "script") return undefined;
      const data: TimelineData = { type: input.type };
      if (input.type === "agent" && input.agent !== undefined) {
        const agent: TimelineData = { provider: identifier(input.agent.provider, scrub) };
        if (input.agent.mode !== undefined) agent["mode"] = identifier(input.agent.mode, scrub);
        data["agent"] = agent;
      }
      return { kind: "step_started", data };
    }
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
