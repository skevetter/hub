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

export interface ReceiptExpiryPage {
  candidates: ReceiptExpiryCandidate[];
  nextCursor: string | null;
}

export interface SyncExpiryCandidate {
  id: string;
  ageFrom: Date;
  disposition: SyncPayloadDisposition;
  receiptCopyAgeFrom: Date | null;
}

export interface CursorDiagnosticCandidate {
  source: string;
  ageFrom: Date | null;
  disposition: CursorDiagnosticDisposition;
}

type ApplyMiss = "locked" | "changed_or_missing";

export type ReceiptExpiryResult =
  | { status: "expired" }
  | {
      status: "skipped";
      disposition: Exclude<ReceiptDisposition, "eligible" | "expiring"> | ApplyMiss;
    };

export type SyncExpiryResult =
  | { status: "expired"; receiptCopy: boolean }
  | {
      status: "skipped";
      disposition: Exclude<SyncPayloadDisposition, "eligible"> | ApplyMiss;
    };

export type CursorDiagnosticExpiryResult =
  | { status: "expired" }
  | {
      status: "skipped";
      disposition: Exclude<CursorDiagnosticDisposition, "eligible"> | ApplyMiss;
    };

export interface ReceiptPayloadStore {
  scanReceiptPayloads(
    after: string | null,
    cutoff: Date,
    limit: number,
    state?: "intact" | "expiring",
  ): Promise<ReceiptExpiryPage>;
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
