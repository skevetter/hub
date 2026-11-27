import {
  EXPIRED_CURSOR_DIAGNOSTIC,
  cursorDiagnosticDisposition,
  readSyncAuditLink,
  syncPayloadDisposition,
  type CursorDiagnosticEvidence,
  type GitHubSyncPayloadEvidence,
  type SyncReceiptEvidence,
} from "../run-payload-retention/auxiliary-receipt-proof.js";
import type {
  CursorDiagnosticCandidate,
  CursorDiagnosticExpiryResult,
  SyncExpiryCandidate,
  SyncExpiryResult,
} from "../run-payload-retention/receipt-store.js";
import type { DatabaseRuntime, QueryHandle } from "./runtime/index.js";

type SyncRow = GitHubSyncPayloadEvidence & { hasAnyCopy: boolean } & Record<string, unknown>;
type CopyRow = SyncReceiptEvidence & { hasReferences: boolean } & Record<string, unknown>;
type CursorRow = CursorDiagnosticEvidence & { source: string } & Record<string, unknown>;

const SYNC_COLUMNS = `
  sync.id, sync.provider_application_id as "providerApplicationId", sync.connection_id as "connectionId",
  sync.delivery_id as "deliveryId", sync.signature_hash as "signatureHash", sync.source,
  sync.retry_at as "retryAt", sync.received_at as "receivedAt", sync.settled_at as "settledAt",
  sync.audit_link as "auditLink", sync.payload_expired_at as "payloadExpiredAt"`;

const SYNC_HAS_COPY = `exists (select 1 from provider_event_receipts receipt
     where receipt.signature_hash = sync.signature_hash
       or receipt.delivery_id = sync.delivery_id)`;

async function readCopies(client: QueryHandle, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, CopyRow>();
  const copies = await client.query<CopyRow>(
    `select receipt.id, receipt.organization_id as "organizationId", receipt.provider, receipt.source,
        receipt.connection_id as "connectionId", receipt.resource_id as "resourceId",
        receipt.provider_application_id as "providerApplicationId", receipt.delivery_id as "deliveryId",
        receipt.signature_hash as "signatureHash", receipt.received_at as "receivedAt",
        receipt.dropped_reason as "droppedReason", receipt.accepted_routes as "acceptedRoutes",
        receipt.payload_expiry_state as "payloadExpiryState",
        (exists (select 1 from trigger_runs run where run.provider_event_receipt_id = receipt.id)
         or exists (select 1 from attachment_capabilities cap where cap.provider_event_receipt_id = receipt.id))
           as "hasReferences"
      from provider_event_receipts receipt where receipt.id = any($1::uuid[])`,
    [ids],
  );
  return new Map(copies.rows.map((receipt) => [receipt.id, receipt]));
}

export async function scanGitHubSyncPayloads(
  client: QueryHandle,
  after: string | null,
  cutoff: Date,
  limit: number,
): Promise<SyncExpiryCandidate[]> {
  const syncs = await client.query<
    SyncRow & { receiptCopyAgeFrom: Date | null; needsProof: boolean | null }
  >(
    `with page as materialized (
       select id, received_at < $3 and settled_at < $3 and retry_at is null as "needsProof"
       from github_installation_syncs
       where ($1::uuid is null or id > $1) and kind = 'webhook' and payload_expired_at is null
       order by id limit $2
     )
     select ${SYNC_COLUMNS}, page."needsProof",
        case when page."needsProof" and sync.audit_link->>'kind' = 'none'
          then ${SYNC_HAS_COPY} else false end as "hasAnyCopy",
        (select receipt.received_at from provider_event_receipts receipt
         where receipt.signature_hash = sync.signature_hash and receipt.provider = 'github'
           and receipt.source in ('github.installation', 'github.installation_repositories')
           and receipt.dropped_reason = 'github_lifecycle' and receipt.payload_expiry_state is null
        ) as "receiptCopyAgeFrom"
      from page
      cross join lateral (
        select * from github_installation_syncs where id = page.id limit 1
      ) sync order by page.id`,
    [after, limit, cutoff],
  );
  const copies = await readCopies(
    client,
    syncs.rows.flatMap((sync) => {
      if (!sync.needsProof) return [];
      const link = readSyncAuditLink(sync.auditLink);
      return link?.kind === "receipt" ? [link.receiptId] : [];
    }),
  );
  return syncs.rows.map((sync) => {
    const link = readSyncAuditLink(sync.auditLink);
    const copy = link?.kind === "receipt" ? copies.get(link.receiptId) : undefined;
    return {
      id: sync.id,
      ageFrom: sync.settledAt ?? sync.receivedAt,
      disposition: syncPayloadDisposition(sync, copy, sync.hasAnyCopy, cutoff),
      receiptCopyAgeFrom: sync.receiptCopyAgeFrom,
    };
  });
}

export async function expireGitHubSyncPayload(
  database: DatabaseRuntime,
  id: string,
  cutoff: Date,
  now: Date,
): Promise<SyncExpiryResult> {
  return database.transaction(async (client) => {
    const lock = await client.query(
      `select id from github_installation_syncs
       where id = $1 and kind = 'webhook' and payload_expired_at is null for update skip locked`,
      [id],
    );
    if (lock.rowCount === 0) {
      const remaining = await client.query(
        `select id from github_installation_syncs
         where id = $1 and kind = 'webhook' and payload_expired_at is null`,
        [id],
      );
      return {
        status: "skipped",
        disposition: remaining.rowCount ? "locked" : "changed_or_missing",
      };
    }
    const { rows } = await readSyncForPayloadExpiry(client, id);
    const { sync, receiptId } = syncExpiryEvidence(rows[0]);
    let copy: CopyRow | undefined;
    if (receiptId !== undefined) {
      const receiptLock = await client.query(
        `select id from provider_event_receipts where id = $1 for update skip locked`,
        [receiptId],
      );
      copy = (await readCopies(client, [receiptId])).get(receiptId);
      if (receiptLock.rowCount === 0 && copy !== undefined)
        return { status: "skipped", disposition: "locked" };
    }
    const disposition = syncPayloadDisposition(sync, copy, sync.hasAnyCopy, cutoff);
    if (disposition !== "eligible") return { status: "skipped", disposition };
    if (copy !== undefined) {
      const redacted = await client.query(
        `update provider_event_receipts
         set payload = '{}'::jsonb, accepted_routes = null, pre_routing_drop = null, manual_replay_binding = null,
             payload_expiry_state = 'expired', payload_expired_at = $2
         where id = $1 and payload_expiry_state is null and received_at < $3`,
        [copy.id, now, cutoff],
      );
      if (redacted.rowCount !== 1) throw new Error("sync expiry lost its locked receipt");
    }
    const result = await client.query(
      `update github_installation_syncs set payload = '{}'::jsonb, payload_expired_at = $2
        where id = $1 and payload_expired_at is null and retry_at is null
          and settled_at < $3 and received_at < $3`,
      [id, now, cutoff],
    );
    if (result.rowCount !== 1) throw new Error("sync expiry lost its locked sync");
    return { status: "expired", receiptCopy: copy !== undefined };
  });
}

function readSyncForPayloadExpiry(client: QueryHandle, id: string) {
  return client.query<SyncRow>(
    `select ${SYNC_COLUMNS},
           case when sync.audit_link->>'kind' = 'none' then ${SYNC_HAS_COPY} else false end as "hasAnyCopy"
         from github_installation_syncs sync where id = $1`,
    [id],
  );
}

function syncExpiryEvidence(sync: SyncRow | undefined) {
  if (sync === undefined)
    throw new TypeError("Cannot read properties of undefined (reading 'auditLink')");
  const link = readSyncAuditLink(sync.auditLink);
  return { sync, receiptId: link?.kind === "receipt" ? link.receiptId : undefined };
}

const CURSOR_EVIDENCE = `source, last_error as "lastError", last_error_at as "lastErrorAt",
  diagnostic_expired_at as "diagnosticExpiredAt"`;

export async function scanGitHubCursorDiagnostics(
  client: QueryHandle,
  after: string | null,
  cutoff: Date,
  limit: number,
): Promise<CursorDiagnosticCandidate[]> {
  const cursors = await client.query<CursorRow>(
    `select ${CURSOR_EVIDENCE} from github_notification_cursors
      where ($1::text is null or source > $1) and last_error is not null
      order by source limit $2`,
    [after, limit],
  );
  return cursors.rows.map((cursor) => ({
    source: cursor.source,
    ageFrom: cursor.lastErrorAt,
    disposition: cursorDiagnosticDisposition(cursor, cutoff),
  }));
}

export async function expireGitHubCursorDiagnostic(
  database: DatabaseRuntime,
  source: string,
  cutoff: Date,
  now: Date,
): Promise<CursorDiagnosticExpiryResult> {
  return database.transaction(async (client) => {
    const row = (
      await client.query<CursorRow>(
        `select ${CURSOR_EVIDENCE} from github_notification_cursors
       where source = $1 and last_error is not null for update skip locked`,
        [source],
      )
    ).rows[0];
    if (row === undefined) {
      const remaining = await client.query(
        `select source from github_notification_cursors
         where source = $1 and last_error is not null and diagnostic_expired_at is null`,
        [source],
      );
      return {
        status: "skipped",
        disposition: remaining.rowCount ? "locked" : "changed_or_missing",
      };
    }
    const disposition = cursorDiagnosticDisposition(row, cutoff);
    if (disposition !== "eligible") return { status: "skipped", disposition };
    const result = await client.query(
      `update github_notification_cursors set last_error = $2, diagnostic_expired_at = $3
       where source = $1 and last_error is not null and diagnostic_expired_at is null and last_error_at < $4`,
      [source, EXPIRED_CURSOR_DIAGNOSTIC, now, cutoff],
    );
    if (result.rowCount !== 1) throw new Error("diagnostic expiry lost its locked cursor");
    return { status: "expired" };
  });
}
