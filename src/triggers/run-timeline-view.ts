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
  const rows: TimelineRow[] = [];
  const calls = new Map<string, TimelineRow>();
  const permissions = new Map<string, TimelineRow[]>();
  for (const event of events) {
    const { kind, data, stepId } = event;
    const tool = kind === "tool_started" || kind === "tool_finished";
    const callId = text(data["callId"]);
    const key = tool && callId !== "" ? `${stepId}\0${callId}` : `seq:${String(event.seq)}`;
    const row: TimelineRow = {
      key,
      seq: event.seq,
      at: event.at,
      label: labels[kind],
      detail: eventDetail(event, droppedCount),
      category: tool ? text(data["category"]) : null,
      tool,
    };
    switch (kind) {
      case "tool_started":
      case "tool_finished": {
        const previous = tool && callId !== "" ? calls.get(key) : undefined;
        if (previous !== undefined) {
          previous.label = row.label;
          previous.detail = row.detail;
          continue;
        }
        if (callId !== "") calls.set(key, row);
        break;
      }
      case "permission_requested": {
        const pending = permissions.get(stepId) ?? [];
        pending.push(row);
        permissions.set(stepId, pending);
        break;
      }
      case "permission_resolved": {
        const pending = permissions.get(stepId)?.shift();
        if (pending !== undefined) {
          pending.label = "Permission resolved";
          pending.detail = `Permission resolved${stepId === "" ? "" : ` - ${stepId}`}`;
          continue;
        }
        break;
      }
    }
    rows.push(row);
  }
  return rows.sort((left, right) => left.seq - right.seq);
}

function eventDetail({ kind, data, stepId }: RunEvent, droppedCount: number) {
  switch (kind) {
    case "tool_started":
    case "tool_finished":
      return [text(data["tool"]), text(data["status"]), stepId].filter(Boolean).join(" - ");
    case "permission_requested":
      return `Waiting for permission${text(data["tool"]) === "" ? "" : `: ${text(data["tool"])}`}`;
    case "truncated":
      return `${String(Math.max(droppedCount, typeof data["dropped"] === "number" ? data["dropped"] : 0))} events dropped`;
    case "turn_failed":
      return text(data["error"]);
    case "turn_canceled":
      return text(data["reason"]);
    case "step_finished":
      return [
        stepId,
        text(data["status"]),
        typeof data["exitCode"] === "number" ? `Exit code ${String(data["exitCode"])}` : "",
        text(data["failure"]),
      ]
        .filter(Boolean)
        .join(" - ");
    case "run_finished":
      return [text(data["status"]), text(data["failure"])].filter(Boolean).join(" - ");
    default:
      return stepId;
  }
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
