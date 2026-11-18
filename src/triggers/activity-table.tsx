import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import type { TriggerSnapshot } from "./functions.js";

export const ACTIVITY_COLUMNS = [
  { header: "Trigger", fill: true },
  { header: "Provider" },
  { header: "Source" },
  { header: "Status" },
  { header: "Received" },
];
const EMPTY_ACTIVITY = { title: "No activity" };

export function TriggerActivityTable({
  activity,
  organizationSlug,
}: {
  activity: TriggerSnapshot["activity"];
  organizationSlug: string;
}) {
  return (
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
              className="text-link hover:underline"
            >
              {run.triggerName}
            </a>
            {run.repo === null ? null : <div className="text-muted-foreground">{run.repo}</div>}
          </DataCell>
          <DataCell>{run.provider}</DataCell>
          <DataCell>
            <div className="flex items-center gap-2">
              <ProviderGlyph provider={run.provider} source={run.source} />
              <TwoLine
                primary={
                  run.payloadExpiredAt == null
                    ? (run.webhookSummary?.headline ?? run.source)
                    : "Run payload expired"
                }
                {...(run.webhookSummary?.prompt === undefined
                  ? {}
                  : { secondary: run.webhookSummary.prompt })}
              />
            </div>
          </DataCell>
          <DataCell>
            <StatusPill tone={tone(run.status)}>{statusLabel(run.status)}</StatusPill>
          </DataCell>
          <DataCell muted>
            <RelativeTime value={run.receivedAt} />
          </DataCell>
        </DataRow>
      ))}
    </DataTable>
  );
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
