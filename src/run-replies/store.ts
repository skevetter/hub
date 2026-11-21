export interface RunReplyScope {
  organizationId: string;
  runId: string;
}

export const replyFailureLabels = {
  run_unsuccessful: "The run did not succeed.",
  empty_answer: "The agent did not send a final answer.",
  answer_unavailable: "Hub could not recover the final answer.",
  target_mismatch: "The original Linear issue or comment could not be verified.",
  connection_unavailable: "The original Linear connection is unavailable.",
  scope_missing: "The Linear connection cannot create comments.",
  body_contains_secret: "The reply could not be sent safely.",
  rate_limited: "This organization reached the reply limit for the last hour.",
  provider_rejected: "Linear declined the comment.",
  delivery_unconfirmed: "Hub could not confirm whether Linear received the comment.",
} as const;

export type RunReplyFailure = keyof typeof replyFailureLabels;

export interface RunReplyRecord extends RunReplyScope {
  state: "pending" | "sending" | "sent" | "refused";
  commentId: string;
  length: number | null;
  hash: string | null;
  bindingHash: string | null;
  attemptedAt: Date | null;
  failure: RunReplyFailure | null;
}

export interface RunReplyReservation extends RunReplyScope {
  length: number;
  hash: string;
  bindingHash: string;
  perHour: number;
}

export type RunReplyAdmission = "reserved" | "already_handled" | "run_unavailable" | "rate_limited";

export type FinishRunReply = RunReplyScope &
  ({ from: "pending" | "sending"; failure: RunReplyFailure } | { from: "sending"; failure: null });

export interface RunReplyStore {
  find(scope: RunReplyScope): Promise<RunReplyRecord | undefined>;
  reserve(input: RunReplyReservation): Promise<RunReplyAdmission>;
  finish(input: FinishRunReply): Promise<boolean>;
  recoverable(cutoff: Date): Promise<RunReplyRecord[]>;
}
