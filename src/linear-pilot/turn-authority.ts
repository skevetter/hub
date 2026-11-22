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
