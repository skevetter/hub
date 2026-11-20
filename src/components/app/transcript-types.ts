export type DeliveryStatus = "delivered" | "queued" | "not_sent" | "unknown" | "sending" | "failed";
export type ToolStatus = "running" | "completed" | "failed" | "canceled";

/**
 * `seq` is the daemon's position for the entry. A Hub message the daemon has not yet echoed has
 * none: it is queued, unsent, or of unknown fate, and sits after everything the agent has said.
 */
export type TranscriptItem = { id: string } & (
  | {
      kind: "human";
      author: string;
      /** `null` once the body has expired; the entry stays as a place marker. */
      text: string | null;
      status: DeliveryStatus;
      retryable?: boolean;
      seq: number | null;
    }
  | { kind: "assistant"; text: string; truncated: boolean; seq: number }
  | { kind: "tool"; name: string; status: ToolStatus; seq: number }
  | { kind: "boundary"; label: string; seq: number }
);
