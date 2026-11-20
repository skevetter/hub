import type { SessionParticipantRecord, SessionPrincipal, SessionRecord } from "./types.js";

export function capabilities(
  principal: SessionPrincipal,
  session: Pick<SessionRecord, "organizationId" | "startedByUserId">,
  participants: readonly Pick<SessionParticipantRecord, "userId" | "role">[],
) {
  const sameOrganization = principal.organizationId === session.organizationId;
  const manager = sameOrganization && (principal.role === "owner" || principal.role === "admin");
  const participant = sameOrganization
    ? participants.find(({ userId }) => userId === principal.userId)
    : undefined;
  const controller = participant?.role === "controller";
  const starter = participant !== undefined && principal.userId === session.startedByUserId;

  return {
    view: manager || participant !== undefined,
    send: controller,
    stop: manager || starter,
    close: manager || starter,
    replaceAgent: controller,
    manageParticipants: manager || (starter && controller),
  };
}
