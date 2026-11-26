import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert, NoticeAlert, type Failure } from "../components/app/failure-alert.js";
import { PageAlert } from "../components/app/page-alert.js";
import { ConfirmAction } from "../components/app/confirm-action.js";
import { FollowBottom } from "../components/app/follow-bottom.js";
import { Duration } from "../components/app/duration.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { pillTone, runState } from "../components/app/state-label.js";
import { StatusPill } from "../components/app/status-pill.js";
import { SummaryPanel } from "../components/app/summary-panel.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { useRouteTenant } from "../projects/context.js";
import { useSnapshotQuery } from "../queries/index.js";
import { runDetailSnapshot, stopRun } from "./functions.js";
import type { RunConnection, RunDetailSnapshot, RunEventPage } from "./run-events.js";
import { RunSteps } from "./run-steps.js";
import {
  stopCleanupNotes,
  stopCoalescedNote,
  type BrowserStopResult,
  type StopConfirmation,
} from "./run-stop.js";
import { activityCounts, timelineRows, type TimelineRow } from "./run-timeline-view.js";
import { pollRunDetail } from "./run-event-subscription.js";
import { runDetailKey, useRunEvents } from "./use-run-events.js";
import { runReadClock, runReadResult } from "./run-read.js";
import { replyFailureLabels } from "../run-replies/store.js";

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
        <PageHeader title="Run detail" />
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
  const queryClient = useQueryClient();
  const runId = detail.run.id;
  const cleanupPending = detail.stopDetails?.cleanupState === "waiting_for_daemon";
  const replyPending = awaitingRunReply(state.status, detail);
  useEffect(() => {
    if (!cleanupPending && !replyPending) return undefined;
    return pollRunDetail(() => {
      void queryClient.invalidateQueries({ queryKey: runDetailKey(organizationSlug, runId) });
    });
  }, [cleanupPending, organizationSlug, queryClient, replyPending, runId]);
  const { stop, confirm, readImpact } = useRunStop(detail, organizationSlug, runId, queryClient);
  const stoppedStatus =
    stop.data?.status === "ok" && stop.data.data.status === "stopped"
      ? stop.data.data.runStatus
      : undefined;
  const timeline = useMemo(
    () => (stoppedStatus === undefined ? state : { ...state, status: stoppedStatus }),
    [state, stoppedStatus],
  );
  return (
    <RunDetailView
      detail={detail}
      timeline={timeline}
      connection={state.connection}
      stopBusy={stop.isPending}
      onStop={confirm}
      readStopImpact={readImpact}
      stopError={stop.data?.status === "error" ? stop.data : stop.error}
    />
  );
}

function awaitingRunReply(status: RunEventPage["status"], detail: RunDetailSnapshot) {
  return (
    status !== "running" && (detail.reply?.state === "pending" || detail.reply?.state === "sending")
  );
}

function useRunStop(
  detail: RunDetailSnapshot,
  organizationSlug: string,
  runId: string,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  const sendStop = useServerFn(stopRun);
  const load = useServerFn(runDetailSnapshot);
  const stop = useMutation({
    mutationFn: (confirmation: StopConfirmation) =>
      sendStop({ data: { organizationSlug, runId, ...confirmation } }),
    onSuccess: async (result) => {
      if (result.status !== "ok" || result.data.status !== "stopped") return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runDetailKey(organizationSlug, detail.run.id) }),
        queryClient.invalidateQueries({ queryKey: ["attention"] }),
      ]);
    },
  });
  const sendConfirmation = stop.mutateAsync;
  const confirm = useCallback(
    async (confirmation: StopConfirmation) => {
      const result = await sendConfirmation(confirmation).catch(() => undefined);
      return result?.status === "ok" ? result.data : undefined;
    },
    [sendConfirmation],
  );
  const readImpact = useCallback(async () => {
    const result = await load({ data: { organizationSlug, runId } });
    if (result.status !== "ok" || !result.data?.canStop || result.data.stopDetails === undefined)
      return undefined;
    const { otherAttachedRunCount, retryAttemptId } = result.data.stopDetails;
    return {
      confirmedPeerCount: otherAttachedRunCount,
      ...(retryAttemptId === null ? {} : { retryAttemptId }),
    };
  }, [load, organizationSlug, runId]);
  return { stop, confirm, readImpact };
}

export function RunDetailView({
  detail,
  timeline = detail.timeline,
  connection = null,
  stopBusy = false,
  onStop,
  readStopImpact,
  stopError,
}: {
  detail: RunDetailSnapshot;
  timeline?: RunEventPage;
  connection?: RunConnection;
  stopBusy?: boolean;
  onStop?: (confirmation: StopConfirmation) => Promise<BrowserStopResult | undefined>;
  readStopImpact?: () => Promise<StopConfirmation | undefined>;
  stopError?: Failure;
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
  return (
    <>
      <div className="min-w-0 max-w-full overflow-hidden [&_p]:break-words">
        <PageHeader
          title="Run detail"
          description={`${run.webhookSummary === undefined ? run.provider : "Webhook"} - ${run.configuredTriggerName}`}
        >
          <StopRunAction
            detail={detail}
            terminal={terminal}
            busy={stopBusy}
            onConfirm={onStop}
            readImpact={readStopImpact}
          />
        </PageHeader>
      </div>
      {renderStopFailure(stopError)}
      {timeline.status === "canceled" ? <CanceledRunNotice details={detail.stopDetails} /> : null}
      {renderPayloadNotice(run.payloadExpiredAt)}
      <Section>
        <SummaryPanel label="Run" rows={summary} />
      </Section>
      {renderRunTimeline(timeline, events, rows)}
      <RunSteps steps={detail.steps} events={events} terminal={terminal} />
    </>
  );
}

function renderRunTimeline(
  timeline: RunEventPage,
  events: RunEventPage["events"],
  rows: readonly TimelineRow[],
) {
  const notice = timelineNotice(timeline);
  return (
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
  );
}

function renderStopFailure(stopError: Failure | undefined) {
  return stopError == null ? null : (
    <FailureAlert
      page
      title="Stop failed"
      error={stopError}
      fallback="Hub couldn't stop this run."
    />
  );
}

function renderPayloadNotice(expiredAt: RunDetailSnapshot["run"]["payloadExpiredAt"]) {
  return expiredAt == null ? null : (
    <PageAlert role="status" tone="neutral" title="Run payload expired">
      This run's original event, inputs, prompts, and outputs expired under this Hub's retention
      policy.
    </PageAlert>
  );
}

interface StopRunActionProps {
  detail: RunDetailSnapshot;
  terminal: boolean;
  busy: boolean;
  onConfirm:
    | ((confirmation: StopConfirmation) => Promise<BrowserStopResult | undefined>)
    | undefined;
  readImpact: (() => Promise<StopConfirmation | undefined>) | undefined;
}

function StopRunAction({ detail, terminal, busy, onConfirm, readImpact }: StopRunActionProps) {
  const { confirmation, impact, changeOpen, confirm } = useStopConfirmation(
    detail,
    onConfirm,
    readImpact,
  );
  const retrying = detail.stopDetails?.retryAttemptId != null;
  if (hideStopAction(detail, terminal, retrying, onConfirm)) return null;
  const repeat = impact === undefined ? retrying : impact.retryAttemptId !== undefined;
  const label = repeat ? "Stop again" : "Stop run";
  return (
    <ConfirmAction
      label={label}
      title={repeat ? "Send another interrupt?" : "Stop this run?"}
      description={stopDescription(impact?.confirmedPeerCount, repeat, confirmation?.message)}
      confirmLabel={label}
      cancelLabel={repeat ? "Close" : "Keep running"}
      destructive
      busy={busy}
      confirmDisabled={impact === undefined}
      keepOpenOnConfirm
      open={confirmation !== null}
      onOpenChange={changeOpen}
      onConfirm={confirm}
    />
  );
}

function hideStopAction(
  detail: RunDetailSnapshot,
  terminal: boolean,
  retrying: boolean,
  onConfirm: StopRunActionProps["onConfirm"],
) {
  return !detail.canStop || (terminal && !retrying) || onConfirm === undefined;
}

function useStopConfirmation(
  detail: RunDetailSnapshot,
  onConfirm: StopRunActionProps["onConfirm"],
  readImpact: StopRunActionProps["readImpact"],
) {
  const [confirmation, setConfirmation] = useState<{
    impact?: StopConfirmation;
    message?: string;
  } | null>(null);
  const request = useRef(0);
  const snapshotCount = detail.stopDetails?.otherAttachedRunCount;
  const snapshotAttempt = detail.stopDetails?.retryAttemptId;
  const changeOpen = useCallback(
    (open: boolean) => {
      const generation = ++request.current;
      setConfirmation(open ? {} : null);
      if (!open) return;
      const read =
        readImpact?.() ?? Promise.resolve(snapshotImpact(snapshotCount, snapshotAttempt));
      void read
        .catch(() => undefined)
        .then((impact) => {
          if (request.current !== generation) return undefined;
          setConfirmation(
            impact === undefined
              ? { message: "Hub couldn't check the impact. Close the dialog and try again." }
              : { impact },
          );
          return undefined;
        });
    },
    [readImpact, snapshotAttempt, snapshotCount],
  );
  const impact = confirmation?.impact;
  const confirm = useCallback(() => {
    if (impact === undefined || onConfirm === undefined) return;
    const generation = request.current;
    void onConfirm(impact).then((result) => {
      if (request.current !== generation) return undefined;
      if (result?.status === "conflict") {
        setConfirmation({
          impact: { ...impact, confirmedPeerCount: result.otherAttachedRunCount },
          message: "Review the updated impact and confirm again.",
        });
      } else if (result?.status === "stopped") {
        changeOpen(false);
      } else {
        setConfirmation({ impact, message: "Hub couldn't send the Stop request. Try again." });
      }
      return undefined;
    });
  }, [changeOpen, impact, onConfirm]);
  return { confirmation, impact, changeOpen, confirm };
}

function snapshotImpact(
  count: StopConfirmation["confirmedPeerCount"] | undefined,
  attempt: string | null | undefined,
): StopConfirmation | undefined {
  if (count === undefined) return undefined;
  return { confirmedPeerCount: count, ...(attempt == null ? {} : { retryAttemptId: attempt }) };
}

function stopDescription(
  peerCount: number | undefined,
  repeat: boolean,
  message: string | undefined,
): string {
  const previous = repeat ? "Hub could not confirm delivery of the previous interrupt." : undefined;
  if (peerCount === undefined)
    return [previous, message ?? "Checking which runs have work attached to the agent..."]
      .filter(Boolean)
      .join(" ");
  const effect = repeat
    ? "A new interrupt can stop the agent's current work."
    : "Hub will cancel this run, skip its remaining steps, and request an interrupt for active work.";
  const peers =
    peerCount === 0
      ? undefined
      : `${peerCount} other ${peerCount === 1 ? "run has" : "runs have"} work attached to this agent. If the daemon confirms the interrupt, those runs can fail. Overlapping Stops may share one interrupt.`;
  return [
    message,
    previous,
    effect,
    peers,
    "If the daemon is offline, Hub will wait for it to reconnect before sending.",
  ]
    .filter(Boolean)
    .join(" ");
}

function CanceledRunNotice({ details }: { details: RunDetailSnapshot["stopDetails"] }) {
  let note = details === undefined ? null : stopCleanupNotes[details.cleanupState];
  if (details?.cleanupState === "confirmed" && details.coalesced) note = stopCoalescedNote;
  return (
    <PageAlert
      role="status"
      tone="neutral"
      title={`Stopped by ${details?.stoppedByName || "a person"}`}
    >
      {note}
    </PageAlert>
  );
}

function runSummaryRows(
  detail: RunDetailSnapshot,
  timeline: RunEventPage,
  connection: RunConnection,
  rows: readonly TimelineRow[],
) {
  const { run } = detail;
  const status = timeline.status;
  const { startedAt, completedAt, durationMs } = runTiming(detail, timeline);
  return [
    {
      label: "Status",
      value: (
        <span className="flex items-center gap-2">
          <StatusPill tone={pillTone(runState(status).tone)}>{runState(status).label}</StatusPill>
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
    ...runProviderRows(detail, rows),
    { label: "Repository", value: run.repo ?? "-" },
    { label: "Received", value: <RelativeTime value={run.receivedAt} /> },
    ...(completedAt === null
      ? []
      : [{ label: "Completed", value: <RelativeTime value={completedAt} /> }]),
    ...(run.failureReason === null ? [] : [{ label: "Failure reason", value: run.failureReason }]),
  ];
}

function runTiming(detail: RunDetailSnapshot, timeline: RunEventPage) {
  const { run } = detail;
  const events = timeline.events;
  const finished = events.find((event) => event.kind === "run_finished");
  const completedAt = run.completedAt ?? finished?.at ?? null;
  const startedAt = detail.steps.reduce<string>(
    (earliest, step) =>
      step.startedAt !== null && step.startedAt < earliest ? step.startedAt : earliest,
    run.createdAt,
  );
  const durationMs =
    typeof finished?.data["durationMs"] === "number" ? finished.data["durationMs"] : null;
  return { startedAt, completedAt, durationMs };
}

function runProviderRows(detail: RunDetailSnapshot, rows: readonly TimelineRow[]) {
  const { run } = detail;
  return [
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
    ...(detail.reply === undefined
      ? []
      : [
          {
            label: "Agent reply",
            value: replyLabel(detail.reply),
          },
        ]),
    ...(run.webhookSummary?.prompt === undefined
      ? []
      : [{ label: "Message", value: run.webhookSummary.prompt }]),
  ];
}

function replyLabel(reply: NonNullable<RunDetailSnapshot["reply"]>): string {
  if (reply.failure !== null) return `Reply not posted: ${replyFailureLabels[reply.failure]}`;
  if (reply.state === "sent") return "Posted to Linear";
  return "Waiting for reply delivery";
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
  return liveProgressMessageLabel(progress);
}

function liveProgressMessageLabel(progress: NonNullable<RunDetailSnapshot["progress"]>) {
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
