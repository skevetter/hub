import {
  PROGRESS_UNSETTLED_SQL,
  SCRIPT_CLEANUP_SQL,
  type RunPayloadCandidate,
} from "../run-payload-retention/store.js";
import type { QueryHandle } from "./runtime/index.js";

export const RUN_PAYLOAD_DISPOSITION_SQL = `case
  when run.payload_expiry_state = 'expiring' then 'eligible'
  when run.status = 'running' then 'live'
  when run.completed_at is null then 'missing_completion'
  when run.completed_at >= $2 then 'not_old_enough'
  when exists (select 1 from workflow_step_runs step where step.trigger_run_id = run.id and (${SCRIPT_CLEANUP_SQL}))
    then 'cleanup_blocked'
  when exists (select 1 from workflow_wakeups wakeup where wakeup.trigger_run_id = run.id)
    or exists (select 1 from workflow_step_runs step where step.trigger_run_id = run.id
      and (step.status = 'running' or (step.status = 'pending' and step.dispatch_intent is not null)))
    or exists (
      select 1 from (
        ${runExecutions("run", "execution.status, execution.completed_at, execution.hub_action, execution.hub_action_completed_at")}
      ) execution
      where execution.status in ('spawning', 'running') or execution.completed_at is null
        or (execution.hub_action is not null and execution.hub_action_completed_at is null)
    )
    then 'live'
  when run.terminal_notification_lease_expires_at is not null
    or (run.terminal_notification_pending_at is not null and run.terminal_notification_delivered_at is null)
    then 'notification_pending'
  when exists (select 1 from run_progress_messages message
    where message.trigger_run_id = run.id and ${PROGRESS_UNSETTLED_SQL})
    then 'reporter_pending'
  when exists (
    select 1 from provider_event_receipts receipt
    cross join lateral jsonb_array_elements(case when jsonb_typeof(receipt.accepted_routes) = 'array'
      then receipt.accepted_routes else '[]'::jsonb end) route
    where receipt.id = run.provider_event_receipt_id
      and not exists (
        select 1 from trigger_runs branch
        where branch.provider_event_receipt_id = receipt.id
          and branch.project_id::text = route ->> 'projectId'
          and branch.configuration_revision_id::text = route ->> 'configurationRevisionId'
      )
    )
    then 'fan_out_unresolved'
  else 'eligible'
end`;

export function runExecutions(run: string, projection: string) {
  return `
    select ${projection} from workflow_step_runs step
    join agent_executions execution on execution.workflow_step_run_id = step.id
    where step.trigger_run_id = ${run}.id
    union
    select ${projection} from workflow_step_runs step
    join agent_executions execution on execution.id = step.agent_execution_id
    where step.trigger_run_id = ${run}.id
    union
    select ${projection} from agent_executions execution
    where execution.workflow_step_run_id is null
      and execution.launch_intent ->> 'kind' = 'launch_machine'
      and execution.launch_intent ->> 'triggerRunId' = ${run}.id::text
      and execution.organization_id = ${run}.organization_id and execution.project_id = ${run}.project_id`;
}

export async function scanRunPayloads(
  database: QueryHandle,
  after: string | null,
  cutoff: Date,
  limit: number,
  countOnly: boolean,
): Promise<RunPayloadCandidate[]> {
  const result = await database.query<RunPayloadCandidate & Record<string, unknown>>(
    `with candidates as materialized (
      select id, status, completed_at, created_at, payload_expiry_state,
        organization_id, project_id, provider_event_receipt_id, terminal_notification_lease_expires_at,
        terminal_notification_pending_at, terminal_notification_delivered_at
      from trigger_runs
      where id > coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid) and payload_expiry_state is distinct from 'expired'
        ${countOnly ? "" : "and status <> 'running' and completed_at < $2"}
      order by id limit $3
    )
    select run.id, ${RUN_PAYLOAD_DISPOSITION_SQL} as disposition,
      coalesce(run.completed_at, run.created_at) as "ageFrom",
      coalesce(run.payload_expiry_state = 'expiring', false) as expiring
    from candidates run order by run.id`,
    [after, cutoff, limit],
  );
  return result.rows;
}
