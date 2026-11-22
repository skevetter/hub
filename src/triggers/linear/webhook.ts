import { UNSUPPORTED_LINEAR_RATE_LIMITED } from "../../db/unsupported-linear.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import { eventIssueId, eventProjectId, normalizeLinearEvent } from "./events.js";
import { isPaseoAppAuthor } from "./match.js";
import { hasLinearRunReplyMarker } from "../../run-replies/marker.js";
import type { LinearIssueDetails } from "../../providers/linear/client.js";

const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_TIMESTAMP_SKEW_MS = 60_000;

export interface LinearWebhookSourceOptions {
  signingSecret: string;
  now?: () => number;
  canHydrateIssue?(linearOrganizationId: string): Promise<boolean>;
  findAppUserId?(linearOrganizationId: string): Promise<string | undefined>;
  findMarkedReceipt?(
    linearOrganizationId: string,
    deliveryId: string,
    signatureHash: string,
  ): Promise<boolean>;
  resolveIssue?(input: {
    linearOrganizationId: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined>;
  accept(input: {
    linearOrganizationId: string;
    projectId?: string;
    deliveryId: string;
    signatureHash: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export interface LinearWebhookEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

interface VerifiedLinearRequest {
  deliveryId: string;
  eventName: string | null;
  payload: unknown;
  signatureHash: string;
  receivedAt: Date;
}

export function createLinearWebhookSource(
  options: LinearWebhookSourceOptions,
): LinearWebhookEndpoint {
  const handlers = new Set<TriggerHandler>();
  return {
    async handle(request) {
      const verified = await verifyLinearRequest(request, options);
      if (verified instanceof Response) return verified;
      return handoffLinearEvent(verified, handlers, options);
    },
    async start(handler) {
      handlers.add(handler);
    },
    async stop() {
      handlers.clear();
    },
  };
}

async function verifyLinearRequest(
  request: Request,
  options: Pick<LinearWebhookSourceOptions, "signingSecret" | "now">,
): Promise<VerifiedLinearRequest | Response> {
  const deliveryId = request.headers.get("linear-delivery");
  const signature = request.headers.get("linear-signature");
  if (deliveryId === null || signature === null) {
    logger.warn("rejecting Linear event because signature evidence is missing");
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;
  const normalizedSignature = canonicalLinearSignature(signature);
  if (
    normalizedSignature === undefined ||
    !verifyLinearSignature(options.signingSecret, body, normalizedSignature)
  ) {
    logger.warn("rejecting Linear event because signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    logger.warn("rejecting Linear event because payload is invalid JSON");
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const receivedAt = new Date(options.now?.() ?? Date.now());
  if (!verifyLinearWebhookTimestamp(payload, receivedAt.getTime())) {
    logger.warn("rejecting Linear event because its signed webhook timestamp is stale or invalid");
    return new Response("Unauthorized", { status: 401 });
  }
  return {
    deliveryId,
    eventName: request.headers.get("linear-event"),
    payload,
    signatureHash: createHash("sha256").update(normalizedSignature).digest("hex"),
    receivedAt,
  };
}

async function handoffLinearEvent(
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
): Promise<Response> {
  let linearOrganizationId: string | undefined;
  try {
    let event = normalizeDelivery(verified);
    if (event === undefined) {
      const envelope = isRecord(verified.payload) ? verified.payload : {};
      const organizationId = envelope["organizationId"];
      if (
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        organizationId.length > 255 ||
        organizationId.includes("\u0000")
      )
        return new Response("OK", { status: 200 });
      linearOrganizationId = organizationId;
      return await acceptUnsupportedLinearEvent(verified, organizationId, options);
    }
    linearOrganizationId = event.organizationId;
    if (
      event.type === "comment" &&
      (hasLinearRunReplyMarker(event.comment.body, event.comment.id) ||
        isPaseoAppAuthor(event, {
          appUserId: await options.findAppUserId?.(linearOrganizationId),
        }))
    ) {
      return new Response("OK", { status: 200 });
    }
    if (await findMarkedReceipt(options, verified, linearOrganizationId))
      return new Response("OK", { status: 200 });
    if (eventProjectId(event) === undefined && options.resolveIssue !== undefined) {
      const source = linearEventSource(event);
      if (
        options.canHydrateIssue !== undefined &&
        !(await options.canHydrateIssue(event.organizationId))
      ) {
        return await acceptAndDispatchLinearEvent(event, source, verified, handlers, options, true);
      }
      const issue = await options.resolveIssue({
        linearOrganizationId: event.organizationId,
        issueId: eventIssueId(event),
      });
      event = normalizeDelivery(verified, issue);
    }
    if (event === undefined) {
      return await acceptUnsupportedLinearEvent(verified, linearOrganizationId, options);
    }
    return await acceptAndDispatchLinearEvent(
      event,
      linearEventSource(event),
      verified,
      handlers,
      options,
    );
  } catch (error) {
    if (
      linearOrganizationId !== undefined &&
      (await findMarkedReceipt(options, verified, linearOrganizationId).catch(() => false))
    )
      return new Response("OK", { status: 200 });
    logger.error({ err: error, deliveryId: verified.deliveryId }, "Linear event handoff failed");
    return Response.json({ error: "event_handoff_unavailable" }, { status: 503 });
  }
}

function normalizeDelivery(verified: VerifiedLinearRequest, issue?: LinearIssueDetails) {
  const envelope = isRecord(verified.payload) ? verified.payload : {};
  if (
    eventIdentifier(envelope["type"]) === "agent_session_event" ||
    eventIdentifier(verified.eventName) === "agent_session_event"
  )
    return undefined;
  try {
    return normalizeLinearEvent(verified.payload, verified.eventName, issue);
  } catch (error) {
    if (error instanceof ZodError) return undefined;
    throw error;
  }
}

function eventIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/u.test(value)) return undefined;
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

async function acceptUnsupportedLinearEvent(
  verified: VerifiedLinearRequest,
  linearOrganizationId: string,
  options: LinearWebhookSourceOptions,
): Promise<Response> {
  if (await findMarkedReceipt(options, verified, linearOrganizationId))
    return new Response("OK", { status: 200 });
  const envelope = isRecord(verified.payload) ? verified.payload : {};
  const kind = eventIdentifier(envelope["type"]);
  const type =
    kind === "agent_session_event" || eventIdentifier(verified.eventName) === "agent_session_event"
      ? "agent_session"
      : (kind ?? "unknown");
  const action = eventIdentifier(envelope["action"]);
  const source = `linear.${type}`;
  const acceptance = await options.accept({
    linearOrganizationId,
    deliveryId: verified.deliveryId,
    signatureHash: verified.signatureHash,
    source,
    payload: action === undefined ? { type } : { type, action },
    receivedAt: verified.receivedAt,
    dropReason: "unsupported_event",
  });
  if (acceptance.status === "dropped" && acceptance.reason === UNSUPPORTED_LINEAR_RATE_LIMITED) {
    logger.debug("unsupported Linear receipt write rate exceeded");
  }
  return new Response("OK", { status: 200 });
}

async function findMarkedReceipt(
  options: LinearWebhookSourceOptions,
  verified: VerifiedLinearRequest,
  linearOrganizationId: string,
): Promise<boolean> {
  return (
    (await options.findMarkedReceipt?.(
      linearOrganizationId,
      verified.deliveryId,
      verified.signatureHash,
    )) ?? false
  );
}

async function acceptAndDispatchLinearEvent(
  event: NonNullable<ReturnType<typeof normalizeLinearEvent>>,
  source: "linear.issue" | "linear.comment",
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
  preserveBindingDrop = false,
): Promise<Response> {
  const projectId = eventProjectId(event);
  const acceptance = await options.accept({
    linearOrganizationId: event.organizationId,
    ...(projectId === undefined ? {} : { projectId }),
    deliveryId: verified.deliveryId,
    signatureHash: verified.signatureHash,
    source,
    payload: event,
    receivedAt: verified.receivedAt,
    ...(handlers.size === 0 && !preserveBindingDrop
      ? { dropReason: "configuration_unavailable" }
      : {}),
  });
  logProviderEventIntake({
    provider: "linear",
    source,
    deliveryId: verified.deliveryId,
    resourceId: projectId,
    acceptance,
  });
  const events = acceptance.status === "accepted" ? acceptance.events : [];
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
  return new Response("OK", { status: 200 });
}

function linearEventSource(
  event: NonNullable<ReturnType<typeof normalizeLinearEvent>>,
): "linear.issue" | "linear.comment" {
  return event.type === "issue" ? "linear.issue" : "linear.comment";
}

/** Verify Linear's HMAC-SHA256 over the exact raw request body. */
export function verifyLinearSignature(
  secret: string,
  body: string | Uint8Array,
  signature: string,
): boolean {
  const normalizedSignature = canonicalLinearSignature(signature);
  if (normalizedSignature === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(normalizedSignature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A verified signature's spelling is not evidence; its normalized bytes are. */
function canonicalLinearSignature(signature: string): string | undefined {
  const unprefixed = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return /^[a-f0-9]{64}$/iu.test(unprefixed) ? unprefixed.toLowerCase() : undefined;
}

/** The timestamp is inside the HMAC-protected body, so it can safely prevent replay. */
export function verifyLinearWebhookTimestamp(
  payload: unknown,
  nowMilliseconds = Date.now(),
): boolean {
  if (!isRecord(payload)) return false;
  const timestampMilliseconds = parseLinearWebhookTimestamp(payload["webhookTimestamp"]);
  return (
    timestampMilliseconds !== undefined &&
    Math.abs(nowMilliseconds - timestampMilliseconds) <= MAX_TIMESTAMP_SKEW_MS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLinearWebhookTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}
