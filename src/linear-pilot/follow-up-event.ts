import { z } from "zod";
import type { PilotConnection } from "./binding.js";
import type { SignedPilotPrompted } from "./follow-up.js";
import type { LinearPilotEvent } from "./intake.js";

const activityId = z.uuid();

/** Use only after verifying the webhook signature, timestamp and pilot intake. */
export function adaptSignedPilotFollowUp(
  event: LinearPilotEvent,
  installation: PilotConnection,
): SignedPilotPrompted | undefined {
  const id = activityId.safeParse(event.activityId);
  if (
    event.kind === "created" ||
    !id.success ||
    !event.teamId ||
    installation.workspaceId !== event.workspaceId ||
    installation.applicationId !== event.applicationId ||
    installation.appUserId !== event.appUserId
  )
    return undefined;

  const conversation = {
    action: "prompted",
    activityId: id.data.toLowerCase(),
    organizationId: installation.organizationId,
    workspaceId: event.workspaceId,
    applicationId: event.applicationId,
    appUserId: event.appUserId,
    connectionId: installation.connectionId,
    nativeSessionId: event.nativeSessionId,
    issueId: event.issueId,
    teamId: event.teamId,
    userId: event.humanId,
  };
  if (event.kind === "prompted") {
    if (event.message === undefined) return undefined;
    return { ...conversation, body: event.message, signal: null };
  }

  if (event.stopCreatedAtMs === undefined) return undefined;
  const createdAt = new Date(event.stopCreatedAtMs);
  if (!Number.isFinite(createdAt.getTime())) return undefined;
  return { ...conversation, createdAt: createdAt.toISOString(), body: null, signal: "stop" };
}
