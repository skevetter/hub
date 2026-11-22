import type { QueryHandle } from "../db/runtime/index.js";
import type { SessionRecord } from "../interactive-sessions/types.js";
import type { PilotAuthority, PilotBindingStore, PilotNativeOrigin } from "./binding.js";

export interface PilotTurnGrant {
  authority: PilotAuthority;
  origin: PilotNativeOrigin;
  sessionId: string;
  commandId: string;
  bindingGeneration: number;
  profileVersion: number;
}

type PilotTurnSession = Pick<
  SessionRecord,
  "id" | "organizationId" | "origin" | "profileId" | "profileVersion" | "startedByUserId"
>;

/** The grant comes from the locally admitted command, never the Stop envelope. */
export async function authorizeBoundPilotTurn(
  findBinding: PilotBindingStore["find"],
  grant: PilotTurnGrant | undefined,
  session: PilotTurnSession,
  commandId: string,
  expectedBindingGeneration?: number,
): Promise<boolean> {
  if (
    !grant ||
    grant.sessionId !== session.id ||
    grant.commandId !== commandId ||
    grant.authority.organizationId !== session.organizationId ||
    grant.authority.profileId !== session.profileId ||
    grant.authority.ownerUserId !== session.startedByUserId ||
    grant.profileVersion !== session.profileVersion ||
    session.origin !== "linear" ||
    (expectedBindingGeneration !== undefined &&
      expectedBindingGeneration !== grant.bindingGeneration)
  )
    return false;

  // find checks the current installation, profile, owner and mapped identity.
  const result = await findBinding(grant.authority, grant.origin);
  return (
    result.status === "bound" &&
    result.binding.sessionId === session.id &&
    result.binding.generation === grant.bindingGeneration
  );
}

export async function authorizePilotTurnRefresh(
  query: QueryHandle,
  findBinding: PilotBindingStore["find"],
  grant: PilotTurnGrant,
): Promise<boolean> {
  const {
    rows: [session],
  } = await query.query<PilotTurnSession>(
    `select session.id, session.organization_id as "organizationId", session.origin,
            session.profile_id as "profileId", session.profile_version as "profileVersion",
            session.started_by_user_id as "startedByUserId"
       from interactive_sessions session
       join interactive_session_commands command
         on command.organization_id = session.organization_id and command.session_id = session.id
        and command.generation = session.generation
      where session.organization_id = $1 and session.id = $2 and command.id = $3
        and command.kind = 'message' and command.ordinal = 1 and command.author_user_id = $4`,
    [grant.authority.organizationId, grant.sessionId, grant.commandId, grant.authority.ownerUserId],
  );
  return (
    session !== undefined &&
    (await authorizeBoundPilotTurn(
      (authority, origin) => findBinding(authority, origin, query),
      grant,
      session,
      grant.commandId,
    ))
  );
}
