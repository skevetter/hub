import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CodeBlock } from "../components/app/copy-field.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { formatAbsolute } from "../components/app/relative-time.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { SummaryPanel } from "../components/app/summary-panel.js";
import { useRouteTenant } from "../projects/context.js";
import type { ActivityRunDetail as RunDetail } from "../projects/dashboard.js";
import { activityRunDetail } from "../projects/functions.js";
import { isScriptStepOutput, ScriptStepOutput } from "../projects/script-step-output.js";
import { useSnapshotQuery } from "../queries/index.js";

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

export function TriggerActivityRunPanel({ runId }: { runId: string }) {
  const tenant = useRouteTenant();
  const organizationSlug = tenant.organization.slug;
  const load = useServerFn(activityRunDetail);
  const snapshot = useSnapshotQuery({
    queryKey: ["activity-run", organizationSlug, runId],
    queryFn: () => load({ data: { organizationSlug, runId } }),
  });
  const active =
    snapshot.status === "success" &&
    snapshot.data !== null &&
    snapshot.data.run.completedAt === null;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(snapshot.refetch, 5_000);
    return () => clearInterval(timer);
  }, [active, snapshot.refetch]);
  if (snapshot.status === "pending")
    return <PageHeader title="Run detail" description="Loading run…" />;
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Run unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load this run."
        onRetry={snapshot.refetch}
      />
    );
  }
  if (snapshot.data === null) {
    return (
      <>
        <PageHeader title="Run not found" description="This run is unavailable." />
        <a href={`/o/${encodeURIComponent(organizationSlug)}/activity`}>Back to activity</a>
      </>
    );
  }
  return <ActivityRunDetail detail={snapshot.data} />;
}

export function ActivityRunDetail({ detail }: { detail: RunDetail }) {
  const { run, steps } = detail;
  const status = useMemo(
    () => ({ label: statusLabel(run.status), tone: tone(run.status) }),
    [run.status],
  );
  const rows = useMemo(
    () => [
      { label: "Source", value: run.source },
      { label: "Repository", value: run.repo ?? "—" },
      { label: "Received", value: time(run.receivedAt) },
      { label: "Created", value: time(run.createdAt) },
      { label: "Completed", value: time(run.completedAt) },
      {
        label: "Duration",
        value:
          run.completedAt === null
            ? "—"
            : `${String(Math.max(0, Date.parse(run.completedAt) - Date.parse(run.createdAt)) / 1000)}s`,
      },
      { label: "Outcome", value: run.outcome === null ? "—" : statusLabel(run.outcome) },
      { label: "Failure reason", value: run.failureReason ?? "—" },
    ],
    [run],
  );
  return (
    <>
      <PageHeader
        title="Run detail"
        description={`${run.provider} · ${run.configuredTriggerName}`}
        status={status}
      />
      <SummaryPanel label="Run" rows={rows} />
      <h2>Steps</h2>
      <DataTable
        label="Run steps"
        columns={STEP_COLUMNS}
        isEmpty={steps.length === 0}
        empty={EMPTY_STEPS}
      >
        {steps.map((step) => (
          <DataRow key={step.id}>
            <DataCell>
              {step.ordinal + 1}. {step.stepId}
            </DataCell>
            <DataCell>
              <StatusPill tone={tone(step.status)}>{statusLabel(step.status)}</StatusPill>
            </DataCell>
            <DataCell muted>{time(step.startedAt)}</DataCell>
            <DataCell muted>{time(step.completedAt)}</DataCell>
            <DataCell>
              <StepOutput step={step} />
            </DataCell>
            <DataCell muted>{step.failureReason ?? "—"}</DataCell>
          </DataRow>
        ))}
      </DataTable>
    </>
  );
}

function StepOutput({ step }: { step: RunDetail["steps"][number] }) {
  if (step.output === null) return "No output";
  if (step.agentExecutionId === null && isScriptStepOutput(step.output)) {
    return <ScriptStepOutput stepId={step.id} status={step.status} output={step.output} />;
  }
  return <PlainOutput id={step.id} value={step.output} />;
}

function PlainOutput({ id, value }: { id: string; value: unknown }) {
  const [open, setOpen] = useState(false);
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
        {text === "" ? "(no output)" : text.slice(0, OUTPUT_LIMIT)}
      </CodeBlock>
    </Disclosure>
  );
}

function time(value: string | null) {
  return value === null ? "—" : <time dateTime={value}>{formatAbsolute(value)}</time>;
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
