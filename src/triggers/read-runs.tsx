import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { LoadingLine } from "../components/app/loading.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel, type StatusTone } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { respondOk, type Result } from "../contract/respond.js";
import { useSnapshotQuery } from "../queries/index.js";
import { triggerActivityPage, type TriggerActivityPage } from "./functions.js";
import { summarizeRecentRuns, type RecentRuns } from "./recent-runs.js";

export interface TriggerReadScope {
  organizationSlug: string;
  triggerId: string;
}

type RunRow = TriggerActivityPage["activity"][number];

interface TriggerRuns {
  recent: RunRow[];
  counts: RecentRuns;
}

const RUN_TONE: Record<RunRow["status"], StatusTone> = {
  running: "neutral",
  succeeded: "success",
  failed: "danger",
  timed_out: "danger",
  canceled: "neutral",
  rejected: "danger",
};

export function triggerReadRunsKey({ organizationSlug, triggerId }: TriggerReadScope) {
  return ["activity", organizationSlug, "trigger-read", triggerId] as const;
}

export function TriggerReadRuns(scope: TriggerReadScope) {
  const load = useServerFn(triggerActivityPage);
  const snapshot = useSnapshotQuery({
    queryKey: triggerReadRunsKey(scope),
    queryFn: ({ signal }) => readTriggerRuns(load, scope, signal),
  });
  const description =
    snapshot.data === undefined ? undefined : formatRunCounts(snapshot.data.counts);
  return (
    <Section title="Recent runs" {...(description === undefined ? {} : { description })}>
      <TriggerRunsContent snapshot={snapshot} organizationSlug={scope.organizationSlug} />
    </Section>
  );
}

function TriggerRunsContent({
  snapshot,
  organizationSlug,
}: {
  snapshot: ReturnType<typeof useSnapshotQuery<TriggerRuns>>;
  organizationSlug: string;
}) {
  if (snapshot.status === "pending") return <LoadingLine>Loading recent runs</LoadingLine>;
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Recent runs unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load recent runs."
        onRetry={snapshot.refetch}
      />
    );
  }
  if (snapshot.data.recent.length === 0) return <EmptyState title="No runs yet" />;
  return (
    <RecordList label="Recent runs">
      {snapshot.data.recent.map((run) => (
        <TriggerRun key={run.id} run={run} organizationSlug={organizationSlug} />
      ))}
    </RecordList>
  );
}

function TriggerRun({ run, organizationSlug }: { run: RunRow; organizationSlug: string }) {
  const status = runStatus(run);
  const link = recentRunLink(organizationSlug, run.id);
  const time = receivedTime(run.receivedAt);
  return (
    <RecordRow status={status}>
      <TwoLine primary={link} secondary={time} />
    </RecordRow>
  );
}

function runStatus(run: RunRow) {
  return <StatusPill tone={RUN_TONE[run.status]}>{statusLabel(run.status)}</StatusPill>;
}

function receivedTime(value: string) {
  return <RelativeTime value={value} />;
}

function recentRunLink(organizationSlug: string, runId: string) {
  return (
    <RunLink organizationSlug={organizationSlug} runId={runId}>
      View run
    </RunLink>
  );
}

export function RunLink({
  organizationSlug,
  runId,
  children,
}: {
  organizationSlug: string;
  runId: string;
  children: string;
}) {
  const params = runLinkParams(organizationSlug, runId);
  return (
    <Link
      className="underline underline-offset-2"
      to="/o/$organizationSlug/activity/$runId"
      params={params}
    >
      {children}
    </Link>
  );
}

function runLinkParams(organizationSlug: string, runId: string) {
  return { organizationSlug, runId };
}

function formatRunCounts({ total, succeeded, failed }: RecentRuns): string {
  return `Last 24 hours: ${total} total, ${succeeded} succeeded, ${failed} failed or timed out.`;
}

async function readTriggerRuns(
  load: (
    options: Parameters<typeof triggerActivityPage>[0],
  ) => Promise<Result<TriggerActivityPage>>,
  { organizationSlug, triggerId }: TriggerReadScope,
  signal: AbortSignal,
): Promise<Result<TriggerRuns>> {
  const data = { organizationSlug, trigger: triggerId };
  const [latest, daily] = await Promise.all([
    load({ data: { ...data, limit: 10 }, signal }),
    readDailyRuns((cursor) =>
      load({ data: { ...data, range: "24h", limit: 100, cursor }, signal }),
    ),
  ]);
  if (latest.status === "error") return latest;
  if (daily.status === "error") return daily;
  return respondOk({ recent: latest.data.activity, counts: daily.data });
}

async function readDailyRuns(
  load: (cursor?: string) => Promise<Result<TriggerActivityPage>>,
): Promise<Result<RecentRuns>> {
  const now = new Date();
  const runs = new Map<string, RunRow>();
  const cursors = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const page = await load(cursor ?? undefined);
    if (page.status === "error") return page;
    for (const run of page.data.activity) runs.set(run.id, run);
    cursor = page.data.nextCursor;
    if (cursor === null || cursors.has(cursor)) break;
    cursors.add(cursor);
  } while (cursor !== null);
  return respondOk(summarizeRecentRuns([...runs.values()], now));
}
