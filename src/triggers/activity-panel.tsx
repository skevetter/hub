import { useSnapshotQuery } from "../queries/index.js";
import { useServerFn } from "@tanstack/react-start";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { useRouteTenant } from "../projects/context.js";
import { triggerSnapshot } from "./functions.js";

const ACTIVITY_COLUMNS = [
  { header: "Trigger", fill: true },
  { header: "Provider" },
  { header: "Source" },
  { header: "Status" },
  { header: "Received" },
];
const EMPTY_ACTIVITY = { title: "No activity" };
const ACTIVITY_DESCRIPTION = "Agent runs launched by organization triggers.";

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerSnapshot);
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: ["triggers", organizationSlug],
    queryFn: () => load({ data: { organizationSlug } }),
    refetchInterval: 5_000,
  });
  if (snapshot.status === "pending") {
    return (
      <>
        <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
        <DataTableSkeleton label="Trigger activity" columns={ACTIVITY_COLUMNS} />
      </>
    );
  }
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Activity unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load trigger activity."
      />
    );
  }
  const activity = snapshot.data.activity;
  return (
    <>
      <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
      <DataTable
        label="Trigger activity"
        columns={ACTIVITY_COLUMNS}
        isEmpty={activity.length === 0}
        empty={EMPTY_ACTIVITY}
      >
        {activity.map((run) => (
          <DataRow key={run.id}>
            <DataCell>
              <a
                href={`/o/${encodeURIComponent(organizationSlug)}/activity/${encodeURIComponent(run.id)}`}
                className="text-primary hover:underline"
              >
                {run.triggerName}
              </a>
              {run.repo === null ? null : <div className="text-muted-foreground">{run.repo}</div>}
            </DataCell>
            <DataCell>{run.provider}</DataCell>
            <DataCell>{run.source}</DataCell>
            <DataCell>
              <StatusPill tone={tone(run.status)}>{statusLabel(run.status)}</StatusPill>
            </DataCell>
            <DataCell muted>
              <RelativeTime value={run.receivedAt} />
            </DataCell>
          </DataRow>
        ))}
      </DataTable>
    </>
  );
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
