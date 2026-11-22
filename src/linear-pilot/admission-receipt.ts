import { createHash } from "node:crypto";
import type { QueryHandle } from "../db/runtime/index.js";

type LinearPilotReceipt = {
  organizationId: string;
  workspaceId: string;
  applicationId: string;
  appUserId: string;
  humanId: string;
  connectionId: string;
  ownerUserId: string;
  profileId: string;
  profileVersion: number;
  nativeSessionId: string;
  receivedAt: Date;
} & ({ kind: "created" } | { kind: "prompted" | "stop"; activityId: string });

export async function recordLinearPilotAdmission(
  database: QueryHandle,
  receipt: LinearPilotReceipt,
): Promise<boolean> {
  const interaction = receipt.kind === "created" ? ["created"] : ["activity", receipt.activityId];
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        receipt.workspaceId,
        receipt.applicationId,
        receipt.appUserId,
        receipt.nativeSessionId,
        interaction,
      ]),
    )
    .digest("hex");
  const result = await database.query(
    `insert into provider_event_receipts
       (organization_id, provider, connection_id, delivery_id, provider_application_id, source,
        payload, received_at, dropped_reason)
     select connection.organization_id, 'linear', connection.id, $1,
            connection.provider_application_id, 'linear.agent_session', $2::jsonb, $3,
            'linear_pilot_admitted'
     from linear_connections connection
     join interactive_session_profiles profile on profile.organization_id = connection.organization_id
     join member owner on owner.organization_id = profile.organization_id
                      and owner.user_id = profile.created_by_user_id and owner.role = 'owner'
     where connection.organization_id = $4 and connection.linear_organization_id = $5
       and connection.id = $6 and connection.provider_application_id = $7
       and connection.app_user_id = $8 and connection.app_user_id <> $9
       and profile.id = $10 and profile.version = $11 and profile.status = 'active'
       and profile.access = 'private' and owner.user_id = $12
     on conflict do nothing`,
    [
      `linear-pilot:${digest}`,
      JSON.stringify({ type: "agent_session", action: receipt.kind }),
      receipt.receivedAt,
      receipt.organizationId,
      receipt.workspaceId,
      receipt.connectionId,
      receipt.applicationId,
      receipt.appUserId,
      receipt.humanId,
      receipt.profileId,
      receipt.profileVersion,
      receipt.ownerUserId,
    ],
  );
  return result.rowCount === 1;
}
