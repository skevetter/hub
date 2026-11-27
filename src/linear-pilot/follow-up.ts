import { validMessage } from "../interactive-sessions/store.js";
import { z } from "zod";
import { DaemonResponseLostError } from "../daemons/protocol.js";
import { DatabaseUnavailableError } from "../db/errors.js";
import type { RefusalCode } from "../interactive-sessions/types.js";
import {
  LinearAgentError,
  type LinearAgentErrorDetails,
  type LinearAgentOperation,
} from "../providers/linear/agent.js";
import { surfaceRevision, type BindingKey } from "../surfaces/store.js";
import type { PilotRefusal } from "./binding.js";
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
interface FollowUpResult {
  outcome: FollowUpOutcome;
  reason: FollowUpReason;
}
type FollowUpReason =
  | "invalid_event"
  | "binding_unavailable"
  | "receipt_exists"
  | "claim_unconfirmed"
  | "stop_settled"
  | "stop_not_applicable"
  | "stop_duplicate"
  | "stop_unconfirmed"
  | "busy_replied"
  | "busy_reply_unconfirmed"
  | "preceding_unavailable"
  | "prompt_unverified"
  | "stop_unverified"
  | "history_unusable"
  | "reservation_unconfirmed"
  | "dispatch_unconfirmed"
  | "exception"
  | "started";
type FollowUpOperation = "prompted" | "stop";

export interface PilotFailure extends LinearAgentErrorDetails {
  sessionId: string;
  failureCode:
    | LinearAgentError["code"]
    | RefusalCode
    | PilotRefusal
    | "retirement_refused"
    | "unconfirmed"
    | "DaemonResponseLostError"
    | "DatabaseUnavailableError"
    | "TypeError"
    | "RangeError"
    | "SyntaxError"
    | "Error"
    | "unknown_error";
  httpStatus?: number;
  operation?: LinearAgentOperation["kind"] | "created" | "prompted" | "stop";
}

export function pilotExceptionFields(
  error: unknown,
): Pick<PilotFailure, "failureCode" | "httpStatus"> & LinearAgentErrorDetails {
  const { linearErrorType, linearErrorKinds } =
    (error instanceof LinearAgentError ? error.details : undefined) ?? {};
  return {
    failureCode: pilotExceptionCode(error),
    ...(error instanceof LinearAgentError && error.status !== undefined
      ? { httpStatus: error.status }
      : {}),
    ...(linearErrorType === undefined ? {} : { linearErrorType }),
    ...(linearErrorKinds === undefined ? {} : { linearErrorKinds }),
  };
}

function pilotExceptionCode(error: unknown): PilotFailure["failureCode"] {
  if (error instanceof LinearAgentError) return error.code;
  if (error instanceof DaemonResponseLostError) return "DaemonResponseLostError";
  if (error instanceof DatabaseUnavailableError) return "DatabaseUnavailableError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "unknown_error";
}

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
  appendRefusal(input: Admission): Promise<void>;
  confirmStop(scope: PilotConversation, activityId: string): Promise<boolean>;
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
  reportFailure?(failure: PilotFailure): void;
  reportOutcome?(
    result: FollowUpResult & { operation: FollowUpOperation; nativeSessionId: string },
  ): void;
}

export function createPilotFollowUp(options: PilotFollowUpOptions) {
  return async (scope: PilotConversation, event: SignedPilotPrompted): Promise<FollowUpOutcome> => {
    const operation = event.signal === "stop" ? "stop" : "prompted";
    const result = await runFollowUp(options, scope, event, operation);
    if (result.outcome !== "started") {
      options.reportOutcome?.({ ...result, operation, nativeSessionId: scope.nativeSessionId });
    }
    return result.outcome;
  };
}

function validFollowUp(scope: PilotConversation, event: SignedPilotPrompted) {
  const { body, signal } = event;
  return (
    event.action === "prompted" &&
    scope.ownerId !== scope.appUserId &&
    event.userId === scope.ownerId &&
    sameConversation(scope, event) &&
    activityUuid.safeParse(event.activityId.toLowerCase()).success &&
    (signal === "stop" || (signal === null && nonemptyPrompt(body)))
  );
}

function nonemptyPrompt(body: string | null) {
  return body !== null && validMessage(body) && body.trim() !== "";
}

function validTurn(scope: PilotConversation, turn: PilotTurn | undefined): turn is PilotTurn {
  return (
    turn !== undefined &&
    sameConversation(scope, turn) &&
    turn.ownerId === scope.ownerId &&
    surfaceRevision(turn.generation) &&
    surfaceRevision(turn.policyRevision) &&
    turn.state !== "fenced"
  );
}

function followUpResult(outcome: FollowUpOutcome, reason: FollowUpReason): FollowUpResult {
  return { outcome, reason };
}

function reportFollowUpException(
  options: PilotFollowUpOptions,
  scope: PilotConversation,
  operation: FollowUpOperation,
  error: unknown,
) {
  try {
    options.reportFailure?.({
      sessionId: scope.nativeSessionId,
      operation,
      ...pilotExceptionFields(error),
    });
  } catch {
    // Reporting must not turn an uncertain dispatch into a pre-dispatch refusal.
  }
}

async function runFollowUp(
  options: PilotFollowUpOptions,
  scope: PilotConversation,
  event: SignedPilotPrompted,
  operation: FollowUpOperation,
) {
  if (!validFollowUp(scope, event)) return followUpResult("ignored", "invalid_event");
  try {
    return await options.withSession(scope, async () => {
      const turn = await options.current(scope);
      if (!validTurn(scope, turn)) return followUpResult("ignored", "binding_unavailable");
      const activityId = event.activityId.toLowerCase();
      const ids = options.activityIds(scope.nativeSessionId, activityId);
      const admission = { scope, turn, activityId, ids };
      const claim = await options.claim(admission);
      if (claim === "duplicate") return followUpResult(claim, "receipt_exists");
      if (claim === "unconfirmed") return followUpResult(claim, "claim_unconfirmed");
      if (operation === "stop") {
        const outcome = await stopFollowUp(options, admission, event.createdAt);
        return followUpResult(outcome, stopReasons[outcome]);
      }
      return runClaimedPrompt(options, admission, event.body);
    });
  } catch (error) {
    reportFollowUpException(options, scope, operation, error);
    return followUpResult("unconfirmed", "exception");
  }
}

const stopReasons = {
  stopped: "stop_settled",
  ignored: "stop_not_applicable",
  duplicate: "stop_duplicate",
  unconfirmed: "stop_unconfirmed",
} as const;

async function claimedPromptResult(
  options: PilotFollowUpOptions,
  admission: Admission,
  body: string | null,
) {
  try {
    if (admission.turn.state !== "busy") return await startFreshFollowUp(options, admission, body);
    return (await options.appendBusy(admission))
      ? followUpResult("busy", "busy_replied")
      : followUpResult("unconfirmed", "busy_reply_unconfirmed");
  } catch (error) {
    reportFollowUpException(options, admission.scope, "prompted", error);
    return followUpResult("unconfirmed", "exception");
  }
}

async function runClaimedPrompt(
  options: PilotFollowUpOptions,
  admission: Admission,
  body: string | null,
) {
  const result = await claimedPromptResult(options, admission, body);
  if (
    admission.turn.state === "busy" ||
    result.outcome === "started" ||
    result.reason === "dispatch_unconfirmed"
  )
    return result;
  try {
    await options.appendRefusal(admission);
  } catch (error) {
    reportFollowUpException(options, admission.scope, "prompted", error);
  }
  return result;
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
): Promise<FollowUpResult> {
  const { scope, turn, activityId } = admission;
  if (turn.state !== "complete" || !turn.preceding || body === null)
    return followUpResult("ignored", "preceding_unavailable");
  const message = { activityId, body };
  const verified = verifyPilotPrompt(scope, message, await options.readPrompt(scope, message));
  if (!verified) return followUpResult("ignored", "prompt_unverified");
  const prior = options.activityIds(scope.nativeSessionId, turn.preceding.activityId);
  const proofIsStop = turn.preceding.kind === "stop";
  // A queued prompt can predate the Stop response that released it.
  if (proofIsStop && !(await options.confirmStop(scope, prior.stop)))
    return followUpResult("ignored", "stop_unverified");
  const page = await options.readHistory(scope, verified, PILOT_HISTORY_PAGE_SIZE);
  const prompt = composePilotPrompt({
    scope,
    message,
    current: verified,
    page,
    context: {
      ...(proofIsStop ? { confirmedStopId: prior.stop } : { confirmedResponseId: prior.response }),
      secrets: await options.secrets(scope),
      idsFor: (id) => options.activityIds(scope.nativeSessionId, id),
    },
  });
  if (prompt === undefined) return followUpResult("ignored", "history_unusable");
  return dispatchFresh(options, admission, prompt);
}

async function dispatchFresh(options: PilotFollowUpOptions, admission: Admission, prompt: string) {
  const fresh = await options.reserve(admission);
  if (
    !fresh ||
    !fresh.hubSessionId ||
    fresh.hubSessionId === admission.turn.hubSessionId ||
    fresh.generation !== admission.turn.generation + 1
  )
    return followUpResult("unconfirmed", "reservation_unconfirmed");
  try {
    const outcome = await fresh.dispatchInitial(prompt);
    return followUpResult(outcome, outcome === "started" ? "started" : "dispatch_unconfirmed");
  } catch (error) {
    reportFollowUpException(options, admission.scope, "prompted", error);
    return followUpResult("unconfirmed", "dispatch_unconfirmed");
  }
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
