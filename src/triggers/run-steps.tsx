import { useCallback, useState } from "react";
import { CodeBlock } from "../components/app/copy-field.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { Disclosure } from "../components/app/disclosure.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import type { ActivityRunDetail as RunDetail } from "../projects/activity-run-view.js";
import { isScriptStepOutput, ScriptStepOutput } from "../projects/script-step-output.js";
import type { RunEvent } from "./run-events.js";

const OUTPUT_LIMIT = 64 * 1024;
const STEP_COLUMNS = [
  { header: "Step", fill: true },
  { header: "Status" },
  { header: "Started" },
  { header: "Completed" },
  { header: "Output", fill: true },
  { header: "Failure reason", fill: true },
];
const EMPTY_STEPS = { title: "No steps" };

export function RunSteps({
  steps,
  events,
  terminal,
}: {
  steps: RunDetail["steps"];
  events: readonly RunEvent[];
  terminal: boolean;
}) {
  const live = new Map<string, RunEvent>();
  for (const event of events)
    if (event.kind === "step_started" || event.kind === "step_finished")
      live.set(event.stepId, event);
  return (
    <Section title="Steps">
      <DataTable
        label="Run steps"
        columns={STEP_COLUMNS}
        isEmpty={steps.length === 0}
        empty={EMPTY_STEPS}
      >
        {steps.map((step) => {
          const id =
            "timelineStepId" in step && typeof step.timelineStepId === "string"
              ? step.timelineStepId
              : step.stepId;
          const event = live.get(id);
          const { status, started, completed } = stepState(step, event, terminal);
          return (
            <DataRow key={step.id}>
              <DataCell>
                {step.ordinal + 1}. {step.stepId}
              </DataCell>
              <DataCell>
                <StatusPill tone={tone(status)}>{statusLabel(status)}</StatusPill>
              </DataCell>
              <DataCell muted>{time(started)}</DataCell>
              <DataCell muted>{time(completed)}</DataCell>
              <DataCell>
                <StepOutput step={step} status={status} />
                {event?.kind === "step_finished" &&
                typeof event.data["exitCode"] === "number" &&
                !isScriptStepOutput(step.output) ? (
                  <span>Exit code {event.data["exitCode"]}</span>
                ) : null}
              </DataCell>
              <DataCell muted>{step.failureReason ?? "-"}</DataCell>
            </DataRow>
          );
        })}
      </DataTable>
    </Section>
  );
}

function stepState(
  step: RunDetail["steps"][number],
  event: RunEvent | undefined,
  terminal: boolean,
) {
  let status: string = step.status;
  if (event?.kind === "step_finished" && typeof event.data["status"] === "string")
    status = event.data["status"];
  else if (
    event?.kind === "step_started" &&
    (step.status === "pending" || step.status === "running")
  )
    status = "running";
  if (terminal && (status === "pending" || status === "running")) status = "not_run";
  return {
    status,
    started: step.startedAt ?? (event?.kind === "step_started" ? event.at : null),
    completed: step.completedAt ?? (event?.kind === "step_finished" ? event.at : null),
  };
}

function StepOutput({ step, status }: { step: RunDetail["steps"][number]; status: string }) {
  const completion = step.isAgent ? step.completion : null;
  if (step.outputExpired || step.payloadSummary != null) return <ExpiredStepOutput step={step} />;
  if (!step.isAgent && isScriptStepOutput(step.output)) {
    return <ScriptStepOutput stepId={step.id} status={status} output={step.output} />;
  }
  let output = step.output;
  if (
    completion === "inferred_from_turn_end" &&
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    output = output["output"] ?? null;
  }
  return (
    <>
      {completion === null ? null : <span>Completion: {completion}</span>}
      {output === null ? "No output" : <PlainOutput id={step.id} value={output} />}
    </>
  );
}

function ExpiredStepOutput({ step }: { step: RunDetail["steps"][number] }) {
  const completion = step.completion;
  const summary = step.payloadSummary;
  return (
    <>
      {step.outputExpired ? <span>Output expired</span> : <span>No output</span>}
      {summary?.exitCode == null ? null : <span>Exit code {summary.exitCode}</span>}
      {summary?.truncated === true ? <span>Output was truncated</span> : null}
      {summary?.provider == null ? null : (
        <span>
          {summary.provider}
          {summary.model == null ? "" : ` / ${summary.model}`}
        </span>
      )}
      {completion === null ? null : <span>Completion: {completion}</span>}
    </>
  );
}

function PlainOutput({ id, value }: { id: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const showMore = useCallback(() => setExpanded(true), []);
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  const truncated = text.length > OUTPUT_LIMIT;
  return (
    <Disclosure
      id={`agent-output-${id}`}
      open={open}
      onOpenChange={setOpen}
      title="Output"
      {...(truncated ? { description: "Output limited to 65,536 characters." } : {})}
    >
      <CodeBlock label="Step output">
        {text === "" ? "(no output)" : text.slice(0, expanded ? OUTPUT_LIMIT : 4096)}
      </CodeBlock>
      {!expanded && text.length > 4096 ? (
        <button type="button" onClick={showMore}>
          Show more
        </button>
      ) : null}
    </Disclosure>
  );
}

function time(value: string | null) {
  return value === null ? "-" : <RelativeTime value={value} />;
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
