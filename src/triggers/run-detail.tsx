import { useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { FollowBottom } from "../components/app/follow-bottom.js";
import { Duration } from "../components/app/duration.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { SummaryPanel } from "../components/app/summary-panel.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { useRouteTenant } from "../projects/context.js";
import { useSnapshotQuery } from "../queries/index.js";
import { runDetailSnapshot } from "./functions.js";
import type { RunConnection, RunDetailSnapshot, RunEventPage } from "./run-events.js";
import { RunSteps } from "./run-steps.js";
import { activityCounts, timelineRows, type TimelineRow } from "./run-timeline-view.js";
import { runDetailKey, useRunEvents } from "./use-run-events.js";
import { runReadClock, runReadResult } from "./run-read.js";

const TIMELINE_COLUMNS = [
  { header: "Time" },
  { header: "Event" },
  { header: "Detail", fill: true },
];
const EMPTY_TIMELINE = { title: "No timeline events yet" };
const NO_TOOL_EVENTS = { title: "No tool events recorded" };
const NO_EVENTS: RunEventPage["events"] = [];

export function RunDetailPanel({ runId }: { runId: string }) {
  const tenant = useRouteTenant();
  const organizationSlug = tenant.organization.slug;
  const load = useServerFn(runDetailSnapshot);
  const requests = runReadClock(useQueryClient());
  const snapshot = useSnapshotQuery({
    queryKey: runDetailKey(organizationSlug, runId),
    queryFn: async () => {
      const sequence = requests.issue();
      return runReadResult(sequence, await load({ data: { organizationSlug, runId } }));
    },
  });
  if (snapshot.status === "pending")
    return (
      <>
        <PageHeader title="Run detail" description="Loading run..." />
        <DataTableSkeleton label="Run timeline" columns={TIMELINE_COLUMNS} />
      </>
    );
  if (snapshot.status === "error" || snapshot.data.value === null)
    return (
      <Section>
        <FailureAlert
          title="Run unavailable"
          error={snapshot.error}
          fallback="This run is unavailable."
        />
        <a
          className="text-link hover:underline"
          href={`/o/${encodeURIComponent(organizationSlug)}/activity`}
        >
          Back to activity
        </a>
      </Section>
    );
  return (
    <LiveRunDetail
      key={`${organizationSlug}\0${runId}`}
      detail={snapshot.data.value}
      initialSequence={snapshot.data.sequence}
      organizationSlug={organizationSlug}
    />
  );
}

function LiveRunDetail({
  detail,
  organizationSlug,
  initialSequence,
}: {
  detail: RunDetailSnapshot;
  organizationSlug: string;
  initialSequence: number;
}) {
  const state = useRunEvents({
    organizationSlug,
    runId: detail.run.id,
    after: detail.timeline.events.at(-1)?.seq ?? 0,
    initial: detail.timeline,
    initialSequence,
  });
  return <RunDetailView detail={detail} timeline={state} connection={state.connection} />;
}

export function RunDetailView({
  detail,
  timeline = detail.timeline,
  connection = null,
}: {
  detail: RunDetailSnapshot;
  timeline?: RunEventPage;
  connection?: RunConnection;
}) {
  const { run } = detail;
  const events = timeline.expired ? NO_EVENTS : timeline.events;
  const rows = useMemo(
    () => timelineRows(events, timeline.droppedCount),
    [events, timeline.droppedCount],
  );
  const terminal = timeline.status !== "running";
  const summary = useMemo(
    () => runSummaryRows(detail, timeline, connection, rows),
    [detail, timeline, connection, rows],
  );
  const notice = timelineNotice(timeline);
  return (
    <>
      <div className="min-w-0 max-w-full overflow-hidden [&_p]:break-words">
        <PageHeader
          title="Run detail"
          description={`${run.webhookSummary === undefined ? run.provider : "Webhook"} - ${run.configuredTriggerName}`}
        />
      </div>
      {run.payloadExpiredAt == null ? null : (
        <NoticeAlert standalone tone="neutral" title="Run payload expired">
          This run's original event, inputs, prompts, and outputs expired under this Hub's retention
          policy.
        </NoticeAlert>
      )}
      <Section>
        <SummaryPanel label="Run" rows={summary} />
      </Section>
      <Section title="Timeline">
        {notice === null ? null : (
          <NoticeAlert tone="neutral" title={notice}>
            {timeline.origin === "derived" && !timeline.expired
              ? "No tool events were recorded for this run"
              : null}
          </NoticeAlert>
        )}
        {timeline.expired ? null : (
          <FollowBottom version={events.at(-1)?.seq ?? 0}>
            <DataTable
              label="Run timeline"
              columns={TIMELINE_COLUMNS}
              isEmpty={rows.length === 0}
              empty={notice === null ? EMPTY_TIMELINE : NO_TOOL_EVENTS}
            >
              {rows.map((row) => (
                <DataRow key={row.key}>
                  <DataCell muted>
                    <RelativeTime value={row.at} />
                  </DataCell>
                  <DataCell>{row.label}</DataCell>
                  <DataCell>{row.detail}</DataCell>
                </DataRow>
              ))}
            </DataTable>
          </FollowBottom>
        )}
      </Section>
      <RunSteps steps={detail.steps} events={events} terminal={terminal} />
    </>
  );
}

function runSummaryRows(
  detail: RunDetailSnapshot,
  timeline: RunEventPage,
  connection: RunConnection,
  rows: readonly TimelineRow[],
) {
  const { run } = detail;
  const events = timeline.events;
  const finished = events.find((event) => event.kind === "run_finished");
  const status = timeline.status;
  const completedAt = run.completedAt ?? finished?.at ?? null;
  const startedAt = detail.steps.reduce<string>(
    (earliest, step) =>
      step.startedAt !== null && step.startedAt < earliest ? step.startedAt : earliest,
    run.createdAt,
  );
  const durationMs =
    typeof finished?.data["durationMs"] === "number" ? finished.data["durationMs"] : null;
  return [
    {
      label: "Status",
      value: (
        <span className="flex items-center gap-2">
          <StatusPill tone={tone(status)}>{statusLabel(status)}</StatusPill>
          <ConnectionPill connection={connection} />
        </span>
      ),
    },
    {
      label: "Source",
      value: (
        <span className="flex items-center gap-2">
          <ProviderGlyph provider={run.provider} source={run.source} />
          {run.webhookSummary?.headline ?? run.source}
        </span>
      ),
    },
    { label: "Started", value: <RelativeTime value={startedAt} /> },
    {
      label: "Duration",
      value: (
        <Duration
          startedAt={startedAt}
          completedAt={completedAt}
          durationMs={durationMs}
          running={status === "running"}
        />
      ),
    },
    {
      label: "Activity",
      value:
        run.payloadSummary?.timelineCounts == null
          ? activityCounts(rows)
          : `${run.payloadSummary.timelineCounts.events} timeline events (${run.payloadSummary.timelineCounts.dropped} dropped)`,
    },
    ...(run.payloadSummary?.providerLink == null
      ? []
      : [
          {
            label: "Provider",
            value: (
              <a className="text-link hover:underline" href={run.payloadSummary.providerLink}>
                Open provider item
              </a>
            ),
          },
        ]),
    {
      label: "Progress message",
      value:
        run.payloadSummary?.progress.link == null ? (
          progressMessageLabel(detail)
        ) : (
          <a className="text-link hover:underline" href={run.payloadSummary.progress.link}>
            {progressMessageLabel(detail)}
          </a>
        ),
    },
    ...(run.webhookSummary?.prompt === undefined
      ? []
      : [{ label: "Message", value: run.webhookSummary.prompt }]),
    { label: "Repository", value: run.repo ?? "-" },
    { label: "Received", value: <RelativeTime value={run.receivedAt} /> },
    ...(completedAt === null
      ? []
      : [{ label: "Completed", value: <RelativeTime value={completedAt} /> }]),
    ...(run.failureReason === null ? [] : [{ label: "Failure reason", value: run.failureReason }]),
  ];
}

function timelineNotice(timeline: RunEventPage) {
  if (timeline.expired)
    return `The timeline for this run expired after ${String(timeline.retentionDays)} days`;
  if (!timeline.timelineEnabled) return "The run timeline is off on this Hub";
  if (timeline.origin === "derived") return "This run finished before the timeline was turned on";
  return null;
}

export function ConnectionPill({ connection }: { connection: RunConnection }) {
  if (connection === null) return null;
  return <StatusPill tone={connection === "Live" ? "success" : "neutral"}>{connection}</StatusPill>;
}

export function progressMessageLabel(
  detail: Pick<RunDetailSnapshot, "progress" | "progressMessagesEnabled" | "progressUnavailable"> &
    Partial<Pick<RunDetailSnapshot, "run">>,
) {
  const summary = detail.run?.payloadSummary?.progress;
  if (summary !== undefined) {
    if (summary.status === "posted") return "Posted";
    return summary.status === "failed" ? "Posting failed" : "Unavailable";
  }
  const progress = detail.progress;
  if (progress === null && detail.progressUnavailable) return "Unavailable";
  if (progress === null)
    return detail.progressMessagesEnabled
      ? "Off for this trigger"
      : "Not posted: this Hub has progress messages off";
  if (progress.state === "active" || progress.state === "finished") {
    const providers = { github: "GitHub", slack: "Slack", linear: "Linear" };
    return `Posted to ${providers[progress.provider]}`;
  }
  if (progress.state === "gone") return "Message was deleted";
  if (progress.state === "pending" || progress.state === "creating") return "Not posted yet";
  const reasons: Record<string, string> = {
    public_repository: "public repository",
    visibility_changed: "repository became public",
    no_credential: "no credential",
    org_not_mapped: "this organization is not approved for the GitHub credential",
    repo_not_allowed: "this repository is not approved for the GitHub credential",
    no_destination: "no place to post",
  };
  return `Not posted: ${progress.failure === null ? "could not confirm the message was created" : (reasons[progress.failure] ?? "could not confirm the message was created")}`;
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
