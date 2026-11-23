import { createHash } from "node:crypto";
import { createAssistantTextRedactor } from "../assistant-text/redact.js";
import {
  LinearAgentError,
  type createLinearAgentClient,
  type LinearAgentActivityContent,
} from "../providers/linear/agent.js";
import type { LinearConnectionBinding } from "../providers/linear/client.js";
import { formatRunReply, type FinalReplyAnswer } from "../run-replies/format.js";

export const PILOT_ACK_MS = 10_000;
const TERMINAL_MS = 16_000;
const CLAIM_MS = 60_000;
const MAX_CLAIMS = 2_048;
const ACK_BODY = "Paseo Hub received your request.";
const NO_ANSWER_BODY = "Work finished. No answer was posted.";
const ERROR_BODY = "Paseo Hub could not complete this request.";
const CONTINUATION_ERROR_BODY =
  "Paseo could not continue this conversation. Mention @paseo in a new comment.";
const errorBodies = { terminal: ERROR_BODY, continuation: CONTINUATION_ERROR_BODY };
const DELEGATION_ERROR_BODY =
  "Paseo could not confirm who started this. Mention @paseo in a comment instead.";
const STOP_BODY = "Stopped.";
const STOP_UNCONFIRMED_BODY = "Stop requested; I could not confirm it stopped";
const BUSY_BODY = "Still working on the previous message; reply when I have answered.";
const recognizedCredentials = createAssistantTextRedactor([]);

export interface LinearPilotAcceptedEvent {
  readonly decision: "accepted";
  readonly kind: "created" | "prompted" | "stop";
  readonly binding: Readonly<LinearConnectionBinding>;
  readonly nativeSessionId: string;
  /** For Stop, the exact original interaction the accepted control targeted. */
  readonly interactionId: string;
  /** Time the signed event was first received, carried through acceptance. */
  readonly receivedAt: number;
  readonly actorProviderUserId: string;
  readonly allowedHumanProviderUserId: string;
  readonly publishAnswer: boolean;
}

/** First-attempt requires a newly acquired, exclusive caller claim for this write slot. */
export type LinearPilotActivityAttempt = "first-attempt" | "readback-only";

export type LinearPilotWriteDisposition =
  | { disposition: "confirmed"; activityId: string; via: "mutation" | "readback" }
  | { disposition: "unconfirmed" | "already-claimed" | "capacity"; activityId: string }
  | { disposition: "denied" | "cancelled" | "expired"; activityId?: string };

type PilotClient = Pick<
  ReturnType<typeof createLinearAgentClient>,
  "createActivity" | "isActivityConfirmed"
>;
type ReportActivityFailure = (operation: "createActivity" | "readActivity", error: unknown) => void;

export function tracePilotActivities(
  client: PilotClient,
  report: ReportActivityFailure,
): PilotClient {
  return {
    async createActivity(input, signal) {
      try {
        return await client.createActivity(input, signal);
      } catch (error) {
        report("createActivity", error);
        throw error;
      }
    },
    async isActivityConfirmed(input, signal) {
      const trace = (error: unknown) => report("readActivity", error);
      try {
        return await client.isActivityConfirmed(input, signal, trace);
      } catch (error) {
        trace(error);
        throw error;
      }
    },
  };
}
type BodyContent = Extract<LinearAgentActivityContent, { body: string }>;
type Purpose = "ack" | "terminal" | "stop" | "busy" | "delegationRefused";

interface ActivityOptions {
  /** Return L1 bound to this event's exact installation and current operation authorization. */
  clientFor: (event: LinearPilotAcceptedEvent) => PilotClient;
  now?: () => number;
}

function activityTiming(purpose: Purpose, receivedAt: number, started: number) {
  const ack = purpose === "ack";
  const initial = ack || purpose === "delegationRefused";
  return { ack, initial, deadline: initial ? receivedAt + PILOT_ACK_MS : started + TERMINAL_MS };
}

function expiredInitialWrite(deadline: number, receivedAt: number, started: number) {
  return !Number.isFinite(deadline) || receivedAt > started || started >= deadline;
}

type WriteDelegationRefusal = (
  event: LinearPilotAcceptedEvent,
) => Promise<LinearPilotWriteDisposition>;

function delegationRefusalWriter(write: WriteDelegationRefusal) {
  return function refuseDelegation(event: LinearPilotAcceptedEvent) {
    if (event.kind !== "created" || event.interactionId !== event.nativeSessionId)
      return Promise.resolve({ disposition: "denied" } as const);
    return write(event);
  };
}

function claim(claims: Map<string, number>, slot: string, started: number) {
  for (const [key, expires] of claims) {
    if (expires > started) break;
    claims.delete(key);
  }
  if (claims.has(slot)) return "already-claimed" as const;
  if (claims.size >= MAX_CLAIMS) return "capacity" as const;
  claims.set(slot, started + CLAIM_MS);
  return undefined;
}

export function createLinearPilotActivities({ clientFor, now = Date.now }: ActivityOptions) {
  const claims = new Map<string, number>();
  async function write(
    event: LinearPilotAcceptedEvent,
    attempt: LinearPilotActivityAttempt,
    purpose: Purpose,
    kind: BodyContent["type"],
    prepareBody: () => string | undefined,
    signal?: AbortSignal,
  ): Promise<LinearPilotWriteDisposition> {
    if (
      event.decision !== "accepted" ||
      !validId(event.nativeSessionId) ||
      !validId(event.interactionId)
    ) {
      return { disposition: "denied" };
    }
    if (kind === "error" && !isAllowedHuman(event)) {
      return { disposition: "denied" };
    }
    if (signal?.aborted) return { disposition: "cancelled" };

    const started = now();
    const { ack, initial, deadline } = activityTiming(purpose, event.receivedAt, started);
    if (initial && expiredInitialWrite(deadline, event.receivedAt, started))
      return { disposition: "expired" };
    const { nativeSessionId: sessionId, interactionId } = event;
    const providerSignal = purpose === "busy" ? { signal: "continue" as const } : undefined;
    const activityId = stableActivityId(sessionId, purpose, interactionId);
    if (attempt === "first-attempt") {
      // A prompt gets one terminal output, including when it arrives during another turn.
      const slot = JSON.stringify([sessionId, ack ? null : interactionId]);
      const refused = claim(claims, slot, started);
      if (refused) return { disposition: refused, activityId };
    } else if (attempt !== "readback-only") {
      return { disposition: "denied" };
    }

    const timeout = new AbortController();
    const callSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const interrupted = () => {
      if (timeout.signal.aborted || now() >= deadline) {
        return { disposition: initial ? "expired" : "unconfirmed", activityId } as const;
      }
      if (callSignal.aborted) return { disposition: "cancelled", activityId } as const;
      return undefined;
    };

    async function deliver(): Promise<LinearPilotWriteDisposition> {
      try {
        const body = attempt === "first-attempt" ? prepareBody() : undefined;
        if (attempt === "first-attempt" && body === undefined) {
          return { disposition: "denied", activityId };
        }
        const beforeClient = interrupted();
        if (beforeClient) return beforeClient;
        const client = clientFor(event);
        if (body !== undefined) {
          try {
            const writtenId = await client.createActivity(
              {
                sessionId,
                activityId,
                content: { type: kind, body },
                ...(ack ? { ephemeral: false } : {}),
                ...providerSignal,
              },
              callSignal,
            );
            const stopped = interrupted();
            if (stopped) return stopped;
            if (writtenId === activityId)
              return { disposition: "confirmed", activityId, via: "mutation" };
          } catch (error) {
            const stopped = interrupted();
            if (stopped) return stopped;
            if (isDenied(error)) return { disposition: "denied", activityId };
          }
        }
        const beforeReadback = interrupted();
        if (beforeReadback) return beforeReadback;
        const found = await client.isActivityConfirmed(
          { sessionId, activityId, kind, ...providerSignal },
          callSignal,
        );
        const stopped = interrupted();
        if (stopped) return stopped;
        if (found) return { disposition: "confirmed", activityId, via: "readback" };
      } catch (error) {
        const stopped = interrupted();
        if (stopped) return stopped;
        if (isDenied(error)) return { disposition: "denied", activityId };
      }
      return { disposition: "unconfirmed", activityId };
    }

    const completion = Promise.withResolvers<LinearPilotWriteDisposition>();
    const onAbort = () =>
      completion.resolve(interrupted() ?? { disposition: "cancelled", activityId });
    callSignal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), Math.max(0, deadline - now()));
    try {
      return await Promise.race([deliver(), completion.promise]);
    } finally {
      clearTimeout(timer);
      callSignal.removeEventListener("abort", onAbort);
    }
  }
  return {
    acknowledge(
      event: LinearPilotAcceptedEvent,
      attempt: LinearPilotActivityAttempt,
      signal?: AbortSignal,
    ): Promise<LinearPilotWriteDisposition> {
      if (event.kind !== "created") return Promise.resolve({ disposition: "denied" });
      return write(event, attempt, "ack", "thought", () => ACK_BODY, signal);
    },
    respond(
      event: LinearPilotAcceptedEvent,
      attempt: LinearPilotActivityAttempt,
      answer: FinalReplyAnswer | undefined,
      secrets: readonly string[],
      signal?: AbortSignal,
    ): Promise<LinearPilotWriteDisposition> {
      if (event.kind !== "created" && event.kind !== "prompted")
        return Promise.resolve({ disposition: "denied" });
      return write(
        event,
        attempt,
        "terminal",
        "response",
        () => safeReply(event.publishAnswer ? answer : undefined, secrets),
        signal,
      );
    },
    error(
      event: LinearPilotAcceptedEvent,
      attempt: LinearPilotActivityAttempt,
      signal?: AbortSignal,
      failure: keyof typeof errorBodies = "terminal",
    ): Promise<LinearPilotWriteDisposition> {
      if (event.kind === "stop") return Promise.resolve({ disposition: "denied" });
      return write(event, attempt, "terminal", "error", () => errorBodies[failure], signal);
    },
    refuseDelegation: delegationRefusalWriter((event) =>
      write(event, "first-attempt", "delegationRefused", "error", () => DELEGATION_ERROR_BODY),
    ),
    busy(
      event: LinearPilotAcceptedEvent,
      attempt: LinearPilotActivityAttempt,
      signal?: AbortSignal,
    ): Promise<LinearPilotWriteDisposition> {
      if (event.kind !== "prompted" || !isAllowedHuman(event))
        return Promise.resolve({ disposition: "denied" });
      return write(event, attempt, "busy", "response", () => BUSY_BODY, signal);
    },
    stop(
      event: LinearPilotAcceptedEvent,
      attempt: LinearPilotActivityAttempt,
      outcome: "confirmed" | "unconfirmed",
      signal?: AbortSignal,
    ): Promise<LinearPilotWriteDisposition> {
      if (event.kind !== "stop" || (outcome !== "confirmed" && outcome !== "unconfirmed"))
        return Promise.resolve({ disposition: "denied" });
      return outcome === "confirmed"
        ? write(event, attempt, "stop", "response", () => STOP_BODY, signal)
        : write(event, attempt, "stop", "error", () => STOP_UNCONFIRMED_BODY, signal);
    },
  };
}

function isAllowedHuman(event: LinearPilotAcceptedEvent): boolean {
  return (
    validId(event.allowedHumanProviderUserId) &&
    event.actorProviderUserId === event.allowedHumanProviderUserId
  );
}

function validId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

export function pilotActivityIds(nativeSessionId: string, promptActivityId: string) {
  return {
    busy: stableActivityId(nativeSessionId, "busy", promptActivityId),
    response: stableActivityId(nativeSessionId, "terminal", promptActivityId),
    stop: stableActivityId(nativeSessionId, "stop", promptActivityId),
  };
}

function stableActivityId(sessionId: string, purpose: Purpose, interactionId: string): string {
  const identity = JSON.stringify([sessionId, purpose, purpose === "ack" ? null : interactionId]);
  const name = `https://paseo.sh/id/linear-pilot/v4/${encodeURIComponent(identity)}`;
  const bytes = createHash("sha256").update(name).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeReply(answer: FinalReplyAnswer | undefined, secrets: readonly string[]) {
  const includesKnown = (body: string) =>
    secrets.some((secret) => secret !== "" && body.includes(secret));
  if (answer !== undefined) {
    try {
      const text = formatRunReply(answer, secrets);
      if (
        text.trim() !== "" &&
        !includesKnown(text) &&
        recognizedCredentials.redact([text], false)[0] === text
      ) {
        return text;
      }
    } catch {
      // Rendering must not expose the answer or the failure detail.
    }
  }
  return includesKnown(NO_ANSWER_BODY) ? undefined : NO_ANSWER_BODY;
}

function isDenied(error: unknown): boolean {
  if (!(error instanceof LinearAgentError)) return false;
  switch (error.code) {
    case "invalid_input":
    case "policy_required":
    case "connection_not_owned":
    case "connection_unavailable":
    case "connection_changed":
    case "scope_missing":
    case "reauthorize":
    case "credential_in_payload":
      return true;
    case "request_failed":
      return error.status === 401 || error.status === 403 || error.status === 404;
    default:
      return false;
  }
}
