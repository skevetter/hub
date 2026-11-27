import type { Logger } from "pino";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import { registerResponseLifecycle } from "../http/response-lifecycle.js";
import { logger } from "../logger.js";
import { resolveRouteTenant, isTenantRouteNotFoundError } from "../projects/access.js";
import { problem, requestIdentifier } from "../public-api/problem.js";
import type { RunProgressSettings } from "../run-progress/settings.js";
import type { RunTimelineBus } from "../run-timeline/bus.js";
import type { RunTimelineReconciler } from "../run-timeline/reconcile.js";
import { isRunTimelineExpired, retentionCutoff } from "../run-timeline/retention.js";
import type { RunTimelineEvent } from "../run-timeline/store.js";
import { RunStreamNotifier } from "./notifier.js";
import { controlEvent, RunStreamSubscriber, type StreamContext } from "./subscriber.js";

interface StreamAccess {
  organizationId: string;
  credentialId: string;
  kind: "apiKey" | "cliCredential" | "session";
  reauthorize(): Promise<boolean>;
}

export interface RunStreamOptions {
  database: Database | null;
  auth: AuthServer | null;
  credentials: OperationAuthenticator | undefined;
  bus: RunTimelineBus | undefined;
  reconciler: Pick<RunTimelineReconciler, "reconcileBeforeTerminal"> | undefined;
  settings: RunProgressSettings;
  logger?: Pick<Logger, "info">;
  reportFailure?: (error: unknown, requestId: string) => void;
}

interface StreamInfrastructure {
  database: Database;
  bus: RunTimelineBus;
  reconciler: Pick<RunTimelineReconciler, "reconcileBeforeTerminal">;
}

interface PreparedStream extends StreamContext {
  after: number;
  firstSeq: number | null;
}

interface OpenRunStream {
  request: Request;
  requestId: string;
  access: StreamAccess;
  prepared: PreparedStream;
  infrastructure: StreamInfrastructure;
}

const errors = {
  not_found: [404, "Not found", "The requested route does not exist."],
  method_not_allowed: [405, "Method not allowed", "This route only accepts GET requests."],
  unauthorized: [401, "Unauthorized", "A valid credential or browser session is required."],
  insufficient_scope: [403, "Insufficient scope", "The credential requires runs:read."],
  run_not_found: [404, "Run not found", "The requested run is unavailable."],
  timeline_expired: [410, "Timeline expired", "The run timeline has expired."],
  invalid_request: [
    400,
    "Invalid request",
    "The event cursor must be a non-negative safe integer.",
  ],
  too_many_streams: [429, "Too many streams", "An open stream limit has been reached."],
  shutting_down: [503, "Shutting down", "The Hub is stopping."],
  infrastructure_unavailable: [503, "Infrastructure unavailable", "Run storage is unavailable."],
} as const;

export class RunStream {
  private closing = false;
  private readonly subscribers = new Set<RunStreamSubscriber>();
  private readonly notifiers = new Map<string, RunStreamNotifier>();
  private readonly credentials = new Map<string, number>();
  private readonly organizations = new Map<string, number>();

  constructor(private readonly options: RunStreamOptions) {}

  activeStreamCount(): number {
    return this.subscribers.size;
  }

  notifierCount(): number {
    return this.notifiers.size;
  }

  async beginShutdown(): Promise<void> {
    this.closing = true;
    for (const subscriber of this.subscribers) {
      subscriber.finish("shutdown", controlEvent("shutdown", { reconnectMs: 5000 }));
    }
  }

  async handle(request: Request, runId: string): Promise<Response> {
    const requestId = requestIdentifier(request);
    const { database, bus, reconciler, settings } = this.options;
    if (!settings.runStreamEnabled) return this.failure(requestId, "not_found");
    if (request.method !== "GET") return this.failure(requestId, "method_not_allowed");
    if (this.closing) return this.failure(requestId, "shutting_down");
    const infrastructure = { database, bus, reconciler };
    if (!hasInfrastructure(infrastructure))
      return this.failure(requestId, "infrastructure_unavailable");
    try {
      const access = await this.authorize(request);
      if (typeof access === "string") return this.failure(requestId, access);
      const prepared = await this.prepare(request, runId, access.organizationId, infrastructure);
      if (typeof prepared === "string") return this.failure(requestId, prepared);
      if (this.closing) return this.failure(requestId, "shutting_down");
      return this.open({ request, requestId, access, prepared, infrastructure });
    } catch (error) {
      this.report(error, requestId);
      return this.failure(requestId, "infrastructure_unavailable");
    }
  }

  private failure(requestId: string, code: keyof typeof errors): Response {
    const [status, title, detail] = errors[code];
    let headers: Record<string, string> | undefined;
    if (code === "too_many_streams") headers = { "retry-after": "30" };
    else if (code === "shutting_down") headers = { "retry-after": "5" };
    else if (code === "method_not_allowed") headers = { allow: "GET" };
    return problem(requestId, status, code, title, detail, undefined, headers);
  }

  private async prepare(
    request: Request,
    runId: string,
    organizationId: string,
    { database, reconciler }: StreamInfrastructure,
  ): Promise<PreparedStream | keyof typeof errors> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(runId))
      return "run_not_found";
    const run = await database.findTriggerRunForOrganization(organizationId, runId);
    if (!isAcceptedRun(run)) return "run_not_found";
    let state = await database.readRunTimelineState(organizationId, run.id);
    const expired = () => this.timelineExpired(run, state);
    if (expired()) return "timeline_expired";
    const after = parseAfter(request);
    if (after === undefined) return "invalid_request";
    if (shouldReconcile(run, state)) {
      await reconciler.reconcileBeforeTerminal(organizationId, run.id);
      state = await database.readRunTimelineState(organizationId, run.id);
      if (expired()) return "timeline_expired";
    }
    const first = await database.listRunTimelineEvents(organizationId, run.id, {
      afterSeq: 0,
      limit: 1,
    });
    const current = await database.findTriggerRunForOrganization(organizationId, runId);
    if (!isAcceptedRun(current)) return "run_not_found";
    if (current.payloadExpiredAt != null) return "timeline_expired";
    return { run: current, state, after, firstSeq: firstSequence(first) };
  }

  private timelineExpired(run: AcceptedTriggerRunRecord, state: StreamContext["state"]): boolean {
    return isRunTimelineExpired(
      {
        completedAt: run.completedAt,
        expiredAt: state?.expiredAt ?? null,
        payloadExpiredAt: run.payloadExpiredAt,
      },
      retentionCutoff(new Date(), this.options.settings.retentionDays),
    );
  }

  private open({ request, requestId, access, prepared, infrastructure }: OpenRunStream): Response {
    const { database, reconciler } = infrastructure;
    const { settings } = this.options;
    const runId = prepared.run.id;
    const credentialKey = JSON.stringify([access.kind, access.credentialId]);
    const credentialCount = this.credentials.get(credentialKey) ?? 0;
    const organizationCount = this.organizations.get(access.organizationId) ?? 0;
    if (
      credentialCount >= settings.streamMaxPerKey ||
      organizationCount >= settings.streamMaxPerOrg ||
      this.subscribers.size >= settings.streamMaxTotal
    )
      return this.failure(requestId, "too_many_streams");
    const notifierKey = JSON.stringify([access.organizationId, runId]);
    const shared = this.notifier(infrastructure, access.organizationId, runId, notifierKey);
    shared.references += 1;
    this.credentials.set(credentialKey, credentialCount + 1);
    this.organizations.set(access.organizationId, organizationCount + 1);
    const subscriber = new RunStreamSubscriber({
      store: database,
      reconciler,
      notifier: shared,
      settings,
      request,
      context: prepared,
      firstSeq: prepared.firstSeq,
      after: prepared.after,
      reportFailure: (error) => this.report(error, requestId),
      reauthorize: () => access.reauthorize(),
      release: (reason, durationMs, eventsSent) => {
        this.subscribers.delete(subscriber);
        decrement(this.credentials, credentialKey);
        decrement(this.organizations, access.organizationId);
        if (--shared.references === 0) {
          shared.close();
          this.notifiers.delete(notifierKey);
        }
        (this.options.logger ?? logger).info(
          {
            operation: "run.stream.closed",
            authKind: access.kind,
            authSubjectId: access.credentialId,
            triggerRunId: runId,
            reason,
            durationMs,
            eventsSent,
          },
          "run stream closed",
        );
      },
    });
    this.subscribers.add(subscriber);
    return streamResponse(subscriber, requestId);
  }

  private notifier(
    { database, bus }: StreamInfrastructure,
    organizationId: string,
    runId: string,
    key: string,
  ): RunStreamNotifier {
    const existing = this.notifiers.get(key);
    if (existing !== undefined) return existing;
    const notifier = new RunStreamNotifier(database, bus, organizationId, runId);
    this.notifiers.set(key, notifier);
    return notifier;
  }

  private report(error: unknown, requestId: string): void {
    try {
      this.options.reportFailure?.(error, requestId);
    } catch {}
  }

  private async authorize(
    request: Request,
  ): Promise<
    | StreamAccess
    | "unauthorized"
    | "insufficient_scope"
    | "run_not_found"
    | "infrastructure_unavailable"
  > {
    if (request.headers.has("authorization")) {
      const credentials = this.options.credentials;
      if (credentials === undefined) return "infrastructure_unavailable";
      const result = await credentials.authorize(request, "runs:read");
      return credentialAccess(credentials, result);
    }
    const { auth, database } = this.options;
    if (auth === null || database === null) return "unauthorized";
    const organizationSlug = new URL(request.url).searchParams.get("organization") ?? "";
    try {
      const { account, tenant } = await resolveRouteTenant(auth, database, request, {
        organizationSlug,
      });
      return {
        kind: "session",
        credentialId: account.account.id,
        organizationId: tenant.organization.id,
        reauthorize: async () => {
          const current = await resolveRouteTenant(auth, database, request, { organizationSlug });
          return (
            current.account.account.id === account.account.id &&
            current.tenant.organization.id === tenant.organization.id
          );
        },
      };
    } catch (error) {
      if (isTenantRouteNotFoundError(error)) return "run_not_found";
      if (error instanceof ProductRequestError) return "unauthorized";
      throw error;
    }
  }
}

function hasInfrastructure(
  input: Pick<RunStreamOptions, "database" | "bus" | "reconciler">,
): input is StreamInfrastructure {
  return input.database !== null && input.bus !== undefined && input.reconciler !== undefined;
}

function parseAfter(request: Request): number | undefined {
  const raw =
    new URL(request.url).searchParams.get("after") ?? request.headers.get("last-event-id");
  let after = 0;
  if (raw !== null) after = /^[0-9]+$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(after) && after >= 0 ? after : undefined;
}

function isAcceptedRun(
  run: Awaited<ReturnType<Database["findTriggerRunForOrganization"]>>,
): run is AcceptedTriggerRunRecord {
  return run?.outcome === "accepted";
}

function shouldReconcile(run: AcceptedTriggerRunRecord, state: StreamContext["state"]): boolean {
  return run.status !== "running" && state?.sealedSeq == null;
}

function firstSequence(rows: RunTimelineEvent[]): number | null {
  return rows[0]?.seq ?? null;
}

function decrement(counts: Map<string, number>, key: string): void {
  const remaining = Number(counts.get(key)) - 1;
  if (remaining === 0) counts.delete(key);
  else counts.set(key, remaining);
}

function streamResponse(subscriber: RunStreamSubscriber, requestId: string): Response {
  const response = new Response(subscriber.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      "x-request-id": requestId,
    },
  });
  return registerResponseLifecycle(response, {
    onFinish: () => subscriber.finish("end"),
    onAbort: () => subscriber.finish("abort"),
  });
}

function credentialAccess(
  credentials: OperationAuthenticator,
  result: Awaited<ReturnType<OperationAuthenticator["authorize"]>>,
): StreamAccess | "unauthorized" | "insufficient_scope" {
  if (result.status === "unauthorized") return "unauthorized";
  if (result.status === "forbidden") return "insufficient_scope";
  return {
    ...result.access,
    reauthorize: () => credentials.reauthorize(result.access, "runs:read"),
  };
}
