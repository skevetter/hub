import type { AcceptedTriggerRunRecord, WorkflowStepRunRecord } from "../db/types.js";
import { TOOL_CATEGORIES } from "../run-timeline/categories.js";
import { failurePhrase } from "../run-timeline/failures.js";
import type { ProgressProviderName, RunTimelineEvent } from "../run-timeline/store.js";

export interface ProgressRenderInput {
  run: AcceptedTriggerRunRecord;
  steps: readonly WorkflowStepRunRecord[];
  events: readonly RunTimelineEvent[];
  provider: ProgressProviderName;
  maxBodyChars: number;
  publicBaseUrl?: string | undefined;
  organizationSlug?: string | undefined;
}

const categoryLabels = {
  command: ["command", "commands"],
  read: ["read", "reads"],
  edit: ["edit", "edits"],
  web: ["web call", "web calls"],
  subagent: ["subagent", "subagents"],
  plan: ["plan", "plans"],
  mcp: ["MCP call", "MCP calls"],
  finish: ["finish call", "finish calls"],
  other: ["other call", "other calls"],
} as const;

function utc(value: Date): string {
  return value.toISOString().slice(11, 19) + " UTC";
}

function duration(start: Date, end: Date): string {
  const seconds = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function activity(events: readonly RunTimelineEvent[]): string {
  const calls = new Map<string, { category: unknown; failed: boolean }>();
  for (const event of events) {
    if (event.kind !== "tool_started" && event.kind !== "tool_finished") continue;
    const { callId, category, status } = event.data;
    const key = JSON.stringify([event.stepId, callId ?? event.seq]);
    const previous = calls.get(key);
    calls.set(key, {
      category: category ?? previous?.category,
      failed: previous?.failed === true || status === "failed",
    });
  }
  const categories = [...calls.values()];
  const counts = TOOL_CATEGORIES.flatMap((category) => {
    const count = categories.filter((call) => call.category === category).length;
    return count === 0 ? [] : [`${count} ${categoryLabels[category][count === 1 ? 0 : 1]}`];
  });
  const failures = categories.filter((call) => call.failed).length;
  return `Activity: ${counts.length ? counts.join(", ") + ". " : ""}${calls.size} tool ${calls.size === 1 ? "call" : "calls"}, ${failures} failed.`;
}

function runLink(input: ProgressRenderInput): string | undefined {
  if (input.publicBaseUrl === undefined || input.organizationSlug === undefined) return undefined;
  const url = URL.parse(input.publicBaseUrl);
  if (url === null || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    return undefined;
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/o/${encodeURIComponent(input.organizationSlug)}/activity/${encodeURIComponent(input.run.id)}`;
  url.search = "";
  url.hash = "";
  const href = url.href.replace(/[<>"'\x60]/gu, (character) => encodeURIComponent(character));
  return `Run details: ${href}`;
}

export function renderProgress(input: ProgressRenderInput): string {
  const { run, events, steps, provider, maxBodyChars } = input;
  const started = events.find((event) => event.kind === "run_started")?.at ?? run.createdAt;
  const lines: string[] = [];
  if (run.status === "running") {
    const latest = events.at(-1)?.at ?? started;
    const permission = events.findLast(
      (event) =>
        event.kind === "permission_requested" ||
        event.kind === "permission_resolved" ||
        event.kind === "step_finished" ||
        event.kind === "turn_ended" ||
        event.kind === "turn_failed" ||
        event.kind === "turn_canceled",
    );
    lines.push("Paseo run: Running", `Started ${utc(started)}. Updated ${utc(latest)}.`);
    if (permission?.kind === "permission_requested") lines.push("Now: waiting for permission");
    lines.push(activity(events));
    const step = steps.find(({ status }) => status === "running");
    if (step?.startedAt != null) {
      const position = steps.indexOf(step) + 1;
      lines.push(`Step ${position} of ${steps.length} running since ${utc(step.startedAt)}.`);
    }
  } else {
    const finished = run.completedAt ?? started;
    const elapsed = duration(started, finished);
    if (run.status === "succeeded") lines.push(`Paseo run: Succeeded in ${elapsed}`);
    else {
      const failure = failurePhrase(run.failureReason, run.status);
      const status = run.status === "timed_out" ? "Timed out" : "Failed";
      lines.push(`Paseo run: ${status} in ${elapsed}: ${failure.phrase} (${failure.code}).`);
    }
    lines.push(`Finished ${utc(finished)}.`, activity(events));
    const outcomes = [
      ["succeeded", "succeeded"],
      ["failed", "failed"],
      ["timed_out", "timed out"],
      ["skipped", "skipped"],
      ["pending", "not run"],
    ] as const;
    const counts = outcomes.flatMap(([status, label]) => {
      const count = steps.filter(
        (step) => step.status === status || (status === "pending" && step.status === "running"),
      ).length;
      return count ? [`${count} ${label}`] : [];
    });
    lines.push(`Steps: ${counts.length ? counts.join(", ") : "0 succeeded"} of ${steps.length}.`);
  }

  if (provider === "github" && /^[0-9a-f-]{36}$/iu.test(run.id)) {
    lines.unshift(`<!-- paseo-hub-progress run=${run.id} -->`);
  }
  const escape = (text: string) =>
    provider === "slack"
      ? text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      : text;
  const body = escape(lines.join("\n"));
  const link = runLink(input);
  if (link !== undefined && body.length + escape(link).length + 1 <= maxBodyChars) {
    return body + "\n" + escape(link);
  }
  if (body.length <= maxBodyChars) return body;
  return escape(lines[0]!).length <= maxBodyChars ? escape(lines[0]!) : "";
}
