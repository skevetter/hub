import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { capabilities } from "./access.js";
import type { JsonValue } from "../config/compiler.js";
import type { ConsumeOrganizationUsageInput } from "../db/types.js";
import type {
  CommandFailureCode,
  CommandKind,
  CommandStatus,
  Delivery,
  ParticipantRole,
  RefusalCode,
  SessionAuditRecord,
  SessionCommandRecord,
  SessionCursor,
  SessionEventRecord,
  SessionListPage,
  SessionMessageRecord,
  SessionParticipantRecord,
  SessionPrincipal,
  SessionProfileRecord,
  SessionProfileSettings,
  SessionRecord,
  SessionState,
  SessionStateReason,
  SessionWithParticipants,
  StoredSession,
  StoredSessionProfile,
} from "./types.js";

export interface SaveSessionProfileInput extends SessionProfileSettings {
  principal: SessionPrincipal;
  id: string | null;
  version: number | null;
  maxActive?: number;
  linearTemplate?: string | null;
  now: Date;
}

interface UsageReservation {
  periodStart: Date;
  limit: number | null;
}

type Participant = Pick<SessionParticipantRecord, "userId" | "role">;

export interface StartSessionInput {
  principal: SessionPrincipal;
  profileId: string;
  profileVersion: number;
  nativeRequester?: { identityId: string; workspaceId: string };
  idempotencyKey: string;
  message: string;
  participants: readonly Participant[];
  usage: UsageReservation;
  maxActivePerDaemon: number;
  bodyCutoff: Date | null;
  now: Date;
}

type Outcome<Success extends string, Failure extends RefusalCode> =
  | { status: Success; session: SessionRecord; command: SessionCommandRecord }
  | { status: "refused"; code: Failure };

export type StartSessionResult = Outcome<
  "created" | "replayed",
  Extract<
    RefusalCode,
    | "idempotency_conflict"
    | "usage_limit"
    | "active_limit"
    | "profile_changed"
    | "profile_unavailable"
    | "daemon_unavailable"
    | "invalid_participant"
    | "message_too_long"
    | "forbidden"
  >
>;
export type AcceptCommandResult = Outcome<"accepted" | "replayed", RefusalCode>;

export type AcceptCommandInput = {
  principal: SessionPrincipal;
  sessionId: string;
  generation: number;
  idempotencyKey: string;
  bodyCutoff: Date | null;
  now: Date;
} & (
  | {
      kind: "message";
      message: string;
      delivery: Delivery;
      maxQueued: number;
      maxMessagesPerMinute: number;
      usage: UsageReservation;
    }
  | { kind: "retry"; commandId: string; maxQueued: number }
  | { kind: Exclude<CommandKind, "message"> }
);

export interface SessionPageInput {
  filter: "active" | "all";
  cursor: SessionCursor | null;
  limit: number;
}

interface SessionScope {
  organizationId: string;
  sessionId: string;
}

export interface ClaimCommandInput extends SessionScope {
  owner: string;
  leaseMs: number;
  // A false hint blocks queued claims even when the stored state is idle.
  agentIdle: boolean;
  lane?: "message" | "control";
  bodyCutoff: Date | null;
  now: Date;
}

export interface SettleCommandInput extends SessionScope {
  commandId: string;
  generation: number;
  claimOwner: string;
  attempts: number;
  status: Extract<CommandStatus, "delivered" | "unknown" | "superseded" | "failed" | "done">;
  failureCode?: CommandFailureCode;
  now: Date;
}

export interface BindSessionAgentInput extends SessionScope {
  generation: number;
  agentId: string;
  workspaceId: string;
  now: Date;
}

export interface ApplySessionStateInput extends SessionScope {
  generation: number;
  // Use the turn associated with the observation, even if a later turn is already running.
  turn: number;
  // A confirmed replacement can begin a new turn while the visible state stays running.
  beginsTurn?: true;
  agentId: string | null;
  from: readonly SessionState[];
  to: Exclude<SessionState, "closed">;
  reason?: SessionStateReason;
  now: Date;
}

export interface SetParticipantInput {
  principal: SessionPrincipal;
  sessionId: string;
  userId: string;
  role: ParticipantRole | null;
  now: Date;
}

export type SaveSessionProfileResult =
  | SessionProfileRecord
  | "version_conflict"
  | "name_taken"
  | "forbidden"
  | "daemon_unavailable"
  | "invalid_mode"
  | "invalid_profile";
export type SetParticipantResult =
  | "set"
  | "removed"
  | "not_member"
  | "last_controller"
  | "not_found"
  | "forbidden";

export interface InteractiveSessionStore {
  listSessionProfiles(organizationId: string): Promise<SessionProfileRecord[]>;
  findSessionProfile(organizationId: string, id: string): Promise<SessionProfileRecord | undefined>;
  saveSessionProfile(input: SaveSessionProfileInput): Promise<SaveSessionProfileResult>;
  startInteractiveSession(input: StartSessionInput): Promise<StartSessionResult>;
  acceptInteractiveSessionCommand(input: AcceptCommandInput): Promise<AcceptCommandResult>;
  listInteractiveSessions(
    organizationId: string,
    viewer: SessionPrincipal,
    page: SessionPageInput,
  ): Promise<SessionListPage>;
  findInteractiveSession(
    organizationId: string,
    sessionId: string,
  ): Promise<SessionWithParticipants | undefined>;
  listInteractiveSessionMessages(
    organizationId: string,
    sessionId: string,
    page: { beforeOrdinal: number | null; limit: number },
    bodyCutoff: Date | null,
  ): Promise<SessionMessageRecord[]>;
  listInteractiveSessionEvents(
    organizationId: string,
    sessionId: string,
    afterSeq: number,
    limit: number,
  ): Promise<SessionEventRecord[]>;
  claimInteractiveSessionCommand(
    input: ClaimCommandInput,
  ): Promise<SessionCommandRecord | undefined>;
  settleInteractiveSessionCommand(input: SettleCommandInput): Promise<boolean>;
  bindInteractiveSessionAgent(input: BindSessionAgentInput): Promise<boolean>;
  applyInteractiveSessionState(input: ApplySessionStateInput): Promise<SessionRecord | undefined>;
  setInteractiveSessionParticipant(input: SetParticipantInput): Promise<SetParticipantResult>;
  listRecoverableInteractiveSessions(
    organizationId: string,
    daemonId: string | null,
  ): Promise<SessionRecord[]>;
  expireInteractiveSessionMessageBodies(cutoff: Date, limit: number, now: Date): Promise<number>;
}

export function refused<Code extends RefusalCode>(code: Code): { status: "refused"; code: Code } {
  return { status: "refused", code };
}

export function sessionUsage(
  principal: SessionPrincipal,
  usage: UsageReservation,
): ConsumeOrganizationUsageInput {
  return {
    organizationId: principal.organizationId,
    meter: "executions.monthly",
    amount: 1,
    ...usage,
  };
}

export function profileSettings(input: SaveSessionProfileInput): SessionProfileSettings {
  const {
    name,
    daemonId,
    cwd,
    worktree,
    provider,
    model,
    mode,
    thinkingOptionId,
    providerOptions,
    fullAccessAcknowledged,
    status,
  } = input;
  return {
    name,
    daemonId,
    cwd,
    worktree,
    provider,
    model,
    mode,
    thinkingOptionId,
    providerOptions,
    fullAccessAcknowledged,
    status,
  };
}

export function profileValidation(
  settings: SessionProfileSettings & Pick<SaveSessionProfileInput, "maxActive" | "linearTemplate">,
): "invalid_mode" | "invalid_profile" | undefined {
  if (
    settings.provider === "omp" &&
    (!settings.mode || (settings.mode === "full" && !settings.fullAccessAcknowledged))
  ) {
    return "invalid_mode";
  }
  const nameLength = Array.from(settings.name).length;
  if (
    nameLength < 1 ||
    nameLength > 80 ||
    !(posix.isAbsolute(settings.cwd) || /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(settings.cwd)) ||
    Buffer.byteLength(settings.cwd) > 1024 ||
    jsonbTextSize(settings.providerOptions) > 4096 ||
    settings.cwd.includes("\0") ||
    !validSurfaceProfileSettings(settings)
  )
    return "invalid_profile";
  return undefined;
}

function jsonbTextSize(value: JsonValue): number {
  if (Array.isArray(value)) {
    return (
      2 +
      value.reduce<number>((bytes, item) => bytes + jsonbTextSize(item), 0) +
      2 * Math.max(0, value.length - 1)
    );
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      2 +
      entries.reduce(
        (bytes, [key, item]) =>
          bytes + Buffer.byteLength(JSON.stringify(key)) + 2 + jsonbTextSize(item),
        0,
      ) +
      2 * Math.max(0, entries.length - 1)
    );
  }
  const encoded = JSON.stringify(value);
  if (typeof value !== "number") return Buffer.byteLength(encoded);

  // PostgreSQL expands exponent notation when rendering JSONB numbers.
  const [mantissa, exponent] = encoded.split("e");
  if (exponent === undefined) return encoded.length;
  const power = Number(exponent);
  const sign = value < 0 ? 1 : 0;
  if (power >= 0) return sign + power + 1;
  const digits = mantissa!.replace(/[-.]/gu, "").length;
  return sign + 1 - power + digits;
}

function validSurfaceProfileSettings(
  input: Pick<SaveSessionProfileInput, "maxActive" | "linearTemplate">,
): boolean {
  const { maxActive, linearTemplate } = input;
  return (
    (maxActive === undefined ||
      (Number.isInteger(maxActive) && maxActive >= 1 && maxActive <= 16)) &&
    (linearTemplate == null ||
      (linearTemplate.length > 0 &&
        Buffer.byteLength(linearTemplate) <= 16384 &&
        !linearTemplate.includes("\0")))
  );
}

export function profileVersionMatches(
  input: SaveSessionProfileInput,
  current: SessionProfileRecord | undefined,
): boolean {
  if (input.id === null) return input.version === null;
  return (
    current?.organizationId === input.principal.organizationId && current.version === input.version
  );
}

export function profileRecord(
  input: SaveSessionProfileInput,
  settings: SessionProfileSettings,
  current?: StoredSessionProfile,
): StoredSessionProfile {
  const fields = {
    ...settings,
    access: "private" as const,
    maxActive: input.maxActive ?? current?.maxActive ?? 4,
    linearTemplate:
      input.linearTemplate === undefined ? (current?.linearTemplate ?? null) : input.linearTemplate,
  };
  if (current) {
    return { ...current, ...fields, version: current.version + 1, updatedAt: input.now };
  }
  return {
    ...fields,
    id: randomUUID(),
    organizationId: input.principal.organizationId,
    createdByUserId: input.principal.userId,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function validMessage(message: string): boolean {
  return message.length > 0 && Buffer.byteLength(message) <= 16384 && !message.includes("\0");
}

export function startParticipants(input: StartSessionInput): Participant[] {
  const participants = new Map(input.participants.map((person) => [person.userId, person.role]));
  participants.set(input.principal.userId, "controller");
  return [...participants]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    })
    .map(([userId, role]) => ({ userId, role }));
}

export function startHash(input: StartSessionInput, participants: readonly Participant[]): string {
  const request: unknown[] = [
    input.profileId.toLowerCase(),
    input.profileVersion,
    input.message,
    participants.map(({ userId, role }) => [userId, role]),
  ];
  if (input.nativeRequester) {
    request.push([
      "linear",
      input.nativeRequester.workspaceId,
      input.nativeRequester.identityId.toLowerCase(),
    ]);
  }
  return hashRequest(request);
}

export function commandHash(input: AcceptCommandInput): string {
  const scope = [input.generation, input.kind];
  if (input.kind === "message") return hashRequest([...scope, [input.delivery, input.message]]);
  if (input.kind === "retry") return hashRequest([...scope, input.commandId.toLowerCase()]);
  return hashRequest([...scope, null]);
}

export function sendRateCutoff(now: Date): Date {
  return new Date(now.getTime() - 60_000);
}

function hashRequest(input: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function newSession(
  input: StartSessionInput,
  profile: SessionProfileRecord,
  requestHash: string,
): StoredSession {
  const id = randomUUID();
  return {
    id,
    organizationId: input.principal.organizationId,
    profileId: profile.id,
    profileVersion: profile.version,
    origin: input.nativeRequester ? "linear" : "web",
    requesterIdentityId: input.nativeRequester?.identityId.toLowerCase() ?? null,
    daemonId: profile.daemonId,
    title: profile.name,
    launch: {
      daemonId: profile.daemonId,
      cwd: profile.cwd,
      worktree: profile.worktree && {
        ...profile.worktree,
        newBranch: "hub-session/" + id.slice(0, 8),
      },
      provider: profile.provider,
      model: profile.model,
      mode: profile.mode,
      thinkingOptionId: profile.thinkingOptionId,
      providerOptions: profile.providerOptions,
    },
    state: "starting",
    stateReason: null,
    generation: 1,
    turn: 0,
    daemonAgentId: null,
    daemonWorkspaceId: null,
    hubSeq: 0,
    commandSeq: 1,
    startedByUserId: input.principal.userId,
    startIdempotencyKey: input.idempotencyKey.toLowerCase(),
    startRequestHash: requestHash,
    lastActivityAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
    closedAt: null,
    closedByUserId: null,
  };
}

export function newCommand(
  session: SessionRecord,
  input: Pick<AcceptCommandInput, "principal" | "idempotencyKey" | "now">,
  kind: CommandKind,
  delivery: Delivery | null,
  body: string | null,
  requestHash: string,
): SessionCommandRecord {
  return {
    id: randomUUID(),
    organizationId: session.organizationId,
    sessionId: session.id,
    ordinal: session.commandSeq,
    generation: session.generation,
    kind,
    delivery,
    status: delivery === "queue" ? "queued" : "pending",
    failureCode: null,
    body,
    bodyExpiredAt: null,
    authorUserId: input.principal.userId,
    idempotencyKey: input.idempotencyKey.toLowerCase(),
    requestHash,
    attempts: 0,
    claimOwner: null,
    claimExpiresAt: null,
    createdAt: input.now,
    updatedAt: input.now,
    dispatchedAt: null,
    settledAt: null,
  };
}

export const unsettledStatuses = ["pending", "queued", "dispatching", "unknown"] as const;
// Cap delivery at five total attempts, including the initial send, to limit resends.
export const maxDeliveryAttempts = 5;

export function commandRefusal(
  session: SessionRecord,
  input: AcceptCommandInput,
): RefusalCode | undefined {
  if (session.generation !== input.generation) return "stale_generation";
  if (session.state === "closed") return "session_closed";
  if (input.kind === "replace") return session.state === "failed" ? undefined : "invalid_mode";
  if (input.kind === "close") return undefined;
  if (session.state === "failed") return "session_failed";
  if (input.kind === "stop") {
    return session.state === "running" || session.state === "waiting_permission"
      ? undefined
      : "not_stoppable";
  }
  if (input.kind === "message" || input.kind === "retry") {
    if (session.state === "stopping") return "session_stopping";
    if (input.kind === "retry")
      return session.state === "waiting_permission" ? "waiting_permission" : undefined;
    if (session.state === "waiting_permission" && input.delivery === "steer")
      return "waiting_permission";
    if (!validMessage(input.message)) return "message_too_long";
  }
  return undefined;
}

export function advanceForCommand(
  session: SessionRecord,
  input: AcceptCommandInput,
): SessionRecord {
  const next = { ...session, commandSeq: session.commandSeq + 1 };
  switch (input.kind) {
    case "stop":
      return { ...next, state: "stopping", stateReason: null };
    case "close":
      return {
        ...next,
        state: "closed",
        stateReason: "closed_by_person",
        closedAt: input.now,
        closedByUserId: input.principal.userId,
      };
    case "replace":
      return {
        ...next,
        state: "starting",
        stateReason: null,
        generation: next.generation + 1,
        turn: 0,
        daemonAgentId: null,
        daemonWorkspaceId: null,
      };
    default:
      return next;
  }
}

export function observedSessionTransition(
  session: SessionRecord,
  input: ApplySessionStateInput,
): SessionRecord | undefined {
  if (
    session.generation !== input.generation ||
    session.turn !== input.turn ||
    session.daemonAgentId !== input.agentId ||
    session.state === "closed" ||
    !input.from.includes(session.state)
  )
    return undefined;
  const newTurn =
    input.to === "running" &&
    (input.beginsTurn === true || session.state === "starting" || session.state === "idle");
  return {
    ...session,
    state: input.to,
    stateReason: input.reason ?? null,
    turn: session.turn + Number(newTurn),
  };
}

export function interruptCommand(
  command: SessionCommandRecord,
  kind: "stop" | "close" | "replace",
  now: Date,
): Partial<SessionCommandRecord> | undefined {
  if (!unsettledStatuses.some((status) => status === command.status)) return undefined;
  if (kind === "replace" || (kind === "close" && command.kind === "stop")) {
    return settlePatch("superseded", now);
  }
  if (command.kind !== "message") return undefined;
  if (command.status === "pending" || command.status === "queued")
    return settlePatch("superseded", now);
  if (command.failureCode === "delivery_unconfirmed") return undefined;
  // The original lease can still receive a definitive acknowledgement, but cannot auto-resend.
  if (kind === "stop" && command.status === "dispatching")
    return { failureCode: "delivery_unconfirmed", updatedAt: now };
  return settlePatch("unknown", now, "delivery_unconfirmed");
}

export const commandCapability = {
  message: "send",
  retry: "send",
  stop: "stop",
  close: "close",
  replace: "replaceAgent",
} as const;

function canDispatchCommand(
  command: SessionCommandRecord,
  input: ClaimCommandInput,
  rights: ReturnType<typeof capabilities> | undefined,
): boolean {
  if (!rights?.[commandCapability[command.kind]]) return false;
  return (
    command.kind !== "message" || (command.body !== null && bodyVisible(command, input.bodyCutoff))
  );
}

export function commandLeaseEligible(
  command: SessionCommandRecord,
  input: ClaimCommandInput,
  sessionState: SessionState,
  leaseNow: Date,
): boolean {
  if (
    command.kind === "message" &&
    (sessionState === "waiting_permission" || sessionState === "stopping") &&
    !(command.status === "dispatching" && command.failureCode === "delivery_unconfirmed")
  )
    return false;
  return (
    (command.claimExpiresAt === null || command.claimExpiresAt <= leaseNow) &&
    (command.status === "pending" ||
      (command.status === "unknown" && command.failureCode !== "delivery_unconfirmed") ||
      command.status === "dispatching" ||
      (command.status === "queued" && sessionState === "idle" && input.agentIdle))
  );
}

export function claimPatch(
  command: SessionCommandRecord,
  input: ClaimCommandInput,
  rights: ReturnType<typeof capabilities> | undefined,
  leaseNow: Date,
): Partial<SessionCommandRecord> {
  if (
    command.failureCode === "delivery_unconfirmed" ||
    !canDispatchCommand(command, input, rights) ||
    command.attempts >= maxDeliveryAttempts
  ) {
    if (command.status === "unknown" || command.status === "dispatching") {
      return settlePatch("unknown", input.now, "delivery_unconfirmed");
    }
    return settlePatch("superseded", input.now);
  }
  return {
    status: "dispatching",
    failureCode: null,
    attempts: command.attempts + 1,
    claimOwner: input.owner,
    claimExpiresAt: new Date(leaseNow.getTime() + input.leaseMs),
    dispatchedAt: input.now,
    settledAt: null,
    updatedAt: input.now,
  };
}

export function finalDeliveryCode(
  command: SessionCommandRecord,
  input: SettleCommandInput,
): CommandFailureCode | undefined {
  if (
    input.status === "unknown" &&
    (command.attempts >= maxDeliveryAttempts || command.failureCode === "delivery_unconfirmed")
  )
    return "delivery_unconfirmed";
  return input.failureCode;
}

export function exhaustedControlState(
  session: SessionRecord,
  command: SessionCommandRecord,
  now: Date,
): SessionRecord {
  if (
    command.kind === "stop" &&
    session.state === "stopping" &&
    (command.attempts >= maxDeliveryAttempts ||
      command.status === "superseded" ||
      command.failureCode === "delivery_unconfirmed")
  )
    return { ...session, state: "running", stateReason: null };
  if (command.attempts < maxDeliveryAttempts) return session;
  if (command.kind === "replace" && session.state === "starting" && command.status === "unknown")
    return { ...session, state: "closed", stateReason: "launch_failed", closedAt: now };
  return session;
}

export function canRetryMessage(command: SessionCommandRecord, cutoff: Date | null): boolean {
  return (
    command.kind === "message" &&
    command.status === "unknown" &&
    command.failureCode === "delivery_unconfirmed" &&
    command.attempts < maxDeliveryAttempts &&
    command.body !== null &&
    bodyVisible(command, cutoff)
  );
}

export function retryMessagePatch(
  command: SessionCommandRecord,
  now: Date,
): Partial<SessionCommandRecord> {
  return {
    status: command.delivery === "queue" ? "queued" : "pending",
    updatedAt: now,
    failureCode: null,
    settledAt: null,
  };
}

export function settlePatch(
  status: SettleCommandInput["status"],
  now: Date,
  failureCode: CommandFailureCode | null = null,
): Partial<SessionCommandRecord> {
  return {
    status,
    failureCode,
    claimOwner: null,
    claimExpiresAt: null,
    settledAt: now,
    updatedAt: now,
  };
}

type EventDraft = SessionEventRecord extends infer Event
  ? Event extends SessionEventRecord
    ? Omit<Event, "organizationId" | "sessionId" | "seq" | "at">
    : never
  : never;
export type SessionEventDraft = EventDraft;

export function stateEvent(
  session: SessionRecord,
  reason: SessionStateReason | "stop_unconfirmed" | null = session.stateReason,
): SessionEventDraft {
  return {
    kind: "state",
    commandId: null,
    data: {
      state: session.state,
      stateReason: reason,
      generation: session.generation,
      turn: session.turn,
    },
  };
}

export function messageEvent(command: SessionCommandRecord): SessionEventDraft {
  return { kind: "message", commandId: command.id, data: { ordinal: command.ordinal } };
}

export function deliveryEvent(command: SessionCommandRecord): SessionEventDraft {
  return {
    kind: "delivery",
    commandId: command.id,
    data: { status: command.status, failureCode: command.failureCode },
  };
}

function bodyVisible(command: SessionCommandRecord, cutoff: Date | null): boolean {
  return command.bodyExpiredAt === null && (cutoff === null || command.createdAt >= cutoff);
}

export function replayCommand(
  command: SessionCommandRecord,
  cutoff: Date | null,
): SessionCommandRecord {
  return bodyVisible(command, cutoff) ? command : { ...command, body: null };
}

export function sessionAudit(
  session: SessionRecord,
  actorIdentity: string,
  action: string,
  evidence: SessionAuditRecord["evidence"],
  now: Date,
): SessionAuditRecord {
  return {
    id: randomUUID(),
    organizationId: session.organizationId,
    actorKind: "user",
    actorIdentity,
    action: "interactive_session." + action,
    subjectType: "interactive_session",
    subjectId: session.id,
    evidence,
    createdAt: now,
  };
}

export function messageRecord(
  command: SessionCommandRecord,
  cutoff: Date | null,
): SessionMessageRecord {
  if (command.delivery === null) throw new Error("Session message is missing its delivery mode");
  const expired = !bodyVisible(command, cutoff);
  return {
    commandId: command.id,
    ordinal: command.ordinal,
    generation: command.generation,
    authorUserId: command.authorUserId,
    delivery: command.delivery,
    status: command.status,
    failureCode: command.failureCode,
    body: expired ? null : command.body,
    expired,
    retryable: canRetryMessage(command, cutoff),
    createdAt: command.createdAt,
  };
}

export function sessionPage(rows: SessionRecord[], limit: number): SessionListPage {
  const sessions = rows.slice(0, limit);
  const last = rows.length > limit ? sessions.at(-1) : undefined;
  return {
    sessions,
    nextCursor: last ? { id: last.id, lastActivityAt: last.lastActivityAt } : null,
  };
}
