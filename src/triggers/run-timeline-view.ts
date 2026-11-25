import type { RunEvent } from "./run-events.js";

export interface TimelineRow {
  key: string;
  seq: number;
  at: string;
  label: string;
  detail: string;
  category: string | null;
  tool: boolean;
}

const labels: Record<RunEvent["kind"], string> = {
  run_started: "Run started",
  step_started: "Step started",
  agent_started: "Agent started",
  turn_started: "Turn started",
  turn_ended: "Turn ended",
  tool_started: "Tool running",
  tool_finished: "Tool finished",
  permission_requested: "Waiting for permission",
  permission_resolved: "Permission resolved",
  turn_failed: "Turn failed",
  turn_canceled: "Turn canceled",
  step_finished: "Step finished",
  run_finished: "Run finished",
  truncated: "Timeline truncated",
};

export function timelineRows(events: readonly RunEvent[], droppedCount: number): TimelineRow[] {
  const labelFor = timelineLabels(events);
  const rows: TimelineRow[] = [];
  const calls = new Map<string, TimelineRow>();
  const permissions = new Map<string, TimelineRow[]>();
  for (const event of events) {
    const { kind, data, stepId, seq } = event;
    const tool = kind === "tool_started" || kind === "tool_finished";
    const callId = text(data["callId"]);
    const key = tool && callId !== "" ? `${stepId}\0${callId}` : `seq:${String(seq)}`;
    const row = timelineRow(event, { key, tool, labelFor, droppedCount });
    if (absorbRow({ calls, permissions }, event, row)) continue;
    rows.push(row);
  }
  return rows.sort((left, right) => left.seq - right.seq);
}

interface RowState {
  calls: Map<string, TimelineRow>;
  permissions: Map<string, TimelineRow[]>;
}

// Returns true when the row was folded into an earlier row and must not be listed again.
function absorbRow(state: RowState, event: RunEvent, row: TimelineRow): boolean {
  if (event.kind === "tool_started" || event.kind === "tool_finished") {
    return absorbTool(state.calls, event, row);
  }
  if (event.kind === "permission_requested") {
    const pending = state.permissions.get(event.stepId) ?? [];
    pending.push(row);
    state.permissions.set(event.stepId, pending);
    return false;
  }
  if (event.kind === "permission_resolved") return absorbResolved(state.permissions, event.stepId);
  return false;
}

function absorbTool(calls: Map<string, TimelineRow>, event: RunEvent, row: TimelineRow): boolean {
  const previous = calls.get(row.key);
  if (previous !== undefined) {
    if (event.kind === "tool_finished" || previous.label !== labels.tool_finished) {
      previous.label = row.label;
      previous.detail = row.detail;
    }
    return true;
  }
  if (text(event.data["callId"]) !== "") calls.set(row.key, row);
  return false;
}

function absorbResolved(permissions: Map<string, TimelineRow[]>, stepId: string): boolean {
  const pending = permissions.get(stepId)?.shift();
  if (pending === undefined) return false;
  pending.label = "Permission resolved";
  pending.detail = `Permission resolved${stepId === "" ? "" : ` - ${stepId}`}`;
  return true;
}

function timelineRow(
  event: RunEvent,
  options: {
    key: string;
    tool: boolean;
    labelFor: (event: RunEvent) => string;
    droppedCount: number;
  },
): TimelineRow {
  return {
    key: options.key,
    seq: event.seq,
    at: event.at,
    label: options.labelFor(event),
    detail: eventDetail(event, options.droppedCount),
    category: options.tool ? text(event.data["category"]) : null,
    tool: options.tool,
  };
}

function timelineLabels(events: readonly RunEvent[]) {
  let runFinishedSeq = -Infinity;
  const stepFinishedSeqs = new Map<string, number>();
  for (const { kind, stepId, seq } of events) {
    if (kind === "run_finished") runFinishedSeq = Math.max(runFinishedSeq, seq);
    if (kind === "step_finished")
      stepFinishedSeqs.set(stepId, Math.max(stepFinishedSeqs.get(stepId) ?? -Infinity, seq));
  }
  return ({ kind, stepId, seq }: RunEvent) =>
    kind === "tool_started" &&
    seq < Math.max(runFinishedSeq, stepFinishedSeqs.get(stepId) ?? -Infinity)
      ? "Tool called"
      : labels[kind];
}

interface DetailInput {
  data: RunEvent["data"];
  stepId: string;
  droppedCount: number;
}

function joinDetail(parts: readonly string[]): string {
  return parts.filter(Boolean).join(" - ");
}

function stepIdDetail({ stepId }: DetailInput): string {
  return stepId;
}

function toolDetail({ data, stepId }: DetailInput): string {
  return joinDetail([text(data["tool"]), text(data["status"]), stepId]);
}

function permissionRequestedDetail({ data }: DetailInput): string {
  return `Waiting for permission${text(data["tool"]) === "" ? "" : `: ${text(data["tool"])}`}`;
}

function truncatedDetail({ data, droppedCount }: DetailInput): string {
  return `${String(Math.max(droppedCount, typeof data["dropped"] === "number" ? data["dropped"] : 0))} events dropped`;
}

function stepFinishedDetail({ data, stepId }: DetailInput): string {
  return joinDetail([
    stepId,
    text(data["status"]),
    typeof data["exitCode"] === "number" ? `Exit code ${String(data["exitCode"])}` : "",
    text(data["failure"]),
  ]);
}

const detailByKind: Record<RunEvent["kind"], (input: DetailInput) => string> = {
  run_started: stepIdDetail,
  step_started: stepIdDetail,
  agent_started: stepIdDetail,
  turn_started: stepIdDetail,
  turn_ended: stepIdDetail,
  tool_started: toolDetail,
  tool_finished: toolDetail,
  permission_requested: permissionRequestedDetail,
  permission_resolved: stepIdDetail,
  turn_failed: ({ data }) => text(data["error"]),
  turn_canceled: ({ data }) => text(data["reason"]),
  step_finished: stepFinishedDetail,
  run_finished: ({ data }) => joinDetail([text(data["status"]), text(data["failure"])]),
  truncated: truncatedDetail,
};

function eventDetail({ kind, data, stepId }: RunEvent, droppedCount: number) {
  const detail = Object.hasOwn(detailByKind, kind) ? detailByKind[kind] : stepIdDetail;
  return detail({ data, stepId, droppedCount });
}

export function activityCounts(rows: readonly TimelineRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows)
    if (row.tool && row.category !== null)
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  const names: Record<string, [string, string]> = {
    command: ["command", "commands"],
    read: ["read", "reads"],
    edit: ["edit", "edits"],
    web: ["web request", "web requests"],
    subagent: ["subagent", "subagents"],
    plan: ["plan", "plans"],
    mcp: ["MCP call", "MCP calls"],
    finish: ["completion", "completions"],
    other: ["other tool", "other tools"],
  };
  return (
    Object.entries(names)
      .flatMap(([category, words]) => {
        const count = counts.get(category) ?? 0;
        return count === 0 ? [] : [`${String(count)} ${words[count === 1 ? 0 : 1]}`];
      })
      .join(", ") || "No tool activity recorded"
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
