import type { QueryHandle, QueryRow } from "../db/runtime/index.js";
import type { TriggerRunSummary } from "../db/types.js";
import { FAILED_RUN_STATUSES } from "../triggers/run-status.js";

// Both lookups walk trigger_runs_project_created_idx per trigger, so the cost follows the number
// of triggers and the runs inside the window, not the organization's whole history.
export const TRIGGER_RUN_SUMMARY_SQL = `select trigger.id as trigger_id, counts.total, counts.failed,
    latest.id as latest_id, latest.status as latest_status, latest.created_at as latest_created_at
  from organization_triggers trigger
  cross join lateral (
    select count(*)::int as total, (count(*) filter (where status = any($3::text[])))::int as failed
    from trigger_runs
    where organization_id = $1 and project_id = trigger.runtime_project_id and created_at >= $2
  ) counts
  left join lateral (
    select id, status, created_at
    from trigger_runs
    where organization_id = $1 and project_id = trigger.runtime_project_id
    order by created_at desc, id desc
    limit 1
  ) latest on true
  where trigger.organization_id = $1`;

// One statement for every trigger's active revision. The lateral lookup is a key lookup per
// trigger; a plain join lets the planner hash the revisions of every organization instead.
export const ACTIVE_TRIGGER_REVISIONS_SQL = `select revision.*
  from organization_triggers trigger
  cross join lateral (
    select * from organization_trigger_revisions
    where id = trigger.active_revision_id and trigger_id = trigger.id and organization_id = $1
    limit 1
  ) revision
  where trigger.organization_id = $1`;

interface SummaryRow extends QueryRow {
  trigger_id: string;
  total: number;
  failed: number;
  latest_id: string | null;
  latest_status: NonNullable<TriggerRunSummary["latest"]>["status"];
  latest_created_at: Date | null;
}

export async function summarizeTriggerRuns(
  database: QueryHandle,
  organizationId: string,
  since: Date,
): Promise<TriggerRunSummary[]> {
  const { rows } = await database.query<SummaryRow>(TRIGGER_RUN_SUMMARY_SQL, [
    organizationId,
    since,
    [...FAILED_RUN_STATUSES],
  ]);
  return rows.map((row) => ({
    triggerId: row.trigger_id,
    total: row.total,
    failed: row.failed,
    latest:
      row.latest_id === null || row.latest_created_at === null
        ? null
        : { id: row.latest_id, status: row.latest_status, createdAt: row.latest_created_at },
  }));
}
