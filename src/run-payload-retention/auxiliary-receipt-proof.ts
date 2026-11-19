import { z } from "zod";
import type { ProviderEventReceiptRecord } from "../db/types.js";
import type { CursorDiagnosticDisposition, SyncPayloadDisposition } from "./receipt-store.js";
import { isLifecycleReceipt } from "./receipt-proof.js";

const auditLinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("receipt"), receiptId: z.uuid(), organizationId: z.string().min(1) }),
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("unproven") }),
]);

export function readSyncAuditLink(link: unknown) {
  const parsed = auditLinkSchema.safeParse(link);
  return parsed.success ? parsed.data : undefined;
}

export interface GitHubSyncPayloadEvidence {
  id: string;
  providerApplicationId: string | null;
  connectionId: string | null;
  deliveryId: string | null;
  signatureHash: string | null;
  source: string | null;
  retryAt: Date | null;
  receivedAt: Date;
  settledAt: Date | null;
  auditLink: unknown;
  payloadExpiredAt: Date | null;
}

export type SyncReceiptEvidence = Pick<
  ProviderEventReceiptRecord,
  | "id"
  | "organizationId"
  | "provider"
  | "source"
  | "connectionId"
  | "resourceId"
  | "providerApplicationId"
  | "deliveryId"
  | "signatureHash"
  | "receivedAt"
  | "droppedReason"
  | "payloadExpiryState"
> & { acceptedRoutes: unknown };

export function isExactSyncReceipt(
  sync: Pick<
    GitHubSyncPayloadEvidence,
    "providerApplicationId" | "connectionId" | "deliveryId" | "signatureHash" | "source"
  >,
  receipt: SyncReceiptEvidence,
  organizationId: string,
): boolean {
  return (
    isLifecycleReceipt(receipt) &&
    receipt.organizationId === organizationId &&
    sync.connectionId !== null &&
    receipt.connectionId === sync.connectionId &&
    receipt.resourceId === null &&
    sync.providerApplicationId !== null &&
    receipt.providerApplicationId === sync.providerApplicationId &&
    receipt.source === sync.source &&
    receipt.deliveryId === sync.deliveryId &&
    sync.signatureHash !== null &&
    receipt.signatureHash === sync.signatureHash &&
    receipt.acceptedRoutes === null &&
    receipt.payloadExpiryState == null
  );
}

export function syncPayloadDisposition(
  sync: GitHubSyncPayloadEvidence,
  receipt: (SyncReceiptEvidence & { hasReferences: boolean }) | undefined,
  hasAnyCopy: boolean,
  cutoff: Date,
): SyncPayloadDisposition {
  if (sync.retryAt !== null) return "sync_pending";
  if (sync.settledAt === null) return "historical_settlement_unknown";
  if (sync.settledAt >= cutoff || sync.receivedAt >= cutoff) return "not_old_enough";
  const link = readSyncAuditLink(sync.auditLink);
  if (link?.kind === "none")
    return sync.connectionId === null && !hasAnyCopy ? "eligible" : "audit_link_unproven";
  if (
    link?.kind !== "receipt" ||
    receipt?.id !== link.receiptId ||
    !isExactSyncReceipt(sync, receipt, link.organizationId)
  )
    return "audit_link_unproven";
  if (receipt.receivedAt >= cutoff) return "not_old_enough";
  return receipt.hasReferences ? "unexpected_references" : "eligible";
}

export const EXPIRED_CURSOR_DIAGNOSTIC =
  "GitHub notifications polling failed. Older error details expired.";

export interface CursorDiagnosticEvidence {
  lastError: string | null;
  lastErrorAt: Date | null;
  diagnosticExpiredAt: Date | null;
}

export function cursorDiagnosticDisposition(
  evidence: CursorDiagnosticEvidence,
  cutoff: Date,
): CursorDiagnosticDisposition {
  if (evidence.diagnosticExpiredAt !== null) return "already_reduced";
  if (evidence.lastErrorAt === null) return "missing_error_timestamp";
  return evidence.lastErrorAt < cutoff ? "eligible" : "not_old_enough";
}
