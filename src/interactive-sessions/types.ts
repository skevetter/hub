import type { WorktreeTarget } from "../config/index.js";
import type { JsonValue } from "../config/compiler.js";

export type SessionState =
  | "starting"
  | "running"
  | "idle"
  | "waiting_permission"
  | "stopping"
  | "failed"
  | "closed";
export type SessionStateReason =
  | "stopped_by_person"
  | "launch_failed"
  | "agent_missing"
  | "daemon_revoked"
  | "closed_by_person";
export type CommandStatus =
  | "pending"
  | "queued"
  | "dispatching"
  | "delivered"
  | "unknown"
  | "superseded"
  | "failed"
  | "done";
export type CommandFailureCode =
  | "key_conflict"
  | "agent_missing"
  | "daemon_rejected"
  | "launch_failed"
  | "delivery_unconfirmed";
export type CommandKind = "message" | "stop" | "close" | "replace";
export type Delivery = "steer" | "queue";
export type ParticipantRole = "controller" | "viewer";
export type SessionProfileStatus = "active" | "disabled";

export type RefusalCode =
  | "not_found"
  | "forbidden"
  | "profile_unavailable"
  | "profile_changed"
  | "daemon_unavailable"
  | "active_limit"
  | "queue_full"
  | "rate_limited"
  | "stale_generation"
  | "session_closed"
  | "session_failed"
  | "session_stopping"
  | "not_retryable"
  | "waiting_permission"
  | "not_stoppable"
  | "usage_limit"
  | "idempotency_conflict"
  | "message_too_long"
  | "invalid_participant"
  | "last_controller"
  | "invalid_mode";

export interface SessionLaunch {
  daemonId: string;
  cwd: string;
  worktree: WorktreeTarget | null;
  provider: string;
  model: string | null;
  mode: string | null;
  thinkingOptionId: string | null;
  providerOptions: Readonly<Record<string, JsonValue>>;
}

export interface SessionPrincipal {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

export interface SessionProfileSettings extends Omit<SessionLaunch, "worktree"> {
  name: string;
  worktree: { mode: "branch-off"; base?: string } | null;
  fullAccessAcknowledged: boolean;
  status: SessionProfileStatus;
}

interface SessionProfileSurfaceSettings {
  access: "private";
  maxActive: number;
  linearTemplate: string | null;
}

export interface SessionProfileRecord
  extends SessionProfileSettings, Partial<SessionProfileSurfaceSettings> {
  id: string;
  organizationId: string;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type StoredSessionProfile = SessionProfileRecord & SessionProfileSurfaceSettings;

interface SessionOrigin {
  origin: "web" | "linear";
  requesterIdentityId: string | null;
}

export interface SessionRecord extends Partial<SessionOrigin> {
  id: string;
  organizationId: string;
  profileId: string;
  profileVersion: number;
  launch: SessionLaunch;
  daemonId: string;
  title: string;
  state: SessionState;
  stateReason: SessionStateReason | null;
  generation: number;
  turn: number;
  daemonAgentId: string | null;
  daemonWorkspaceId: string | null;
  hubSeq: number;
  commandSeq: number;
  startedByUserId: string | null;
  startIdempotencyKey: string;
  startRequestHash: string;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  closedByUserId: string | null;
}

export type StoredSession = SessionRecord & SessionOrigin;

export interface SessionParticipantRecord {
  organizationId: string;
  sessionId: string;
  userId: string;
  role: ParticipantRole;
  addedByUserId: string | null;
  createdAt: Date;
}

export interface SessionWithParticipants {
  session: SessionRecord;
  participants: SessionParticipantRecord[];
}

export interface SessionCommandRecord {
  id: string;
  organizationId: string;
  sessionId: string;
  ordinal: number;
  generation: number;
  kind: CommandKind;
  delivery: Delivery | null;
  status: CommandStatus;
  failureCode: CommandFailureCode | null;
  body: string | null;
  bodyExpiredAt: Date | null;
  authorUserId: string | null;
  idempotencyKey: string;
  requestHash: string;
  attempts: number;
  claimOwner: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  dispatchedAt: Date | null;
  settledAt: Date | null;
}

export interface SessionMessageRecord {
  commandId: string;
  ordinal: number;
  generation: number;
  authorUserId: string | null;
  delivery: Delivery;
  status: CommandStatus;
  failureCode: CommandFailureCode | null;
  body: string | null;
  expired: boolean;
  retryable: boolean;
  createdAt: Date;
}

type SessionEvent =
  | { kind: "message"; commandId: string; data: { ordinal: number } }
  | {
      kind: "delivery";
      commandId: string;
      data: { status: CommandStatus; failureCode: CommandFailureCode | null };
    }
  | {
      kind: "state";
      commandId: null;
      data: {
        state: SessionState;
        stateReason: SessionStateReason | "stop_unconfirmed" | null;
        generation: number;
        turn: number;
      };
    }
  | {
      kind: "participants";
      commandId: null;
      data: { userId: string; role: ParticipantRole | null };
    };

export type SessionEventRecord = SessionEvent & {
  organizationId: string;
  sessionId: string;
  seq: number;
  at: Date;
};

export interface SessionAuditRecord {
  id: string;
  organizationId: string;
  actorKind: "user";
  actorIdentity: string;
  action: string;
  subjectType: "interactive_session";
  subjectId: string;
  evidence: Readonly<Record<string, JsonValue>>;
  createdAt: Date;
}

export interface SessionCursor {
  lastActivityAt: Date;
  id: string;
}

export interface SessionListPage {
  sessions: SessionRecord[];
  nextCursor: SessionCursor | null;
}

export type TranscriptItem =
  | {
      kind: "assistant";
      seq: number;
      chunkOffset?: number;
      chunkStart?: number;
      turnId?: string;
      text: string;
      truncated: boolean;
      at: string;
    }
  | {
      kind: "tool";
      seq: number;
      turnId?: string;
      name: string;
      status: "running" | "completed" | "failed" | "canceled";
      at: string;
    }
  | { kind: "human"; seq: number; commandId: string | null; at: string };

export interface AgentPosition {
  seq: number;
  chunkOffset?: number;
}

export function compareAgentPosition(left: AgentPosition, right: AgentPosition): number {
  if (left.seq !== right.seq) return left.seq - right.seq;
  if (left.chunkOffset === right.chunkOffset) return 0;
  return (left.chunkOffset ?? Infinity) < (right.chunkOffset ?? Infinity) ? -1 : 1;
}
