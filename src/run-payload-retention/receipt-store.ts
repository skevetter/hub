import type { ReceiptDisposition } from "./receipt-proof.js";

export type SyncPayloadDisposition =
  | "eligible"
  | "not_old_enough"
  | "sync_pending"
  | "historical_settlement_unknown"
  | "audit_link_unproven"
  | "unexpected_references";

export type CursorDiagnosticDisposition =
  | "eligible"
  | "not_old_enough"
  | "missing_error_timestamp"
  | "already_reduced";

export interface ReceiptExpiryCandidate {
  id: string;
  ageFrom: Date;
  disposition: ReceiptDisposition;
}

export interface SyncExpiryCandidate {
  id: string;
  ageFrom: Date;
  disposition: SyncPayloadDisposition;
  receiptCopy: boolean;
}

export interface CursorDiagnosticCandidate {
  source: string;
  ageFrom: Date | null;
  disposition: CursorDiagnosticDisposition;
}

export type ReceiptExpiryResult =
  | { status: "expired" }
  | {
      status: "skipped";
      disposition: Exclude<ReceiptDisposition, "eligible" | "expiring"> | "locked_or_missing";
    };

export type SyncExpiryResult =
  | { status: "expired"; receiptCopy: boolean }
  | {
      status: "skipped";
      disposition: Exclude<SyncPayloadDisposition, "eligible"> | "locked_or_missing";
    };

export type CursorDiagnosticExpiryResult =
  | { status: "expired" }
  | {
      status: "skipped";
      disposition: Exclude<CursorDiagnosticDisposition, "eligible"> | "locked_or_missing";
    };

export interface ReceiptPayloadStore {
  scanReceiptPayloads(
    after: string | null,
    cutoff: Date,
    limit: number,
    state?: "intact" | "expiring",
  ): Promise<ReceiptExpiryCandidate[]>;
  expireReceiptPayload(id: string, cutoff: Date, now: Date): Promise<ReceiptExpiryResult>;
  scanGitHubSyncPayloads(
    after: string | null,
    cutoff: Date,
    limit: number,
  ): Promise<SyncExpiryCandidate[]>;
  expireGitHubSyncPayload(id: string, cutoff: Date, now: Date): Promise<SyncExpiryResult>;
  scanGitHubCursorDiagnostics(
    after: string | null,
    cutoff: Date,
    limit: number,
  ): Promise<CursorDiagnosticCandidate[]>;
  expireGitHubCursorDiagnostic(
    source: string,
    cutoff: Date,
    now: Date,
  ): Promise<CursorDiagnosticExpiryResult>;
}
