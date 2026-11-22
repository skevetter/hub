import { validMessage } from "../interactive-sessions/store.js";
import { z } from "zod";
import { surfaceRevision, type BindingKey } from "../surfaces/store.js";
import {
  composePilotPrompt,
  PILOT_HISTORY_PAGE_SIZE,
  verifyPilotPrompt,
  type PilotActivityIds,
  type VerifiedPilotPrompt,
} from "./history.js";

const activityUuid = z.uuid();
const activityTime = z.iso.datetime({ offset: true });

export interface PilotConversation extends BindingKey {
  connectionId: string;
  issueId: string;
  teamId: string;
  ownerId: string;
}

/** Only the signed, normalized webhook adapter may supply this event. */
export interface SignedPilotPrompted extends Omit<PilotConversation, "ownerId"> {
  action: string;
  activityId: string;
  userId: string;
  /** Required for Stop: signed activity order, never the webhook delivery time. */
  createdAt?: string;
  body: string | null;
  signal: string | null;
}

export interface PilotTurn extends PilotConversation {
  generation: number;
  policyRevision: number;
  hubSessionId: string;
  profileId: string;
  profileVersion: number;
  /** Complete requires exact readback of this answer or confirmed Stop response. */
  state: "busy" | "complete" | "fenced";
  preceding: { activityId: string; kind: "answer" | "stop" } | null;
  agentId: string | null;
  daemonTurnId: string | null;
  /** Exact daemon turn's initial send time; required before Stop. */
  startedAt?: string;
}

interface Admission {
  scope: PilotConversation;
  turn: PilotTurn;
  activityId: string;
  ids: PilotActivityIds;
}

interface FreshTurn {
  hubSessionId: string;
  generation: number;
  /** A one-shot permit, invalid after a crash. Never enqueue the supplied body. */
  dispatchInitial(prompt: string): Promise<"started" | "unconfirmed">;
}

type StopOutcome = "stopped" | "duplicate" | "ignored" | "unconfirmed";
type FollowUpOutcome = StopOutcome | "started" | "busy";

export interface PilotFollowUpOptions {
  /** Serialize this native session with competing admissions, binding changes and Stop. */
  withSession<T>(scope: PilotConversation, run: () => Promise<T>): Promise<T>;
  /** Use the same IDs as the existing canonical activity writer. */
  activityIds(nativeSessionId: string, activityId: string): PilotActivityIds;
  /** Revalidate the installation, owner and private profile. Return only the current binding. */
  current(scope: PilotConversation): Promise<PilotTurn | undefined>;
  /** Claim durable activity metadata once, across binding generations and restarts. */
  claim(input: Admission): Promise<"claimed" | "duplicate" | "unconfirmed">;
  /** Use the new claim and exact current authority to write the canonical busy response once. */
  appendBusy(input: Admission): Promise<boolean>;
  readPrompt(
    scope: PilotConversation,
    expected: { activityId: string; body: string },
  ): Promise<unknown>;
  /** Return one GraphQL session projection, newest first, strictly preceding the verified prompt. */
  readHistory(
    scope: PilotConversation,
    prompt: VerifiedPilotPrompt,
    limit: typeof PILOT_HISTORY_PAGE_SIZE,
  ): Promise<unknown>;
  secrets(scope: PilotConversation): Promise<readonly string[]>;
  /** CAS the binding, retire the prior turn and reserve an unlaunched fresh turn using metadata only. */
  reserve(input: Admission): Promise<FreshTurn | undefined>;
  /** Recheck and interrupt the exact active agent and daemon turn once. Fence on unknown result. */
  stopCurrent(input: Admission & { requestedAt: string }): Promise<StopOutcome>;
}

export function createPilotFollowUp(options: PilotFollowUpOptions) {
  return async (scope: PilotConversation, event: SignedPilotPrompted): Promise<FollowUpOutcome> => {
    const { body } = event;
    const activityId = event.activityId.toLowerCase();
    const isStop = event.signal === "stop";
    if (
      event.action !== "prompted" ||
      (!isStop && event.signal !== null) ||
      scope.ownerId === scope.appUserId ||
      event.userId !== scope.ownerId ||
      !sameConversation(scope, event) ||
      !activityUuid.safeParse(activityId).success ||
      (!isStop && (body === null || !validMessage(body) || body.trim() === ""))
    )
      return "ignored";

    try {
      return await options.withSession(scope, async () => {
        const turn = await options.current(scope);
        if (
          !turn ||
          !sameConversation(scope, turn) ||
          turn.ownerId !== scope.ownerId ||
          !surfaceRevision(turn.generation) ||
          !surfaceRevision(turn.policyRevision) ||
          turn.state === "fenced"
        )
          return "ignored";

        const ids = options.activityIds(scope.nativeSessionId, activityId);
        const admission = { scope, turn, activityId, ids };
        const claim = await options.claim(admission);
        if (claim !== "claimed") return claim;
        if (isStop) return stopFollowUp(options, admission, event.createdAt);
        if (turn.state === "busy")
          return (await options.appendBusy(admission)) ? "busy" : "unconfirmed";
        return startFreshFollowUp(options, admission, body);
      });
    } catch {
      // A failed or uncertain attempt cannot be retried with its original claim.
      return "unconfirmed";
    }
  };
}

async function stopFollowUp(
  options: PilotFollowUpOptions,
  admission: Admission,
  createdAt: string | undefined,
): Promise<StopOutcome> {
  const { turn } = admission;
  const requestedAt = activityTime.safeParse(createdAt);
  const startedAt = activityTime.safeParse(turn.startedAt);
  if (
    turn.state !== "busy" ||
    !turn.agentId ||
    !turn.daemonTurnId ||
    !requestedAt.success ||
    !startedAt.success ||
    Date.parse(requestedAt.data) <= Date.parse(startedAt.data)
  )
    return "ignored";
  return options.stopCurrent({ ...admission, requestedAt: requestedAt.data });
}

async function startFreshFollowUp(
  options: PilotFollowUpOptions,
  admission: Admission,
  body: string | null,
): Promise<FollowUpOutcome> {
  const { scope, turn, activityId } = admission;
  if (turn.state !== "complete" || !turn.preceding || body === null) return "ignored";
  const message = { activityId, body };
  const verified = verifyPilotPrompt(scope, message, await options.readPrompt(scope, message));
  if (!verified) return "ignored";
  const page = await options.readHistory(scope, verified, PILOT_HISTORY_PAGE_SIZE);
  const prior = options.activityIds(scope.nativeSessionId, turn.preceding.activityId);
  const proofIsStop = turn.preceding.kind === "stop";
  const prompt = composePilotPrompt(scope, message, verified, page, {
    confirmedResponseId: proofIsStop ? prior.stop : prior.response,
    ...(proofIsStop ? { omitResponseId: prior.stop } : {}),
    secrets: await options.secrets(scope),
    idsFor: (id) => options.activityIds(scope.nativeSessionId, id),
  });
  if (prompt === undefined) return "ignored";

  const fresh = await options.reserve(admission);
  if (
    !fresh ||
    !fresh.hubSessionId ||
    fresh.hubSessionId === turn.hubSessionId ||
    fresh.generation !== turn.generation + 1
  )
    return "unconfirmed";
  return fresh.dispatchInitial(prompt);
}

function sameConversation(
  expected: PilotConversation,
  candidate: Omit<PilotConversation, "ownerId">,
) {
  return (
    expected.organizationId === candidate.organizationId &&
    expected.workspaceId === candidate.workspaceId &&
    expected.applicationId === candidate.applicationId &&
    expected.appUserId === candidate.appUserId &&
    expected.nativeSessionId === candidate.nativeSessionId &&
    expected.connectionId === candidate.connectionId &&
    expected.issueId === candidate.issueId &&
    expected.teamId === candidate.teamId
  );
}
