import { sessionLock } from "../agent-sessions/index.js";
import type { AgentSessionRecord } from "../agent-sessions/types.js";
import { summarizePayloadAgent } from "../run-payload-retention/summary.js";
import type {
  AuxiliaryPayloadCandidate,
  AuxiliaryPayloadKind,
} from "../run-payload-retention/store.js";
import type { DatabaseRuntime, QueryHandle } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";

const UNSETTLED_EXECUTION = `(
  execution.status in ('spawning', 'running') or execution.completed_at is null
  or (execution.hub_action is not null and execution.hub_action_completed_at is null)
  or jsonb_typeof(execution.output_delivery_attempts) <> 'object'
  or exists (select 1 from jsonb_each(case when jsonb_typeof(execution.output_delivery_attempts) = 'object'
    then execution.output_delivery_attempts else '{}'::jsonb end) attempt
    where attempt.value ->> 'status' = 'pending')
  or exists (select 1 from execution_authorities where execution_id = execution.id)
  or exists (select 1 from execution_credential_leases where execution_id = execution.id)
)`;

const PENDING_FINISH_ACK = `execution.hub_action_acknowledgements #>> '{finish_execution_call,status}' = 'running'`;

const EXECUTION_OWNERS = `
  cross join lateral (
    select case when execution.launch_intent ->> 'triggerRunId'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (execution.launch_intent ->> 'triggerRunId')::uuid end as id
  ) declared
  left join lateral (
    select bool_and(run.payload_expiry_state is not distinct from 'expired') as expired,
           max(run.id::text) as "runId",
           count(*) as count,
           bool_or(run.id = declared.id) as declared
    from (
      select declared.id
      union
      select step.trigger_run_id from workflow_step_runs step where step.id = execution.workflow_step_run_id
      union
      select step.trigger_run_id from workflow_step_runs step where step.agent_execution_id = execution.id
    ) links join trigger_runs run on run.id = links.id
    where run.organization_id = execution.organization_id and run.project_id = execution.project_id
  ) owners on true`;

const LAUNCH_INTENT_DISPOSITION = `case
  when ${PENDING_FINISH_ACK} then 'pending_hub_action'
  when execution.used_temporary_credentials is null then 'flag_unknown'
  when ${UNSETTLED_EXECUTION}
    or owners.count > 1
    or owners.expired = false
    or (execution.workflow_step_run_id is not null and owners."runId" is null)
    or (execution.launch_intent ->> 'triggerRunId' is not null and owners.declared is not true)
  then 'live_owner'
  when execution.completed_at >= $2 then 'not_old_enough'
  else 'eligible'
end`;

const SESSION_OWNERS = `
  left join lateral (
    select count(*) as count, bool_or(execution.agent_session_action is not null) as bootstrapped,
           bool_or(${UNSETTLED_EXECUTION}) as live,
           bool_or(${PENDING_FINISH_ACK}) as pending_finish_ack,
           bool_or(execution.used_temporary_credentials is null) as unknown,
           max(coalesce(execution.completed_at, execution.started_at)) as last_activity
    from agent_executions execution where execution.agent_session_id = session.id
  ) owners on true`;

const SESSION_DISPOSITION = `case
  when jsonb_typeof(session.data -> 'agentId') is distinct from 'string'
    or jsonb_typeof(session.data -> 'workspaceId') is distinct from 'string'
    or session.data ->> 'agentId' = '' or session.data ->> 'workspaceId' = ''
    then 'unbound_session'
  when owners.count = 0 then 'unused_session'
  when owners.bootstrapped is not true or jsonb_typeof(session.creation_options) is distinct from 'object'
    then 'incomplete_bootstrap'
  when owners.pending_finish_ack then 'pending_hub_action'
  when owners.live then 'live_owner'
  when owners.unknown then 'flag_unknown'
  when owners.last_activity >= $2 then 'not_old_enough'
  else 'eligible'
end`;

export async function scanAuxiliaryPayloads(
  database: QueryHandle,
  kind: AuxiliaryPayloadKind,
  after: string | null,
  cutoff: Date,
  limit: number,
) {
  const sql = {
    launchIntent: `with page as materialized (
      select * from agent_executions
      where ($1::uuid is null or id > $1) and launch_intent is not null
      order by id limit $3)
    select execution.id, ${LAUNCH_INTENT_DISPOSITION} as disposition,
      coalesce(execution.completed_at, execution.started_at) as "ageFrom"
    from page execution ${EXECUTION_OWNERS} order by execution.id`,
    session: `with page as materialized (
      select * from agent_sessions
      where ($1::uuid is null or id > $1) and options_reduced_at is null
      order by id limit $3)
    select session.id, ${SESSION_DISPOSITION} as disposition,
      coalesce(owners.last_activity, session.created_at) as "ageFrom"
    from page session ${SESSION_OWNERS} order by session.id`,
    machine: `select machine.id, 'machine_legacy' as disposition, machine.terminated_at as "ageFrom"
    from machines machine
    where ($1::uuid is null or machine.id > $1)
      and machine.status = 'terminated' and machine.terminated_at < $2
      and (machine.trigger_context is not null or machine.specs is not null or machine.shutdown_reason is not null)
      and not exists (select 1 from agent_executions where machine_id = machine.id)
      and not exists (select 1 from daemons where machine_id = machine.id)
    order by machine.id limit $3`,
  } satisfies Record<AuxiliaryPayloadKind, string>;
  return (
    await database.query<AuxiliaryPayloadCandidate & Record<string, unknown>>(sql[kind], [
      after,
      cutoff,
      limit,
    ])
  ).rows;
}

export async function expireLaunchIntent(
  database: DatabaseRuntime,
  id: string,
  cutoff: Date,
  now: Date,
) {
  return database.transaction(async (client) => {
    // Completion locks the run first. The owner read below does not take a run lock.
    const locked = await client.query(
      `select id from agent_executions where id = $1 and launch_intent is not null
       for update skip locked`,
      [id],
    );
    if (locked.rowCount !== 1) return false;
    const { rows } = await client.query<{
      disposition: AuxiliaryPayloadCandidate["disposition"];
      runId: string | null;
      agent: Parameters<typeof summarizePayloadAgent>[0];
    }>(
      `select ${LAUNCH_INTENT_DISPOSITION} as disposition,
        owners."runId", execution.launch_intent -> 'agent' as agent
      from agent_executions execution ${EXECUTION_OWNERS} where execution.id = $1`,
      [id, cutoff],
    );
    const candidate = rows[0];
    if (candidate?.disposition !== "eligible") return false;
    const result = await client.query(
      `update agent_executions
       set launch_intent = null, launch_intent_expired_at = $2, launch_run_id = $3, launch_agent = $4
       where id = $1 and launch_intent_expired_at is null and used_temporary_credentials is not null`,
      [id, now, candidate.runId, summarizePayloadAgent(candidate.agent)],
    );
    return result.rowCount === 1;
  });
}

export async function reduceSessionOptions(
  database: DatabaseRuntime,
  locks: Locks,
  id: string,
  cutoff: Date,
  now: Date,
) {
  const { rows } = await database.query<{
    id: string;
    projectId: string;
    continuationKey: string | null;
  }>(
    `select id, project_id as "projectId", continuation_key as "continuationKey"
     from agent_sessions where id = $1 and options_reduced_at is null`,
    [id],
  );
  const session = rows[0];
  if (session === undefined) return false;
  return database.transaction(async (client) => {
    // A dispatch holding this lock can still need a database connection.
    if (!(await locks.tryTxLock(client, sessionLock(session)))) return false;
    const { rows: candidates } = await client.query<{
      disposition: AuxiliaryPayloadCandidate["disposition"];
      options: AgentSessionRecord["creationOptions"];
    }>(
      `select ${SESSION_DISPOSITION} as disposition, session.creation_options as options
       from agent_sessions session ${SESSION_OWNERS}
       where session.id = $1 and session.options_reduced_at is null
         and session.continuation_key is not distinct from $3
       for update of session skip locked`,
      [id, cutoff, session.continuationKey],
    );
    const candidate = candidates[0];
    if (candidate?.disposition !== "eligible") return false;
    const { options } = candidate;
    const reduced = { ...summarizePayloadAgent(options), toolPolicy: options.toolPolicy };
    const result = await client.query(
      `update agent_sessions
       set creation_options = $2, options_reduced_at = $3,
           data = jsonb_set(data, '{creationOptions}', $2)
       where id = $1 and options_reduced_at is null`,
      [id, reduced, now],
    );
    return result.rowCount === 1;
  });
}
