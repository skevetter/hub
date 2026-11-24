import type { QueryHandle } from "../db/runtime/index.js";
import type { FailedRunSummary, WaitingSessionSummary } from "../db/types.js";
import type { SessionPrincipal } from "../interactive-sessions/types.js";

export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "timed_out",
  "rejected",
]);

export const FAILED_RUNS_SQL = `select
    count(*) over ()::int as count,
    coalesce((
      select case when count(*) = 1 then min(trigger.name) end
      from organization_triggers trigger
      where trigger.runtime_project_id = run.project_id and trigger.organization_id = $1
    ), run.configured_trigger_name) as trigger_name,
    receipt.received_at
  from provider_event_receipts receipt
  join lateral (
    select id, project_id, configured_trigger_name from trigger_runs
    where provider_event_receipt_id = receipt.id and organization_id = $1
      and status = any($4::text[])
    offset 0
  ) run on true
  where receipt.organization_id = $1 and receipt.received_at >= $2
    and receipt.received_at > coalesce($3::timestamptz, '-infinity'::timestamptz)
  order by receipt.received_at desc, run.id desc
  limit 1`;

export async function countFailedRunsSince(
  database: QueryHandle,
  organizationId: string,
  since: Date,
  seenThrough: string | null,
): Promise<FailedRunSummary> {
  const {
    rows: [row],
  } = await database.query<{ count: number; trigger_name: string; received_at: Date }>(
    FAILED_RUNS_SQL,
    [organizationId, since, seenThrough, [...FAILED_RUN_STATUSES]],
  );
  return row === undefined
    ? { count: 0, newest: null }
    : {
        count: row.count,
        newest: { triggerName: row.trigger_name, receivedAt: row.received_at },
      };
}

// Mirror the session repository's list visibility, including its current membership lookup.
export const WAITING_SESSIONS_SQL = `select session.title as name, count(*) over ()::int as count
  from interactive_sessions session
  join member viewer on viewer.organization_id = session.organization_id and viewer.user_id = $2
  where session.organization_id = $1 and session.state = 'waiting_permission'
    and (
      (session.origin = 'web' and viewer.role in ('owner', 'admin'))
      or (
        ((session.origin = 'web' and viewer.role = 'member')
          or (session.origin = 'linear' and viewer.role = 'owner' and session.started_by_user_id = $2))
        and exists (
          select 1 from interactive_session_participants participant
          where participant.organization_id = $1 and participant.session_id = session.id
            and participant.user_id = $2
        )
      )
    )
  order by session.last_activity_at desc, session.id desc
  limit $3`;

export async function listSessionsWaitingForPermission(
  database: QueryHandle,
  organizationId: string,
  viewer: SessionPrincipal,
  limit: number,
): Promise<WaitingSessionSummary> {
  if (viewer.organizationId !== organizationId || limit <= 0) return { count: 0, sessions: [] };
  const { rows } = await database.query<{ name: string; count: number }>(WAITING_SESSIONS_SQL, [
    organizationId,
    viewer.userId,
    limit,
  ]);
  return { count: rows[0]?.count ?? 0, sessions: rows.map(({ name }) => ({ name })) };
}

export async function hasActiveSessionProfile(database: QueryHandle, organizationId: string) {
  const { rows } = await database.query(
    "select 1 from interactive_session_profiles where organization_id = $1 and status = 'active' limit 1",
    [organizationId],
  );
  return rows.length > 0;
}

// Preserve PostgreSQL's sub-millisecond precision between the read and the comparison.
export async function readFailedRunsSeenThrough(
  database: QueryHandle,
  accountId: string,
  organizationId: string,
) {
  const { rows } = await database.query<{ seen_through: string }>(
    `select failed_runs_seen_through::text as seen_through from account_attention_state
     where account_id = $1 and organization_id = $2`,
    [accountId, organizationId],
  );
  return rows[0]?.seen_through ?? null;
}

export async function markFailedRunsSeen(
  database: QueryHandle,
  accountId: string,
  organizationId: string,
) {
  await database.query(
    `insert into account_attention_state (account_id, organization_id, failed_runs_seen_through)
     values ($1, $2, now())
     on conflict (account_id, organization_id) do update
       set failed_runs_seen_through = greatest(
         account_attention_state.failed_runs_seen_through, excluded.failed_runs_seen_through
       )`,
    [accountId, organizationId],
  );
}
