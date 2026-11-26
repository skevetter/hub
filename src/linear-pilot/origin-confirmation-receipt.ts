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

interface Claim {
  kind: ClaimKind;
  receivedAt: Date;
  /** The owner reply that won a "started" claim; later deliveries of it are replays. */
  activityId?: string;
}

export async function claimConfirmation(query: QueryHandle, input: ConfirmationKey, claim: Claim) {
  const { kind, receivedAt, activityId } = claim;
  const result = await query.query(
    `insert into provider_event_receipts
       (organization_id, provider, connection_id, delivery_id, provider_application_id,
        source, resource_id, payload, received_at, dropped_reason)
     values ($1, 'linear', $2, $3, $4, 'linear.agent_session', $5, $6::jsonb, $7, $8)
     on conflict do nothing`,
    [
      input.organizationId,
      input.connectionId,
      confirmationKey(input, kind),
      input.applicationId,
      input.issueId,
      JSON.stringify(activityId === undefined ? {} : { activityId: activityId.toLowerCase() }),
      receivedAt,
      reasons[kind],
    ],
  );
  return result.rowCount === 1;
}

export async function confirmingActivityId(query: QueryHandle, input: ConfirmationKey) {
  const {
    rows: [row],
  } = await query.query<{ activityId: string | null }>(
    `select payload->>'activityId' as "activityId"
       from provider_event_receipts
      where organization_id = $1 and provider = 'linear' and delivery_id = $2
        and dropped_reason = $3`,
    [input.organizationId, confirmationKey(input, "started"), reasons.started],
  );
  return row?.activityId ?? undefined;
}
