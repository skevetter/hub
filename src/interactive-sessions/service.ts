import { ProductRequestError } from "../auth/organization-access.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { AuthServer } from "../auth/server.js";
import { DaemonAgentError, type AgentTimelinePage } from "../daemons/agents/index.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import type { QueryHandle } from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import { isTenantRouteNotFoundError, resolveRouteTenant } from "../projects/access.js";
import type { TimelineScrubber } from "../run-timeline/capture-types.js";
import { capabilities } from "./access.js";
import type { SessionEventBus } from "./bus.js";
import { SessionTranscriptNormalizer } from "./normalize.js";
import { commandCapability, profileValidation, validMessage } from "./store.js";
import type {
  CommandStatus,
  Delivery,
  ParticipantRole,
  RefusalCode,
  SessionCursor,
  SessionEventRecord,
  SessionMessageRecord,
  SessionPrincipal,
  SessionProfileRecord,
  SessionProfileSettings,
  SessionRecord,
  SessionWithParticipants,
  TranscriptItem,
} from "./types.js";

interface Scope {
  organizationSlug: string;
  sessionId: string;
}
export interface AgentCursor {
  epoch: string;
  seq: number;
}
export interface ListInput {
  organizationSlug: string;
  filter: "active" | "all";
  cursor: string | null;
}
export type HistoryInput = Scope & { before: AgentCursor | null; limit: number };
export type ParticipantInput = Scope & { userId: string; role: ParticipantRole | null };
export type SaveProfileForm = Omit<SessionProfileSettings, "providerOptions"> & {
  organizationSlug: string;
  id: string | null;
  version: number | null;
};

export interface StartCommand {
  profileId: string;
  profileVersion: number;
  message: string;
  participants: readonly { userId: string; role: ParticipantRole }[];
  idempotencyKey: string;
}

export interface ControlCommand {
  sessionId: string;
  generation: number;
  idempotencyKey: string;
}

export interface SendCommand extends ControlCommand {
  message: string;
  delivery: Delivery;
}

export type CommandInput = { organizationSlug: string } & (
  | ({ kind: "start" } & StartCommand)
  | ({ kind: "send" } & SendCommand)
  | ({ kind: "retry"; commandId: string } & ControlCommand)
  | ({ kind: "stop" | "close" | "replace" } & ControlCommand)
);

export interface SessionRefusal<Code extends string = RefusalCode> {
  outcome: "refused";
  code: Code;
}

export type CommandOutcome =
  | {
      outcome: "accepted";
      sessionId: string;
      commandId: string;
      status: CommandStatus;
      replayed: boolean;
    }
  | SessionRefusal;

export type ParticipantOutcome = { outcome: "accepted"; sessionId: string } | SessionRefusal;

export type ProfileSaveOutcome =
  | { outcome: "saved"; profile: ProfileView }
  | SessionRefusal<RefusalCode | "name_taken" | "invalid_profile">;

export type ProfileView = Omit<SessionProfileSettings, "providerOptions"> & {
  id: string;
  version: number;
  daemonSlug: string | null;
};

type TranscriptEntry = TranscriptItem & { seqStart: number; seqEnd: number };
type HistoryUnavailable = "daemon_offline" | "agent_missing" | "no_agent" | "history_unavailable";
export type HistoryPage =
  | {
      entries: TranscriptEntry[];
      epoch: string;
      startCursor: AgentCursor | null;
      endCursor: AgentCursor | null;
      hasOlder: boolean;
    }
  | { unavailable: HistoryUnavailable };

export type SessionSnapshot = Awaited<ReturnType<InteractiveSessionService["snapshot"]>>;
export type SessionListPage = Awaited<ReturnType<InteractiveSessionService["list"]>>;

export interface SessionCoordinator {
  start(principal: SessionPrincipal, input: StartCommand): Promise<CommandOutcome>;
  send(principal: SessionPrincipal, input: SendCommand): Promise<CommandOutcome>;
  retry(
    principal: SessionPrincipal,
    input: ControlCommand & { commandId: string },
  ): Promise<CommandOutcome>;
  stop(principal: SessionPrincipal, input: ControlCommand): Promise<CommandOutcome>;
  close(principal: SessionPrincipal, input: ControlCommand): Promise<CommandOutcome>;
  replaceAgent(principal: SessionPrincipal, input: ControlCommand): Promise<CommandOutcome>;
}

interface ServiceOptions {
  database: Database;
  pool: QueryHandle;
  auth: AuthServer;
  coordinator: SessionCoordinator;
  bus: SessionEventBus;
  connectionForDaemon(
    daemonId: string,
  ): Pick<DaemonConnection, "history" | "validateAgentConfiguration"> | undefined;
  scrub?: TimelineScrubber;
  scrubValues?: readonly string[];
  bodyCutoff: () => Date | null;
  now?: () => Date;
}

interface ParticipantView {
  userId: string;
  name: string;
  role: ParticipantRole;
}
type SessionAccess = SessionWithParticipants & { rights: ReturnType<typeof capabilities> };
type BrowserAccess = SessionPrincipal | "unauthorized" | "not_found";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export class SessionReadError extends Error {
  constructor(readonly code: "not_found" | "invalid_request") {
    super(code);
    this.name = "SessionReadError";
  }
}

export function sessionRefusal<Code extends string>(code: Code): SessionRefusal<Code> {
  return { outcome: "refused", code };
}

export function isSessionId(value: string): boolean {
  return UUID.test(value);
}

export class InteractiveSessionService {
  private readonly now: () => Date;
  private readonly transcript: SessionTranscriptNormalizer;

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.transcript = new SessionTranscriptNormalizer(options.scrubValues, options.scrub);
  }

  async snapshot(request: Request, input: Scope) {
    const principal = await this.requirePrincipal(request, input.organizationSlug);
    const access = await this.requireSession(principal, input.sessionId);
    const { session } = access;
    const messages = await this.options.database.listInteractiveSessionMessages(
      principal.organizationId,
      session.id,
      { beforeOrdinal: null, limit: 50 },
      this.options.bodyCutoff(),
    );
    const [names, attention] = await Promise.all([
      this.userNames([
        session.startedByUserId,
        ...access.participants.map(({ userId }) => userId),
        ...messages.map(({ authorUserId }) => authorUserId),
      ]),
      this.unconfirmedStops(principal.organizationId, [session]),
    ]);
    return {
      session: await this.sessionView(session, names, attention.has(session.id)),
      ...this.accessView(access, names),
      messages: messages.toReversed().map((message) => this.messageView(message, names)),
      hubSeq: session.hubSeq,
    };
  }

  async history(request: Request, input: HistoryInput): Promise<HistoryPage> {
    const principal = await this.requirePrincipal(request, input.organizationSlug);
    const { session } = await this.requireSession(principal, input.sessionId);
    const page = await this.agentHistory(session, {
      direction: input.before === null ? "tail" : "before",
      ...(input.before === null ? {} : { cursor: input.before }),
      limit: input.limit,
    });
    const current = await this.authorizeStream(request, input.organizationSlug, input.sessionId);
    if (
      typeof current === "string" ||
      current.userId !== principal.userId ||
      current.organizationId !== principal.organizationId
    )
      throw new SessionReadError("not_found");
    if ("unavailable" in page) return page;
    return {
      entries: this.transcript.historyEntries(page.entries),
      epoch: page.epoch,
      startCursor: page.startCursor,
      endCursor: page.endCursor,
      hasOlder: page.hasOlder,
    };
  }

  async list(request: Request, input: ListInput) {
    const principal = await this.requirePrincipal(request, input.organizationSlug);
    const page = await this.options.database.listInteractiveSessions(
      principal.organizationId,
      principal,
      {
        filter: input.filter,
        cursor: this.decodeListCursor(input.cursor),
        limit: 25,
      },
    );
    const [names, attention] = await Promise.all([
      this.userNames(page.sessions.map(({ startedByUserId }) => startedByUserId)),
      this.unconfirmedStops(principal.organizationId, page.sessions),
    ]);
    return {
      sessions: await Promise.all(
        page.sessions.map((session) => this.sessionView(session, names, attention.has(session.id))),
      ),
      nextCursor:
        page.nextCursor === null
          ? null
          : Buffer.from(
              JSON.stringify([page.nextCursor.lastActivityAt.toISOString(), page.nextCursor.id]),
            ).toString("base64url"),
    };
  }

  async command(request: Request, input: CommandInput): Promise<CommandOutcome> {
    const { coordinator } = this.options;
    const principal = await this.mutationPrincipal(request, input.organizationSlug);
    if (typeof principal === "string") return sessionRefusal(principal);
    if (input.kind === "start") {
      const { profileId, profileVersion, idempotencyKey, message, participants } = input;
      if (!validMessage(message)) return sessionRefusal("message_too_long");
      return coordinator.start(principal, {
        profileId,
        profileVersion,
        idempotencyKey,
        message,
        participants,
      });
    }

    const access = await this.sessionAccess(principal, input.sessionId);
    if (access === undefined) return sessionRefusal("not_found");
    const capability = commandCapability[input.kind === "send" ? "message" : input.kind];
    if (!access.rights[capability]) return sessionRefusal("forbidden");
    const control = {
      sessionId: access.session.id,
      generation: input.generation,
      idempotencyKey: input.idempotencyKey,
    };
    if (input.kind === "send") {
      if (!validMessage(input.message)) return sessionRefusal("message_too_long");
      return coordinator.send(principal, {
        ...control,
        message: input.message,
        delivery: input.delivery,
      });
    }
    if (input.kind === "retry")
      return coordinator.retry(principal, { ...control, commandId: input.commandId });
    if (input.kind === "replace") return coordinator.replaceAgent(principal, control);
    return coordinator[input.kind](principal, control);
  }

  async participants(request: Request, input: ParticipantInput): Promise<ParticipantOutcome> {
    const principal = await this.mutationPrincipal(request, input.organizationSlug);
    if (typeof principal === "string") return sessionRefusal(principal);
    const access = await this.sessionAccess(principal, input.sessionId);
    if (access === undefined) return sessionRefusal("not_found");
    if (!access.rights.manageParticipants) return sessionRefusal("forbidden");
    const sessionId = access.session.id;
    const result = await this.options.database.setInteractiveSessionParticipant({
      principal,
      sessionId,
      userId: input.userId,
      role: input.role,
      now: this.now(),
    });
    if (result !== "set" && result !== "removed")
      return sessionRefusal(result === "not_member" ? "invalid_participant" : result);
    this.options.bus.publish(sessionId, { kind: "access_changed" });
    return { outcome: "accepted", sessionId };
  }

  async profiles(request: Request, organizationSlug: string): Promise<ProfileView[]> {
    const principal = await this.requirePrincipal(request, organizationSlug);
    const profiles = await this.options.database.listSessionProfiles(principal.organizationId);
    return Promise.all(
      profiles
        .filter(
          ({ status }) => status === "active" || capabilitiesFor(principal.role).manageResources,
        )
        .map(async (profile) => {
          const daemon = await this.options.database.findDaemonForOrganization(
            principal.organizationId,
            profile.daemonId,
          );
          return this.profileView(profile, daemon?.slug ?? null);
        }),
    );
  }

  async saveProfile(request: Request, form: SaveProfileForm): Promise<ProfileSaveOutcome> {
    const principal = await this.mutationPrincipal(request, form.organizationSlug);
    if (typeof principal === "string") return sessionRefusal(principal);
    if (!capabilitiesFor(principal.role).manageResources) return sessionRefusal("forbidden");
    const { organizationSlug: _scope, ...profile } = form;
    const input = { ...profile, providerOptions: {}, principal, now: this.now() };
    const invalid = profileValidation(input);
    if (invalid !== undefined) return sessionRefusal(invalid);
    if (input.mode === "full" && !input.fullAccessAcknowledged)
      return sessionRefusal("invalid_mode");

    const { database } = this.options;
    const editRefusal = await this.profileEditRefusal(principal, input.id, input.version);
    if (editRefusal !== undefined) return sessionRefusal(editRefusal);
    const daemon = await database.findDaemonForOrganization(
      principal.organizationId,
      input.daemonId,
    );
    if (daemon?.status !== "active" || !daemon.permissions.includes("hub.execute"))
      return sessionRefusal("daemon_unavailable");
    if (!(await this.canUseDaemonForProfile(principal, daemon.registeredByCliCredentialId)))
      return sessionRefusal("forbidden");
    const connection = this.options.connectionForDaemon(daemon.id);
    if (!connection) return sessionRefusal("daemon_unavailable");
    let valid: boolean;
    try {
      ({ valid } = await connection.validateAgentConfiguration({
        provider: input.provider,
        model: input.model ?? undefined,
        mode: input.mode ?? undefined,
        thinkingOptionId: input.thinkingOptionId ?? undefined,
      }));
    } catch {
      return sessionRefusal("daemon_unavailable");
    }
    if (!valid) return sessionRefusal("invalid_mode");
    const saved = await database.saveSessionProfile(input);
    if (typeof saved === "string")
      return sessionRefusal(saved === "version_conflict" ? "profile_changed" : saved);
    return { outcome: "saved", profile: this.profileView(saved, daemon.slug) };
  }

  private async profileEditRefusal(
    { organizationId, role, userId }: SessionPrincipal,
    id: string | null,
    version: number | null,
  ): Promise<"profile_unavailable" | "forbidden" | "profile_changed" | undefined> {
    if (id === null) return version === null ? undefined : "profile_changed";
    const current = await this.options.database.findSessionProfile(organizationId, id);
    if (current === undefined) return "profile_unavailable";
    if (role !== "owner" && current.createdByUserId !== userId) return "forbidden";
    return current.version === version ? undefined : "profile_changed";
  }

  private async canUseDaemonForProfile(principal: SessionPrincipal, credentialId: string | null) {
    if (principal.role === "owner") return true;
    if (credentialId === null) return false;
    const { rows } = await this.options.pool.query<{ enrolled_by: string | null }>(
      `select created_by_user_id as enrolled_by
       from organization_cli_credentials where organization_id = $1 and id = $2`,
      [principal.organizationId, credentialId],
    );
    return rows[0]?.enrolled_by === principal.userId;
  }

  async authorizeStream(
    request: Request,
    organizationSlug: string,
    sessionId: string,
  ): Promise<BrowserAccess> {
    const principal = await this.principal(request, organizationSlug);
    if (typeof principal === "string") return principal;
    return (await this.sessionAccess(principal, sessionId)) === undefined ? "not_found" : principal;
  }

  streamEvents(principal: SessionPrincipal, sessionId: string, after: number, limit: number) {
    return this.options.database.listInteractiveSessionEvents(
      principal.organizationId,
      sessionId,
      after,
      limit,
    );
  }

  async streamEventData(principal: SessionPrincipal, event: SessionEventRecord) {
    switch (event.kind) {
      case "state":
        return event.data;
      case "delivery":
        return { commandId: event.commandId, ...event.data };
      case "participants": {
        const access = await this.requireSession(principal, event.sessionId);
        const names = await this.userNames(access.participants.map(({ userId }) => userId));
        return this.accessView(access, names);
      }
      case "message": {
        const [message] = await this.options.database.listInteractiveSessionMessages(
          principal.organizationId,
          event.sessionId,
          { beforeOrdinal: event.data.ordinal + 1, limit: 1 },
          this.options.bodyCutoff(),
        );
        if (message?.commandId !== event.commandId) return undefined;
        return this.messageView(message, await this.userNames([message.authorUserId]));
      }
      default:
        return undefined;
    }
  }

  async streamCatchUp(
    principal: SessionPrincipal,
    sessionId: string,
    cursor: AgentCursor,
  ): Promise<
    | { gap: "daemon_disconnected" | "epoch_changed" | "behind" }
    | { epoch: string; items: TranscriptItem[]; hasNewer: boolean }
  > {
    const { session } = await this.requireSession(principal, sessionId);
    const page = await this.agentHistory(session, { direction: "after", cursor, limit: 100 });
    if ("unavailable" in page)
      return { gap: page.unavailable === "daemon_offline" ? "daemon_disconnected" : "behind" };
    if (page.reset || page.staleCursor || page.gap || page.epoch !== cursor.epoch)
      return { gap: "epoch_changed" as const };
    // The daemon can return a full projected message that straddles a live text delta.
    // The client needs a fresh history page to place it without duplicating the prefix.
    if (
      page.entries.some(
        ({ item, seqStart, seqEnd }) =>
          item.type === "assistant_message" && seqStart <= cursor.seq && seqEnd > cursor.seq,
      )
    )
      return { gap: "behind" };
    return {
      epoch: page.epoch,
      items: this.transcript.historyEntries(page.entries),
      hasNewer: page.hasNewer,
    };
  }

  private async principal(request: Request, organizationSlug: string): Promise<BrowserAccess> {
    if (!request.headers.has("cookie") || request.headers.has("authorization"))
      return "unauthorized";
    try {
      const { account, tenant } = await resolveRouteTenant(
        this.options.auth,
        this.options.database,
        request,
        { organizationSlug },
      );
      return {
        organizationId: tenant.organization.id,
        userId: account.account.id,
        role: tenant.membership.role,
      };
    } catch (error) {
      if (isTenantRouteNotFoundError(error)) return "not_found";
      if (
        (error instanceof ProductRequestError && error.response().status === 401) ||
        (error instanceof Error && error.message === "unauthenticated")
      )
        return "unauthorized";
      throw error;
    }
  }

  private async requirePrincipal(
    request: Request,
    organizationSlug: string,
  ): Promise<SessionPrincipal> {
    const principal = await this.principal(request, organizationSlug);
    if (typeof principal === "string") throw new SessionReadError("not_found");
    return principal;
  }

  private async mutationPrincipal(request: Request, organizationSlug: string) {
    if (
      request.method !== "POST" ||
      this.options.auth.rejectCookieMutation(request, { requireOrigin: true })
    )
      return "forbidden" as const;
    const principal = await this.principal(request, organizationSlug);
    return principal === "unauthorized" ? ("not_found" as const) : principal;
  }

  private async sessionAccess(
    principal: SessionPrincipal,
    sessionId: string,
  ): Promise<SessionAccess | undefined> {
    if (!isSessionId(sessionId)) return undefined;
    const row = await this.options.database.findInteractiveSession(
      principal.organizationId,
      sessionId,
    );
    if (row === undefined) return undefined;
    const rights = capabilities(principal, row.session, row.participants);
    return rights.view ? { ...row, rights } : undefined;
  }

  private async requireSession(
    principal: SessionPrincipal,
    sessionId: string,
  ): Promise<SessionAccess> {
    const access = await this.sessionAccess(principal, sessionId);
    if (access === undefined) throw new SessionReadError("not_found");
    return access;
  }

  private async userNames(userIds: readonly (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const { rows } = await this.options.pool.query<{ id: string; name: string }>(
      'select id, name from "user" where id = any($1::text[])',
      [ids],
    );
    return new Map(rows.map(({ id, name }) => [id, name]));
  }

  private accessView({ rights, participants }: SessionAccess, names: Map<string, string>) {
    const { view: _view, ...visible } = rights;
    return {
      participants: participants.map(
        ({ userId, role }): ParticipantView => ({
          userId,
          role,
          name: names.get(userId) ?? "Unknown user",
        }),
      ),
      capabilities: visible,
    };
  }

  private async unconfirmedStops(
    organizationId: string,
    sessions: readonly SessionRecord[],
  ): Promise<Set<string>> {
    const running = sessions.filter(
      (session) => session.state === "running" && session.stateReason === null,
    );
    if (running.length === 0) return new Set();
    const { rows } = await this.options.pool.query<{ id: string }>(
      `select input.id
         from unnest($2::uuid[], $3::integer[]) as input(id, seq)
         join lateral (
           select event.data ->> 'stateReason' as reason
           from interactive_session_events event
           where event.organization_id = $1 and event.session_id = input.id
             and event.kind = 'state' and event.seq <= input.seq
           order by event.seq desc
           limit 1
         ) latest on latest.reason = 'stop_unconfirmed'`,
      [organizationId, running.map(({ id }) => id), running.map(({ hubSeq }) => hubSeq)],
    );
    return new Set(rows.map(({ id }) => id));
  }

  private async sessionView(
    session: SessionRecord,
    names: Map<string, string>,
    stopUnconfirmed: boolean,
  ) {
    const { database } = this.options;
    const [profile, daemon] = await Promise.all([
      database.findSessionProfile(session.organizationId, session.profileId),
      database.findDaemonForOrganization(session.organizationId, session.daemonId),
    ]);
    const startedByName =
      session.startedByUserId === null ? undefined : names.get(session.startedByUserId);
    return {
      id: session.id,
      title: session.title,
      state: session.state,
      stateReason: stopUnconfirmed ? ("stop_unconfirmed" as const) : session.stateReason,
      generation: session.generation,
      turn: session.turn,
      profile: { id: session.profileId, name: profile?.name ?? session.title },
      daemon: {
        id: session.daemonId,
        slug: daemon?.slug ?? "",
        connection:
          daemon?.status === "active" && this.options.connectionForDaemon(daemon.id)
            ? ("online" as const)
            : ("offline" as const),
      },
      provider: session.launch.provider,
      model: session.launch.model,
      mode: session.launch.mode,
      startedBy:
        session.startedByUserId !== null && startedByName !== undefined
          ? { userId: session.startedByUserId, name: startedByName }
          : null,
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
    };
  }

  private messageView(message: SessionMessageRecord, names: Map<string, string>) {
    const {
      commandId,
      ordinal,
      authorUserId,
      delivery,
      status,
      body,
      expired,
      createdAt,
      retryable,
    } = message;
    return {
      commandId,
      ordinal,
      delivery,
      status,
      text: body,
      expired,
      retryable,
      createdAt: createdAt.toISOString(),
      authorName: (authorUserId === null ? undefined : names.get(authorUserId)) ?? "Unknown user",
    };
  }

  private profileView(profile: SessionProfileRecord, daemonSlug: string | null): ProfileView {
    const {
      id,
      version,
      name,
      daemonId,
      cwd,
      worktree,
      provider,
      model,
      mode,
      thinkingOptionId,
      fullAccessAcknowledged,
      status,
    } = profile;
    return {
      id,
      version,
      name,
      daemonId,
      daemonSlug,
      cwd,
      worktree,
      provider,
      model,
      mode,
      thinkingOptionId,
      fullAccessAcknowledged,
      status,
    };
  }

  private decodeListCursor(value: string | null): SessionCursor | null {
    if (value === null) return null;
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new SessionReadError("invalid_request");
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SessionReadError("invalid_request");
    }
    if (!Array.isArray(decoded) || decoded.length !== 2)
      throw new SessionReadError("invalid_request");
    const timestamp: unknown = decoded[0];
    const id: unknown = decoded[1];
    if (typeof timestamp !== "string" || typeof id !== "string" || !isSessionId(id))
      throw new SessionReadError("invalid_request");
    const lastActivityAt = new Date(timestamp);
    if (!Number.isFinite(lastActivityAt.getTime()) || lastActivityAt.toISOString() !== timestamp)
      throw new SessionReadError("invalid_request");
    return { lastActivityAt, id };
  }

  private async agentHistory(
    session: SessionRecord,
    query: Parameters<NonNullable<DaemonConnection["history"]>["timeline"]>[1],
  ): Promise<AgentTimelinePage | { unavailable: HistoryUnavailable }> {
    if (session.daemonAgentId === null) return { unavailable: "no_agent" };
    if (session.stateReason === "agent_missing") return { unavailable: "agent_missing" };
    const connection = this.options.connectionForDaemon(session.daemonId);
    if (connection === undefined) return { unavailable: "daemon_offline" };
    if (connection.history === undefined) return { unavailable: "history_unavailable" };
    try {
      return await connection.history.timeline(session.daemonAgentId, query);
    } catch (error) {
      if (!this.options.connectionForDaemon(session.daemonId))
        return { unavailable: "daemon_offline" };
      return {
        unavailable:
          error instanceof DaemonAgentError &&
          (error.code === "agent_not_found" || error.code === "agent_missing")
            ? "agent_missing"
            : "history_unavailable",
      };
    }
  }
}
