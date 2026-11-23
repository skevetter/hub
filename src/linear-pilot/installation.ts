import type { QueryHandle } from "../db/runtime/index.js";
import { surfaceUuid } from "../surfaces/store.js";
import type { PilotConnection } from "./binding.js";
import type { LinearPilotConfig } from "./config.js";
import {
  logDelegationFallback,
  logPilotScopeRefusal,
  pilotDeliveryMetadata,
} from "./diagnostics.js";
import {
  precheckLinearPilotScope,
  verifyLinearPilotIntake,
  type LinearPilotInstallation,
} from "./intake.js";

type OwnerInstallation = Record<keyof PilotConnection, string> & {
  ownerUserId: string;
  profileVersion: number;
};

export async function resolveLinearPilotInstallation(
  database: QueryHandle,
  config: LinearPilotConfig,
  oauthClientId: string,
): Promise<(OwnerInstallation & LinearPilotInstallation) | undefined> {
  const {
    rows: [row],
  } = await database.query<OwnerInstallation>(
    `select connection.id as "connectionId", connection.organization_id as "organizationId",
            connection.linear_organization_id as "workspaceId",
            connection.provider_application_id as "applicationId",
            connection.app_user_id as "appUserId", owner.user_id as "ownerUserId",
            profile.version as "profileVersion"
       from linear_connections connection
       join interactive_session_profiles profile
         on profile.organization_id = connection.organization_id and profile.id = $4
       join member owner
         on owner.organization_id = profile.organization_id and owner.user_id = profile.created_by_user_id
      where connection.organization_id = $1 and connection.linear_organization_id = $2
        and connection.provider_application_id = $3 and connection.app_user_id <> $5
        and profile.status = 'active' and profile.access = 'private' and owner.role = 'owner'
        and not exists (
          select 1 from surface_policies policy
           where policy.organization_id = connection.organization_id
             and policy.connection_id = connection.id and policy.enabled
        )`,
    [
      config.hubOrganizationId,
      config.linearOrganizationId,
      oauthClientId,
      config.profileId,
      config.allowedHumanId,
    ],
  );
  return row === undefined ? undefined : { ...row, oauthClientId };
}

export async function qualifyLinearPilotDelivery(
  database: QueryHandle,
  config: LinearPilotConfig,
  oauthClientId: string,
  payload: unknown,
) {
  const refuse = (reason: string) => logPilotScopeRefusal(reason, pilotDeliveryMetadata(payload));
  const precheck = precheckLinearPilotScope({ config, payload });
  if (!precheck.ok) return refuse(precheck.reason);
  const installation = await resolveLinearPilotInstallation(database, config, oauthClientId);
  if (installation === undefined) return refuse("installation_unavailable");
  const verified = verifyLinearPilotIntake({ config, installation, payload });
  if (!verified.ok) return refuse(verified.reason);
  const { event } = verified;
  const { activityId, delegationFallback, nativeSessionId, teamId } = event;
  if (!teamId || !surfaceUuid(nativeSessionId)) return refuse("malformed");
  if (event.kind !== "created" && (activityId === undefined || !surfaceUuid(activityId))) {
    return refuse("malformed");
  }
  const normalizedSessionId = nativeSessionId.toLowerCase();
  logDelegationFallback(normalizedSessionId, delegationFallback);
  return {
    installation,
    event: {
      ...event,
      teamId,
      nativeSessionId: normalizedSessionId,
      ...(activityId === undefined ? {} : { activityId: activityId.toLowerCase() }),
    },
  };
}
