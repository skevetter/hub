import {
  PROGRESS_UNSETTLED_SQL,
  SCRIPT_CLEANUP_SQL,
  type RunPayloadCandidate,
} from "../run-payload-retention/store.js";
import type { QueryHandle } from "./runtime/index.js";

import {
  coversExpectedFanout,
  expectedFanout,
  readPinnedRoutes,
  type AdmittedBranch,
  type ExpectedFanout,
  type FanoutReceipt,
  type FanoutRevision,
} from "../run-payload-retention/fanout.js";

interface ReceiptFanout {
  receiptId: string;
  organizationId: string;
  expected: ExpectedFanout | undefined;
}

async function loadReceiptFanout(database: QueryHandle, receiptIds: readonly string[]) {
  const proofs = new Map<string, ReceiptFanout>();
  if (receiptIds.length === 0) return proofs;
  const receipts = await database.query<FanoutReceipt & Record<string, unknown>>(
    `select id, organization_id as "organizationId", provider, source, accepted_routes as "acceptedRoutes",
       case when provider in ('github', 'linear') then payload end as payload
     from provider_event_receipts where id = any($1::uuid[])`,
    [receiptIds],
  );
  const revisionIds = new Set<string>();
  for (const receipt of receipts.rows) {
    if (receipt.provider !== "github" && receipt.provider !== "linear") continue;
    for (const route of readPinnedRoutes(receipt) ?? [])
      revisionIds.add(route.configurationRevisionId);
  }
  const revisions = new Map<string, FanoutRevision>();
  if (revisionIds.size > 0) {
    const found = await database.query<FanoutRevision & { id: string } & Record<string, unknown>>(
      `select id, project_id as "projectId", organization_id as "organizationId",
         normalized_configuration as "normalizedConfiguration"
       from project_configuration_revisions where id = any($1::uuid[])`,
      [[...revisionIds]],
    );
    for (const revision of found.rows) revisions.set(revision.id, revision);
  }
  for (const receipt of receipts.rows) {
    proofs.set(receipt.id, {
      receiptId: receipt.id,
      organizationId: receipt.organizationId,
      expected: expectedFanout(receipt, (id) => revisions.get(id)),
    });
  }
  return proofs;
}

async function loadAdmittedBranches(database: QueryHandle, receiptIds: readonly string[]) {
  const byReceipt = new Map<string, AdmittedBranch[]>();
  if (receiptIds.length === 0) return byReceipt;
  const result = await database.query<
    AdmittedBranch & { receiptId: string } & Record<string, unknown>
  >(
    `select provider_event_receipt_id as "receiptId", project_id as "projectId",
       configuration_revision_id as "configurationRevisionId", configured_trigger_name as "configuredTriggerName"
     from trigger_runs where provider_event_receipt_id = any($1::uuid[])`,
    [receiptIds],
  );
  for (const branch of result.rows) {
    const existing = byReceipt.get(branch.receiptId);
    if (existing === undefined) byReceipt.set(branch.receiptId, [branch]);
    else existing.push(branch);
  }
  return byReceipt;
}

export async function prepareRunPayloadFanout(database: QueryHandle, runId: string, cutoff: Date) {
  const runs = await database.query<{ receiptId: string }>(
    `select provider_event_receipt_id as "receiptId" from trigger_runs
     where id = $1 and status <> 'running' and completed_at is not null
       and payload_expiry_state is distinct from 'expired'
       and (completed_at < $2 or payload_expiry_state = 'expiring')`,
    [runId, cutoff],
  );
  const run = runs.rows[0];
  if (run === undefined) return undefined;
  return (await loadReceiptFanout(database, [run.receiptId])).get(run.receiptId);
}

export async function recheckRunPayloadFanout(database: QueryHandle, receipt: ReceiptFanout) {
  if (receipt.expected === undefined) return false;
  if (receipt.expected.length === 0) return true;
  const branches = await loadAdmittedBranches(database, [receipt.receiptId]);
  return coversExpectedFanout(receipt.expected, branches.get(receipt.receiptId) ?? []);
}

export const RUN_PAYLOAD_DISPOSITION_SQL = `case
  when run.status = 'running' then 'live'
  when run.completed_at is null then 'missing_completion'
  when run.completed_at >= $2 and run.payload_expiry_state is distinct from 'expiring' then 'not_old_enough'
  when exists (select 1 from workflow_step_runs step where step.trigger_run_id = run.id and (${SCRIPT_CLEANUP_SQL}))
    then 'cleanup_blocked'
  when exists (select 1 from workflow_wakeups wakeup where wakeup.trigger_run_id = run.id)
    or exists (select 1 from workflow_step_runs step where step.trigger_run_id = run.id
      and (step.status = 'running' or (step.status = 'pending' and step.dispatch_intent is not null)))
    or exists (
      select 1 from (
        ${runExecutions("run", "execution.status, execution.completed_at, execution.hub_action, execution.hub_action_completed_at, execution.output_delivery_attempts")}
      ) execution
      where execution.status in ('spawning', 'running') or execution.completed_at is null
        or (execution.hub_action is not null and execution.hub_action_completed_at is null)
        or exists (select 1 from jsonb_each(execution.output_delivery_attempts) attempt
          where attempt.value ->> 'status' = 'pending')
    )
    then 'live'
  when run.terminal_notification_lease_expires_at is not null
    or (run.terminal_notification_pending_at is not null and run.terminal_notification_delivered_at is null)
    then 'notification_pending'
  when exists (select 1 from run_progress_messages message
    where message.trigger_run_id = run.id and ${PROGRESS_UNSETTLED_SQL})
    then 'reporter_pending'
  else 'eligible'
end`;

export function runExecutions(run: string, projection: string) {
  return `
    select ${projection} from workflow_step_runs step
    join agent_executions execution on execution.workflow_step_run_id = step.id
    where step.trigger_run_id = ${run}.id
      and execution.organization_id = ${run}.organization_id and execution.project_id = ${run}.project_id
    union
    select ${projection} from workflow_step_runs step
    join agent_executions execution on execution.id = step.agent_execution_id
    where step.trigger_run_id = ${run}.id
      and execution.organization_id = ${run}.organization_id and execution.project_id = ${run}.project_id
    union
    select ${projection} from agent_executions execution
    where execution.workflow_step_run_id is null
      and (execution.launch_run_id = ${run}.id or
        (execution.launch_intent ->> 'kind' = 'launch_machine'
          and execution.launch_intent ->> 'triggerRunId' = ${run}.id::text))
      and execution.organization_id = ${run}.organization_id and execution.project_id = ${run}.project_id`;
}

export async function scanRunPayloads(
  database: QueryHandle,
  after: string | null,
  cutoff: Date,
  limit: number,
  countOnly: boolean,
): Promise<RunPayloadCandidate[]> {
  const result = await database.query<
    RunPayloadCandidate & { receiptId: string; organizationId: string } & Record<string, unknown>
  >(
    `with candidates as materialized (
      select id, status, completed_at, created_at, payload_expiry_state,
        organization_id, project_id, provider_event_receipt_id, terminal_notification_lease_expires_at,
        terminal_notification_pending_at, terminal_notification_delivered_at
      from trigger_runs
      where ($1::uuid is null or id > $1) and payload_expiry_state is distinct from 'expired'
        ${countOnly ? "" : "and status <> 'running' and (completed_at < $2 or payload_expiry_state = 'expiring')"}
      order by id limit $3
    )
    select run.id, run.provider_event_receipt_id as "receiptId", run.organization_id as "organizationId",
      ${RUN_PAYLOAD_DISPOSITION_SQL} as disposition,
      coalesce(run.completed_at, run.created_at) as "ageFrom"
    from candidates run order by run.id`,
    [after, cutoff, limit],
  );
  const eligibleReceipts = [
    ...new Set(
      result.rows.filter((run) => run.disposition === "eligible").map((run) => run.receiptId),
    ),
  ];
  const proofs = await loadReceiptFanout(database, eligibleReceipts);
  const branches = await loadAdmittedBranches(
    database,
    [...proofs.values()]
      .filter((proof) => (proof.expected?.length ?? 0) > 0)
      .map((proof) => proof.receiptId),
  );
  return result.rows.map(({ id, disposition, ageFrom, receiptId, organizationId }) => {
    if (disposition !== "eligible") return { id, disposition, ageFrom };
    const proof = proofs.get(receiptId);
    const settled =
      proof?.organizationId === organizationId &&
      coversExpectedFanout(proof.expected, branches.get(receiptId) ?? []);
    return { id, disposition: settled ? "eligible" : "fan_out_unresolved", ageFrom };
  });
}
