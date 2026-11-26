import type { SessionParticipantRecord, SessionPrincipal, SessionRecord } from "./types.js";

export function capabilities(
  principal: SessionPrincipal,
  session: Pick<
    SessionRecord,
    "organizationId" | "startedByUserId" | "origin" | "requesterIdentityId"
  >,
  participants: readonly Pick<SessionParticipantRecord, "userId" | "role">[],
) {
  const sameOrganization = principal.organizationId === session.organizationId;
  const manager = sameOrganization && (principal.role === "owner" || principal.role === "admin");
  const participant = sameOrganization
    ? participants.find(({ userId }) => userId === principal.userId)
    : undefined;
  const controller = participant?.role === "controller";
  const starter = participant !== undefined && principal.userId === session.startedByUserId;
  if (session.origin === "linear") {
    const owner = starter && principal.role === "owner" && Boolean(session.requesterIdentityId);
    return {
      view: owner,
      send: owner && controller,
      stop: false,
      close: false,
      replaceAgent: false,
      manageParticipants: false,
    };
  }

  return webCapabilities(manager, participant !== undefined, controller, starter);
}

function webCapabilities(
  manager: boolean,
  participant: boolean,
  controller: boolean,
  starter: boolean,
) {
  return {
    view: manager || participant,
    send: controller,
    stop: manager || starter,
    close: manager || starter,
    replaceAgent: controller,
    manageParticipants: manager || (starter && controller),
  };
}
