import type { QueryHandle, QueryRow } from "../db/runtime/index.js";
import type { RunsDay } from "../db/types.js";
import { DID_NOT_FINISH_STATUSES } from "../triggers/run-status.js";

export const CHART_DAYS = 14;
const DAY_MS = 86_400_000;

// One range scan of trigger_runs_organization_created_id_idx, so the cost follows the runs inside
// the window. Failed means did not finish, the Activity filter of that name. Days are UTC calendar days; a day without runs has no row and is filled in later.
// to_char keeps the key ISO under any DateStyle, which a date cast to text does not.
export const RUNS_PER_DAY_SQL = `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
    count(*)::int as total,
    (count(*) filter (where status = any($4::text[])))::int as failed
  from trigger_runs
  where organization_id = $1 and created_at >= $2 and created_at < $3
  group by 1
  order by 1`;

interface DayRow extends QueryRow {
  day: string;
  total: number;
  failed: number;
}

export async function listRunsPerDay(
  database: QueryHandle,
  organizationId: string,
  since: Date,
  until: Date,
): Promise<RunsDay[]> {
  const { rows } = await database.query<DayRow>(RUNS_PER_DAY_SQL, [
    organizationId,
    since,
    until,
    [...DID_NOT_FINISH_STATUSES],
  ]);
  return rows.map(({ day, total, failed }) => ({ day, total, failed }));
}

/** The chart's span: the last `CHART_DAYS` UTC days, ending with the whole of today. */
export function chartWindow(now: Date): { since: Date; until: Date } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { since: new Date(today - (CHART_DAYS - 1) * DAY_MS), until: new Date(today + DAY_MS) };
}

export function chartDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Every day of the span, oldest first, so a quiet day is a zero and not a gap. */
export function fillRunDays(rows: readonly RunsDay[], since: Date): RunsDay[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return Array.from({ length: CHART_DAYS }, (_, index) => {
    const day = chartDayKey(new Date(since.getTime() + index * DAY_MS));
    return byDay.get(day) ?? { day, total: 0, failed: 0 };
  });
}
