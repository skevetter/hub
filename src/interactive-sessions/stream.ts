import { registerResponseLifecycle } from "../http/response-lifecycle.js";
import { problem, requestIdentifier } from "../public-api/problem.js";
import type { SessionEventBus } from "./bus.js";
import { isSessionId } from "./service.js";
import {
  SessionStreamSubscriber,
  validAgentEpoch,
  type SessionStreamCursor,
  type SessionStreamSettings,
  type SessionStreamSource,
} from "./stream-subscriber.js";

interface StreamOptions {
  service: SessionStreamSource;
  bus: SessionEventBus;
  settings: SessionStreamSettings;
  reportFailure?(error: unknown, requestId: string): void;
}

const failures = {
  not_found: [404, "Not found", "The requested session is unavailable."],
  method_not_allowed: [405, "Method not allowed", "This route only accepts GET requests."],
  unauthorized: [401, "Unauthorized", "A browser session is required."],
  invalid_request: [400, "Invalid request", "The event cursor is invalid."],
  too_many_streams: [429, "Too many streams", "An open stream limit has been reached."],
  shutting_down: [503, "Shutting down", "The Hub is stopping."],
  infrastructure_unavailable: [
    503,
    "Infrastructure unavailable",
    "Session storage is unavailable.",
  ],
} as const;

export function interactiveSessionStreamFailure(
  requestId: string,
  code: keyof typeof failures,
): Response {
  const [status, title, detail] = failures[code];
  let headers: Record<string, string> | undefined;
  if (code === "too_many_streams") headers = { "retry-after": "30" };
  else if (code === "shutting_down") headers = { "retry-after": "5" };
  else if (code === "method_not_allowed") headers = { allow: "GET" };
  return problem(requestId, status, code, title, detail, undefined, headers);
}

export class InteractiveSessionStream {
  private closing = false;
  private readonly subscribers = new Set<SessionStreamSubscriber>();
  private readonly users = new Map<string, number>();
  private readonly organizations = new Map<string, number>();

  constructor(private readonly options: StreamOptions) {}

  activeStreamCount(): number {
    return this.subscribers.size;
  }

  async beginShutdown(): Promise<void> {
    this.closing = true;
    for (const subscriber of this.subscribers) subscriber.shutdown();
  }

  async handle(request: Request, sessionId: string): Promise<Response> {
    const requestId = requestIdentifier(request);
    const fail = (code: keyof typeof failures) => interactiveSessionStreamFailure(requestId, code);
    if (request.method !== "GET") return fail("method_not_allowed");
    if (this.closing) return fail("shutting_down");
    if (!isSessionId(sessionId)) return fail("not_found");
    const id = sessionId.toLowerCase();
    const url = new URL(request.url);
    const organizationSlug = url.searchParams.get("organization") ?? "";
    const { settings, service, bus } = this.options;
    try {
      const principal = await service.authorizeStream(request, organizationSlug, id);
      if (typeof principal === "string") return fail(principal);
      const lastEventId = request.headers.get("last-event-id");
      const cursor = parseCursor(lastEventId ?? url.searchParams.get("after"));
      if (cursor === undefined) return fail("invalid_request");
      if (this.closing) return fail("shutting_down");
      const { userId, organizationId } = principal;
      const userCount = this.users.get(userId) ?? 0;
      const organizationCount = this.organizations.get(organizationId) ?? 0;
      if (
        userCount >= settings.streamMaxPerKey ||
        organizationCount >= settings.streamMaxPerOrg ||
        this.activeStreamCount() >= settings.streamMaxTotal
      )
        return fail("too_many_streams");
      const subscriber = new SessionStreamSubscriber({
        service,
        bus,
        settings,
        request,
        sessionId: id,
        organizationSlug,
        principal,
        cursor,
        resumeWithoutAgent: cursor.agent === null && (lastEventId !== null || cursor.hubSeq > 0),
        release: () => {
          this.subscribers.delete(subscriber);
          decrement(this.users, userId);
          decrement(this.organizations, organizationId);
        },
        reportFailure: (error) => this.report(error, requestId),
      });
      this.subscribers.add(subscriber);
      this.users.set(userId, userCount + 1);
      this.organizations.set(organizationId, organizationCount + 1);
      subscriber.start();
      return registerResponseLifecycle(
        new Response(subscriber.body, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
            "x-request-id": requestId,
          },
        }),
        {
          onFinish: () => subscriber.end(),
          onAbort: () => subscriber.end(),
        },
      );
    } catch (error) {
      this.report(error, requestId);
      return fail("infrastructure_unavailable");
    }
  }

  private report(error: unknown, requestId: string): void {
    try {
      this.options.reportFailure?.(error, requestId);
    } catch {}
  }
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = counts.get(key) ?? 0;
  if (count <= 1) counts.delete(key);
  else counts.set(key, count - 1);
}

function parseCursor(raw: string | null): SessionStreamCursor | undefined {
  if (raw === null) return { hubSeq: 0, agent: null };
  const match = /^([0-9]+)(?::([0-9]+)(?:\.([0-9]+))?:(.{1,200}))?(?![\s\S])/u.exec(raw);
  if (match === null) return undefined;
  const hubSeq = Number(match[1]);
  if (!Number.isSafeInteger(hubSeq)) return undefined;
  const seq = Number(match[2]);
  const epoch = match[4];
  if (epoch === undefined) return { hubSeq, agent: null };
  if (!Number.isSafeInteger(seq) || !validAgentEpoch(epoch)) return undefined;
  const chunkOffset = match[3] === undefined ? undefined : Number(match[3]);
  if (
    chunkOffset !== undefined &&
    (!Number.isSafeInteger(chunkOffset) || chunkOffset < 1 || chunkOffset > 65536)
  )
    return undefined;
  return { hubSeq, agent: { seq, epoch, ...(chunkOffset === undefined ? {} : { chunkOffset }) } };
}
