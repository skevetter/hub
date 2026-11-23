import { createHash } from "node:crypto";
import type { QueryHandle } from "../db/runtime/index.js";

const reasons = {
  awaiting: "linear_pilot_awaiting_owner",
  started: "linear_pilot_owner_confirmed",
  expired: "linear_pilot_owner_expired",
  refused: "linear_pilot_owner_confirmation_refused",
} as const;

type ClaimKind = keyof typeof reasons;

interface ConfirmationKey {
  organizationId: string;
  workspaceId: string;
  applicationId: string;
  appUserId: string;
  connectionId: string;
  nativeSessionId: string;
  issueId: string;
}

function confirmationKey(input: ConfirmationKey, kind: ClaimKind) {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.workspaceId, input.appUserId, input.nativeSessionId]))
    .digest("hex");
  const keyKind = (
    {
      refused: "awaiting",
      expired: "started",
      awaiting: "awaiting",
      started: "started",
    } as const
  )[kind];
  return `${reasons[keyKind]}:${digest}`;
}

export async function waitingConfirmation(query: QueryHandle, input: ConfirmationKey) {
  const {
    rows: [row],
  } = await query.query<{
    receivedAt: Date;
    issueId: string | null;
    applicationId: string | null;
  }>(
    `select received_at as "receivedAt", resource_id as "issueId",
            provider_application_id as "applicationId"
       from provider_event_receipts
      where organization_id = $1 and provider = 'linear' and delivery_id = $2
        and dropped_reason = $3`,
    [input.organizationId, confirmationKey(input, "awaiting"), reasons.awaiting],
  );
  return row;
}

export async function claimConfirmation(
  query: QueryHandle,
  input: ConfirmationKey,
  kind: ClaimKind,
  receivedAt: Date,
) {
  const result = await query.query(
    `insert into provider_event_receipts
       (organization_id, provider, connection_id, delivery_id, provider_application_id,
        source, resource_id, payload, received_at, dropped_reason)
     values ($1, 'linear', $2, $3, $4, 'linear.agent_session', $5, '{}'::jsonb, $6, $7)
     on conflict do nothing`,
    [
      input.organizationId,
      input.connectionId,
      confirmationKey(input, kind),
      input.applicationId,
      input.issueId,
      receivedAt,
      reasons[kind],
    ],
  );
  return result.rowCount === 1;
}
