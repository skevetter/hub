import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StateBlock } from "../components/app/state-block.js";
import { runListState } from "../components/app/state-label.js";
import { TwoLine } from "../components/app/two-line.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import type { TriggerActivityPage } from "./functions.js";
import type { ComponentProps } from "react";

export const ACTIVITY_COLUMNS = [
  { header: "Status", lead: true },
  { header: "Trigger", fill: true },
  { header: "Provider", className: "hidden sm:table-cell" },
  { header: "Source", fill: true, className: "hidden sm:table-cell" },
  { header: "Received" },
];
const EMPTY_ACTIVITY = { title: "No activity" };

export function TriggerActivityTable({
  activity,
  organizationSlug,
  empty = EMPTY_ACTIVITY,
}: {
  activity: TriggerActivityPage["activity"];
  organizationSlug: string;
  empty?: ComponentProps<typeof DataTable>["empty"] | undefined;
}) {
  return (
    <DataTable
      label="Trigger activity"
      columns={ACTIVITY_COLUMNS}
      isEmpty={activity.length === 0}
      empty={empty}
    >
      {activity.map((run) => (
        <DataRow key={run.id}>
          <DataCell>
            <StateBlock state={runListState(run.status)} />
          </DataCell>
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
          <DataCell muted>
            <RelativeTime value={run.receivedAt} />
          </DataCell>
        </DataRow>
      ))}
    </DataTable>
  );
}
