import type { DatabaseRuntime, QueryHandle } from "./runtime/index.js";
import { readFanoutRevisions, runPayloadWorkDisposition } from "./run-payload-retention.js";
import { parsePinnedRoutes } from "../run-payload-retention/fanout.js";
import {
  proveReceipt,
  type ReceiptProofBranch,
  type ReceiptProofEvidence,
} from "../run-payload-retention/receipt-proof.js";
import type {
  ReceiptExpiryCandidate,
  ReceiptExpiryResult,
} from "../run-payload-retention/receipt-store.js";

const RECEIPT_COLUMNS = `
  receipt.id, receipt.organization_id as "organizationId", receipt.provider,
  receipt.connection_id as "connectionId", receipt.resource_id as "resourceId",
  receipt.delivery_id as "deliveryId", receipt.signature_hash as "signatureHash",
  receipt.provider_application_id as "providerApplicationId",
  receipt.provider_configuration_version as "providerConfigurationVersion",
  receipt.source, receipt.repo, receipt.payload, receipt.received_at as "receivedAt",
  receipt.dropped_reason as "droppedReason", receipt.accepted_routes as "acceptedRoutes",
  receipt.payload_expiry_state as "payloadExpiryState", receipt.payload_expired_at as "payloadExpiredAt",
  receipt.pre_routing_drop as "preRoutingDrop", receipt.manual_replay_binding as "manualReplayBinding",
  exists (select 1 from attachment_capabilities capability
    where capability.provider_event_receipt_id = receipt.id) as "hasCapability",
  (receipt.provider = 'github' and exists (select 1 from github_installation_syncs sync
    where sync.retry_at is not null and (sync.delivery_id = receipt.delivery_id or sync.signature_hash = receipt.signature_hash)
  )) as "hasLifecycleWork",
  (
    (receipt.provider = 'github' and exists (
      select 1 from github_connections connection
       where connection.id = receipt.connection_id and connection.organization_id = receipt.organization_id
         and (receipt.provider_application_id is null or connection.provider_application_id = receipt.provider_application_id)
    )) or (receipt.provider = 'linear' and exists (
      select 1 from linear_connections connection
       where connection.id = receipt.connection_id and connection.organization_id = receipt.organization_id
         and (receipt.provider_application_id is null or connection.provider_application_id = receipt.provider_application_id)
    ))
  ) as "legacyBindingValid"`;

const LIFECYCLE_RECEIPT_SQL = `receipt.provider = 'github'
  and receipt.source in ('github.installation', 'github.installation_repositories')
  and receipt.dropped_reason is not distinct from 'github_lifecycle'`;

type ProofRow = ReceiptProofEvidence & Record<string, unknown>;

async function checkReceipts(
  client: QueryHandle,
  receipts: readonly ReceiptProofEvidence[],
  cutoff: Date,
) {
  if (receipts.length === 0) return [];
  const ids = receipts.map((receipt) => receipt.id);
  const revisionIds = new Set(
    receipts.flatMap((receipt) =>
      (parsePinnedRoutes(receipt.acceptedRoutes) ?? []).map(
        (route) => route.configurationRevisionId,
      ),
    ),
  );
  const revisions = await readFanoutRevisions(client, [...revisionIds]);
  const result = await client.query<
    ReceiptProofBranch & { receiptId: string } & Record<string, unknown>
  >(
    `select run.organization_id as "organizationId", run.project_id as "projectId",
        run.provider_event_receipt_id as "receiptId", run.configuration_revision_id as "configurationRevisionId",
        run.configured_trigger_name as "configuredTriggerName", run.outcome,
        run.payload_expiry_state as "payloadExpiryState", run.payload_expired_at as "payloadExpiredAt",
        case (${runPayloadWorkDisposition()})
          when 'cleanup_blocked' then 'live_execution'
          when 'live' then 'live_execution'
          when 'notification_pending' then 'notification_pending'
          when 'reporter_pending' then 'reporter_pending' end as blocker
     from trigger_runs run where run.provider_event_receipt_id = any($1::uuid[]) order by run.id`,
    [ids],
  );
  const branches = new Map<string, ReceiptProofBranch[]>();
  for (const branch of result.rows) {
    const existing = branches.get(branch.receiptId);
    if (existing === undefined) branches.set(branch.receiptId, [branch]);
    else existing.push(branch);
  }
  return receipts.map((receipt) =>
    proveReceipt(receipt, branches.get(receipt.id) ?? [], (id) => revisions.get(id), cutoff),
  );
}

export async function scanReceiptPayloads(
  client: QueryHandle,
  after: string | null,
  cutoff: Date,
  limit: number,
  state: "intact" | "expiring" = "intact",
): Promise<ReceiptExpiryCandidate[]> {
  const receipts = await client.query<ProofRow>(
    `select ${RECEIPT_COLUMNS}
     from provider_event_receipts receipt
     where ($1::uuid is null or receipt.id > $1)
       and receipt.payload_expiry_state is not distinct from $3
       and not ((${LIFECYCLE_RECEIPT_SQL}) and exists (
         select 1 from github_installation_syncs sync
          where sync.delivery_id = receipt.delivery_id or sync.signature_hash = receipt.signature_hash
       ))
     order by receipt.id limit $2`,
    [after, limit, state === "intact" ? null : state],
  );
  const proofs = await checkReceipts(client, receipts.rows, cutoff);
  return receipts.rows.map((receipt, index) => ({
    id: receipt.id,
    ageFrom: receipt.receivedAt,
    disposition: proofs[index]!.disposition,
  }));
}

export async function expireReceiptPayload(
  database: DatabaseRuntime,
  id: string,
  cutoff: Date,
  now: Date,
): Promise<ReceiptExpiryResult> {
  return database.transaction(async (client) => {
    const lock = await client.query(
      `select id from provider_event_receipts
       where id = $1 and payload_expiry_state is distinct from 'expired' for update skip locked`,
      [id],
    );
    if (lock.rowCount === 0) return { status: "skipped", disposition: "locked_or_missing" };
    const receipts = await client.query<ProofRow>(
      `select ${RECEIPT_COLUMNS} from provider_event_receipts receipt where receipt.id = $1`,
      [id],
    );
    const [proof] = await checkReceipts(client, receipts.rows, cutoff);
    if (proof === undefined) return { status: "skipped", disposition: "locked_or_missing" };
    if (proof.disposition !== "eligible" && proof.disposition !== "expiring")
      return { status: "skipped", disposition: proof.disposition };
    if (proof.disposition === "eligible") {
      const staged = await client.query(
        `update provider_event_receipts set payload_expiry_state = 'expiring', payload_expired_at = $2,
            payload = '{}'::jsonb, accepted_routes = null, pre_routing_drop = null, manual_replay_binding = $4
          where id = $1 and payload_expiry_state is null and received_at < $3`,
        [id, now, cutoff, proof.binding],
      );
      if (staged.rowCount !== 1) return { status: "skipped", disposition: "locked_or_missing" };
    }
    const result = await client.query(
      `update provider_event_receipts set payload_expiry_state = 'expired'
        where id = $1 and payload_expiry_state = 'expiring'`,
      [id],
    );
    if (result.rowCount !== 1) throw new Error("receipt expiry lost its locked row");
    return { status: "expired" };
  });
}
