import { isCurrentSurfaceRequester } from "../surfaces/postgres-store.js";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Locks } from "../db/runtime/locks/index.js";
import type {
  DatabaseRuntime,
  DrizzleHandle,
  QueryHandle,
  TransactionHandle,
} from "../db/runtime/index.js";
import {
  auditEvents,
  daemons,
  interactiveSessionCommands as commands,
  interactiveSessionEvents as events,
  interactiveSessionParticipants as participants,
  interactiveSessionProfiles as profiles,
  interactiveSessions as sessions,
  members,
  organizationCliCredentials as cliCredentials,
} from "../db/schema.js";
import type { ConsumeOrganizationUsageInput, OrganizationUsageRecord } from "../db/types.js";
import { capabilities } from "./access.js";
import {
  advanceForCommand,
  claimPatch,
  canRetryMessage,
  closeLinearPilotSession,
  exhaustedControlState,
  finalDeliveryCode,
  retryMessagePatch,
  commandCapability,
  commandHash,
  commandLeaseEligible,
  commandRefusal,
  sendRateCutoff,
  deliveryEvent,
  messageEvent,
  messageRecord,
  matchesLinearPilotRetirement,
  newCommand,
  newSession,
  observedSessionTransition,
  interruptCommand,
  profileRecord,
  profileSettings,
  profileValidation,
  profileVersionMatches,
  refused,
  replayCommand,
  sessionAudit,
  sessionPage,
  sessionUsage,
  settlePatch,
  startHash,
  canStartSessionAs,
  startParticipants,
  stateEvent,
  unsettledStatuses,
  validMessage,
} from "./store.js";
import type {
  AcceptCommandInput,
  AcceptCommandResult,
  ApplySessionStateInput,
  BindSessionAgentInput,
  ClaimCommandInput,
  InteractiveSessionStore,
  RetireLinearPilotSessionInput,
  SaveSessionProfileInput,
  SaveSessionProfileResult,
  SessionEventDraft,
  SessionPageInput,
  SetParticipantInput,
  SetParticipantResult,
  SettleCommandInput,
  StartSessionInput,
  StartSessionResult,
} from "./store.js";
import type {
  SessionAuditRecord,
  SessionCommandRecord,
  SessionEventRecord,
  SessionParticipantRecord,
  SessionPrincipal,
  StoredSessionProfile,
  SessionRecord,
} from "./types.js";

const { body: _body, ...commandColumnsWithoutBody } = getTableColumns(commands);

export class InteractiveSessionRepository implements InteractiveSessionStore {
  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
    private readonly reserveUsage: (
      tx: QueryHandle,
      input: ConsumeOrganizationUsageInput,
    ) => Promise<OrganizationUsageRecord | undefined>,
  ) {}

  listSessionProfiles(organizationId: string) {
    return this.runtime
      .drizzle()
      .select()
      .from(profiles)
      .where(eq(profiles.organizationId, organizationId))
      .orderBy(asc(profiles.name), asc(profiles.id));
  }

  async findSessionProfile(organizationId: string, id: string) {
    const [profile] = await this.runtime
      .drizzle()
      .select()
      .from(profiles)
      .where(and(eq(profiles.organizationId, organizationId), eq(profiles.id, id)));
    return profile;
  }

  saveSessionProfile(input: SaveSessionProfileInput): Promise<SaveSessionProfileResult> {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const { organizationId, userId } = input.principal;
      const settings = profileSettings(input);
      const invalid = profileValidation(input);
      if (invalid) return invalid;
      const role = await this.role(db, organizationId, userId);
      if (role === undefined || role === "member") return "forbidden";

      await this.locks.withTxLock(tx, "isession-profiles:" + organizationId);
      const current =
        input.id === null ? undefined : await this.lockProfile(db, organizationId, input.id);
      if (!profileVersionMatches(input, current)) return "version_conflict";
      if (current && role !== "owner" && current.createdByUserId !== userId) return "forbidden";

      const [daemon] = await db
        .select({
          status: daemons.status,
          permissions: daemons.permissions,
          enrolledBy: cliCredentials.createdByUserId,
        })
        .from(daemons)
        .leftJoin(
          cliCredentials,
          and(
            eq(cliCredentials.id, daemons.registeredByCliCredentialId),
            eq(cliCredentials.organizationId, organizationId),
          ),
        )
        .where(and(eq(daemons.organizationId, organizationId), eq(daemons.id, input.daemonId)))
        .for("share", { of: daemons });
      if (daemon?.status !== "active" || !daemon.permissions.includes("hub.execute"))
        return "daemon_unavailable";
      // Personal CLI enrollment proves who enrolled the daemon. Legacy and shared-key enrollments require the owner.
      if (role !== "owner" && daemon.enrolledBy !== userId) return "forbidden";

      const {
        rows: [options],
      } = await tx.query<{ size: number }>("select octet_length($1::jsonb::text) as size", [
        JSON.stringify(settings.providerOptions),
      ]);
      if (options === undefined || options.size > 4096) return "invalid_profile";

      const [named] = await db
        .select({ id: profiles.id })
        .from(profiles)
        .where(and(eq(profiles.organizationId, organizationId), eq(profiles.name, input.name)));
      if (named && named.id !== current?.id) return "name_taken";
      if (current) {
        const [saved] = await db
          .update(profiles)
          .set({
            ...settings,
            maxActive: input.maxActive,
            linearTemplate: input.linearTemplate,
            version: current.version + 1,
            updatedAt: input.now,
          })
          .where(and(eq(profiles.organizationId, organizationId), eq(profiles.id, current.id)))
          .returning();
        return saved!;
      }
      const [created] = await db
        .insert(profiles)
        .values(profileRecord(input, settings))
        .returning();
      return created!;
    });
  }

  startInteractiveSession(input: StartSessionInput): Promise<StartSessionResult> {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const { organizationId, userId } = input.principal;
      const requested = startParticipants(input);
      const hash = startHash(input, requested);
      const key = input.idempotencyKey.toLowerCase();
      await this.locks.withTxLock(
        tx,
        "isession-start:" + JSON.stringify([organizationId, userId, key]),
      );
      const currentRole = await this.role(db, organizationId, userId);
      const requester = input.nativeRequester;
      if (!canStartSessionAs(input, currentRole)) return refused("forbidden");
      if (
        requester &&
        !(await isCurrentSurfaceRequester(
          db,
          { organizationId, workspaceId: requester.workspaceId, userId },
          requester.identityId,
        ))
      )
        return refused("forbidden");
      const [prior] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.organizationId, organizationId),
            eq(sessions.startedByUserId, userId),
            eq(sessions.startIdempotencyKey, key),
          ),
        )
        .for("share");
      if (prior) {
        if (!(await this.rights(db, prior, userId))?.view) return refused("forbidden");
        if (prior.startRequestHash !== hash) return refused("idempotency_conflict");
        const [command] = await db
          .select()
          .from(commands)
          .where(and(commandScope(prior), eq(commands.ordinal, 1)));
        return {
          status: "replayed",
          session: prior,
          command: replayCommand(command!, input.bodyCutoff),
        };
      }
      if (!validMessage(input.message)) return refused("message_too_long");
      const [profile] = await db
        .select()
        .from(profiles)
        .where(and(eq(profiles.organizationId, organizationId), eq(profiles.id, input.profileId)))
        .for("share");
      if (profile?.status !== "active") return refused("profile_unavailable");
      if (profile.version !== input.profileVersion) return refused("profile_changed");
      if (requester && profile.createdByUserId !== userId) return refused("forbidden");
      const capacity = await this.startCapacity(tx, profile, input);
      if (capacity) return refused(capacity);
      const people = await db
        .select({ userId: members.userId })
        .from(members)
        .where(
          and(
            eq(members.organizationId, organizationId),
            inArray(
              members.userId,
              requested.map((person) => person.userId),
            ),
          ),
        )
        .for("share");
      if (people.length !== requested.length) return refused("invalid_participant");
      if (!(await this.reserveUsage(tx, sessionUsage(input.principal, input.usage))))
        return refused("usage_limit");

      const session = newSession(input, profile, hash);
      const command = newCommand(session, input, "message", "steer", input.message, hash);
      await db.insert(sessions).values(session);
      await db.insert(participants).values(
        requested.map(({ userId: participantId, role }) => ({
          userId: participantId,
          role,
          organizationId,
          sessionId: session.id,
          addedByUserId: userId,
          createdAt: input.now,
        })),
      );
      await db.insert(commands).values(command);
      const stored = await this.append(db, session, input.now, [
        stateEvent(session),
        messageEvent(command),
      ]);
      await this.audit(
        db,
        session,
        userId,
        "started",
        { profileId: profile.id, commandId: command.id },
        input.now,
      );
      return { status: "created", session: stored, command };
    });
  }

  acceptInteractiveSessionCommand(input: AcceptCommandInput): Promise<AcceptCommandResult> {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const { organizationId, userId } = input.principal;
      const session = await this.lockSession(db, organizationId, input.sessionId);
      if (!session) return refused("not_found");
      const rights = await this.rights(db, session, userId);
      const allowed = rights?.[commandCapability[input.kind]];
      if (!rights?.view && !allowed) return refused("not_found");
      if (!allowed) return refused("forbidden");
      if (input.kind === "retry") return this.rearmMessage(db, session, input);
      const hash = commandHash(input);
      const [prior] = await db
        .select()
        .from(commands)
        .where(
          and(
            commandScope(session),
            eq(commands.authorUserId, userId),
            eq(commands.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (prior) {
        return prior.requestHash === hash
          ? { status: "replayed", session, command: replayCommand(prior, input.bodyCutoff) }
          : refused("idempotency_conflict");
      }
      if (input.kind !== "close" && !(await this.activeSessionDaemon(db, session)))
        return refused("daemon_unavailable");
      const refusal = commandRefusal(session, input);
      if (refusal) return refused(refusal);
      if (input.kind === "message") {
        const [recent] = await db
          .select({ count: count() })
          .from(commands)
          .where(
            and(
              commandScope(session),
              eq(commands.kind, "message"),
              eq(commands.authorUserId, userId),
              gt(commands.createdAt, sendRateCutoff(input.now)),
            ),
          );
        if (recent!.count >= input.maxMessagesPerMinute) return refused("rate_limited");
        if ((await this.queuedMessageCount(db, session)) >= input.maxQueued)
          return refused("queue_full");
        if (!(await this.reserveUsage(tx, sessionUsage(input.principal, input.usage))))
          return refused("usage_limit");
      }

      const next = advanceForCommand(session, input);
      const command = newCommand(
        next,
        input,
        input.kind,
        input.kind === "message" ? input.delivery : null,
        input.kind === "message" ? input.message : null,
        hash,
      );
      const drafts: SessionEventDraft[] = [];
      if (input.kind === "message") {
        drafts.push(messageEvent(command));
      } else {
        drafts.push(
          stateEvent(next),
          ...(await this.supersede(db, session, input.kind, input.now)),
        );
      }
      await db.insert(commands).values(command);
      const stored = await this.append(db, next, input.now, drafts);
      await this.audit(db, session, userId, input.kind, { commandId: command.id }, input.now);
      return { status: "accepted", session: stored, command };
    });
  }

  async listInteractiveSessions(
    organizationId: string,
    viewer: SessionPrincipal,
    page: SessionPageInput,
  ) {
    if (viewer.organizationId !== organizationId) return sessionPage([], page.limit);
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const role = await this.role(db, organizationId, viewer.userId);
      if (!role) return sessionPage([], page.limit);
      const participates = exists(
        db
          .select({ userId: participants.userId })
          .from(participants)
          .where(
            and(
              eq(participants.organizationId, organizationId),
              eq(participants.sessionId, sessions.id),
              eq(participants.userId, viewer.userId),
            ),
          ),
      );
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.organizationId, organizationId),
            page.filter === "active" ? ne(sessions.state, "closed") : undefined,
            page.cursor
              ? sql`(${sessions.lastActivityAt}, ${sessions.id}) < (${page.cursor.lastActivityAt.toISOString()}::timestamptz, ${page.cursor.id}::uuid)`
              : undefined,
            or(
              and(eq(sessions.origin, "web"), role === "member" ? participates : undefined),
              role === "owner"
                ? and(
                    eq(sessions.origin, "linear"),
                    eq(sessions.startedByUserId, viewer.userId),
                    participates,
                  )
                : undefined,
            ),
          ),
        )
        .orderBy(desc(sessions.lastActivityAt), desc(sessions.id))
        .limit(page.limit + 1);
      return sessionPage(rows, page.limit);
    });
  }

  findInteractiveSession(organizationId: string, sessionId: string) {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const [session] = await db
        .select()
        .from(sessions)
        .where(sessionScope(organizationId, sessionId))
        .for("share");
      if (!session) return undefined;
      return { session, participants: await this.participants(db, session) };
    });
  }

  async listInteractiveSessionMessages(
    organizationId: string,
    sessionId: string,
    page: { beforeOrdinal: number | null; limit: number },
    bodyCutoff: Date | null,
  ) {
    const body =
      bodyCutoff === null
        ? commands.body
        : sql<
            string | null
          >`case when ${commands.createdAt} >= ${bodyCutoff.toISOString()}::timestamptz then ${commands.body} end`;
    const rows = await this.runtime
      .drizzle()
      .select({ ...commandColumnsWithoutBody, body })
      .from(commands)
      .where(
        and(
          eq(commands.organizationId, organizationId),
          eq(commands.sessionId, sessionId),
          eq(commands.kind, "message"),
          page.beforeOrdinal === null ? undefined : lt(commands.ordinal, page.beforeOrdinal),
        ),
      )
      .orderBy(desc(commands.ordinal))
      .limit(page.limit);
    return rows.map((command) => messageRecord(command, bodyCutoff));
  }

  async listInteractiveSessionEvents(
    organizationId: string,
    sessionId: string,
    afterSeq: number,
    limit: number,
  ) {
    const rows = await this.runtime
      .drizzle()
      .select()
      .from(events)
      .where(
        and(
          eq(events.organizationId, organizationId),
          eq(events.sessionId, sessionId),
          gt(events.seq, afterSeq),
        ),
      )
      .orderBy(asc(events.seq))
      .limit(limit);
    return rows.map(readEvent);
  }

  claimInteractiveSessionCommand(input: ClaimCommandInput) {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const session = await this.lockSession(db, input.organizationId, input.sessionId);
      if (!session || session.state === "failed") return undefined;
      if (!(await this.activeSessionDaemon(db, session))) return undefined;
      const candidates = await db
        .select()
        .from(commands)
        .where(
          and(
            commandScope(session),
            eq(commands.generation, session.generation),
            inArray(commands.status, unsettledStatuses),
            input.lane === "message" ? eq(commands.kind, "message") : undefined,
            input.lane === "control" ? ne(commands.kind, "message") : undefined,
            session.state === "closed" ? eq(commands.kind, "close") : undefined,
          ),
        )
        .orderBy(asc(commands.ordinal))
        .for("update");
      const leaseNow = await leaseTime(tx);
      const drafts: SessionEventDraft[] = [];
      let nextSession: SessionRecord = session;
      let claimed: SessionCommandRecord | undefined;
      if (
        !candidates.some(
          (command) =>
            command.status === "dispatching" &&
            command.claimExpiresAt !== null &&
            command.claimExpiresAt > leaseNow,
        )
      ) {
        for (const command of candidates) {
          if (!commandLeaseEligible(command, input, session.state, leaseNow)) continue;
          const rights = await this.rights(db, session, command.authorUserId);
          const patch = claimPatch(command, input, rights, leaseNow);
          const updated = await this.updateCommand(db, command, patch);
          drafts.push(deliveryEvent(updated));
          if (updated.status === "dispatching") {
            claimed = updated;
            break;
          }
          nextSession = exhaustedControlState(session, updated, input.now);
          if (nextSession !== session) {
            drafts.push(
              stateEvent(
                nextSession,
                nextSession.state === "running" ? "stop_unconfirmed" : nextSession.stateReason,
              ),
            );
            if (nextSession.state === "closed")
              drafts.push(...(await this.supersede(db, nextSession, "close", input.now)));
            break;
          }
        }
      }
      if (drafts.length > 0) await this.append(db, nextSession, input.now, drafts);
      return claimed;
    });
  }

  settleInteractiveSessionCommand(input: SettleCommandInput) {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const session = await this.lockSession(db, input.organizationId, input.sessionId);
      if (!session || session.generation !== input.generation) return false;
      const [command] = await db
        .select()
        .from(commands)
        .where(
          and(
            commandScope(session),
            eq(commands.id, input.commandId),
            eq(commands.generation, input.generation),
            eq(commands.status, "dispatching"),
            eq(commands.claimOwner, input.claimOwner),
            eq(commands.attempts, input.attempts),
          ),
        )
        .for("update");
      if (!command?.claimExpiresAt || command.claimExpiresAt <= (await leaseTime(tx))) return false;
      const updated = await this.updateCommand(
        db,
        command,
        settlePatch(input.status, input.now, finalDeliveryCode(command, input)),
      );
      const next =
        input.status === "unknown" || input.status === "failed"
          ? exhaustedControlState(session, updated, input.now)
          : session;
      const drafts = [deliveryEvent(updated)];
      if (next !== session) {
        drafts.push(
          stateEvent(next, next.state === "running" ? "stop_unconfirmed" : next.stateReason),
        );
        if (next.state === "closed")
          drafts.push(...(await this.supersede(db, next, "close", input.now)));
      }
      await this.append(db, next, input.now, drafts);
      return true;
    });
  }

  bindInteractiveSessionAgent(input: BindSessionAgentInput) {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const session = await this.lockSession(db, input.organizationId, input.sessionId);
      if (session?.generation !== input.generation || session.state !== "starting") return false;
      if (session.daemonAgentId !== null) {
        return (
          session.daemonAgentId === input.agentId && session.daemonWorkspaceId === input.workspaceId
        );
      }
      const next = {
        ...session,
        daemonAgentId: input.agentId,
        daemonWorkspaceId: input.workspaceId,
      };
      await this.append(db, next, input.now, [stateEvent(next)]);
      return true;
    });
  }

  applyInteractiveSessionState(input: ApplySessionStateInput) {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const session = await this.lockSession(db, input.organizationId, input.sessionId);
      if (!session) return undefined;
      if (input.to === "closed") return this.retireLinearPilotSession(db, session, input);
      const next = observedSessionTransition(session, input);
      if (!next) return undefined;
      if (
        next.state === session.state &&
        next.stateReason === session.stateReason &&
        next.turn === session.turn
      )
        return session;
      const drafts = [stateEvent(next)];
      if (input.reason === "daemon_revoked")
        drafts.push(...(await this.supersede(db, session, "close", input.now)));
      return this.append(db, next, input.now, drafts);
    });
  }

  private async retireLinearPilotSession(
    db: DrizzleHandle,
    session: SessionRecord,
    input: RetireLinearPilotSessionInput,
  ): Promise<SessionRecord | undefined> {
    const { organizationId, ownerUserId, workspaceId, profileId } = input;
    if (
      !matchesLinearPilotRetirement(session, input) ||
      (await this.role(db, organizationId, ownerUserId)) !== "owner" ||
      !(await isCurrentSurfaceRequester(
        db,
        { organizationId, workspaceId, userId: ownerUserId },
        session.requesterIdentityId,
      ))
    )
      return undefined;

    const [profile] = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.organizationId, organizationId), eq(profiles.id, profileId)))
      .for("share");
    const [command] = await db
      .select({
        id: commands.id,
        ordinal: commands.ordinal,
        kind: commands.kind,
        status: commands.status,
        authorUserId: commands.authorUserId,
        generation: commands.generation,
      })
      .from(commands)
      .where(and(commandScope(session), eq(commands.ordinal, 1)))
      .for("share");
    const next = closeLinearPilotSession(session, input, profile, command);
    return next ? this.append(db, next, input.now, [stateEvent(next)]) : undefined;
  }

  setInteractiveSessionParticipant(input: SetParticipantInput): Promise<SetParticipantResult> {
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const { organizationId, userId } = input.principal;
      const session = await this.lockSession(db, organizationId, input.sessionId);
      if (!session) return "not_found";
      const people = await this.participants(db, session);
      const rights = await this.rights(db, session, userId, people);
      if (!rights?.view) return "not_found";
      if (!rights.manageParticipants) return "forbidden";
      if (input.role !== null && !(await this.role(db, organizationId, input.userId)))
        return "not_member";
      const current = people.find((person) => person.userId === input.userId);
      if ((current?.role ?? null) === input.role) return input.role === null ? "removed" : "set";
      if (current?.role === "controller" && input.role !== "controller") {
        const others = people.filter(
          (person) => person.role === "controller" && person.userId !== input.userId,
        );
        const remaining =
          others.length === 0
            ? []
            : await db
                .select({ id: members.id })
                .from(members)
                .where(
                  and(
                    eq(members.organizationId, organizationId),
                    inArray(
                      members.userId,
                      others.map((person) => person.userId),
                    ),
                  ),
                )
                .for("share");
        if (remaining.length === 0) return "last_controller";
      }
      if (input.role === null) {
        await db
          .delete(participants)
          .where(
            and(
              eq(participants.organizationId, organizationId),
              eq(participants.sessionId, session.id),
              eq(participants.userId, input.userId),
            ),
          );
      } else {
        await db
          .insert(participants)
          .values({
            organizationId,
            sessionId: session.id,
            userId: input.userId,
            role: input.role,
            addedByUserId: userId,
            createdAt: input.now,
          })
          .onConflictDoUpdate({
            target: [participants.sessionId, participants.userId],
            set: { role: input.role, addedByUserId: userId },
          });
      }
      const data = { userId: input.userId, role: input.role };
      await this.append(db, session, input.now, [{ kind: "participants", commandId: null, data }]);
      await this.audit(db, session, userId, "participant_changed", data, input.now);
      return input.role === null ? "removed" : "set";
    });
  }

  listRecoverableInteractiveSessions(organizationId: string, daemonId: string | null) {
    return this.runtime
      .drizzle()
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, organizationId),
          ne(sessions.state, "closed"),
          daemonId === null ? undefined : eq(sessions.daemonId, daemonId),
        ),
      )
      .orderBy(asc(sessions.id));
  }

  async expireInteractiveSessionMessageBodies(cutoff: Date, limit: number, now: Date) {
    const result = await this.runtime.query(
      `with batch as (
         select id, organization_id from interactive_session_commands
         where body is not null and created_at < $1
         order by created_at, id limit $2 for update skip locked
       )
       update interactive_session_commands c
       set body = null, body_expired_at = $3, updated_at = greatest(c.updated_at, $3)
       from batch where c.id = batch.id and c.organization_id = batch.organization_id`,
      [cutoff, limit, now],
    );
    return result.rowCount;
  }

  private async startCapacity(
    tx: TransactionHandle,
    profile: StoredSessionProfile,
    input: StartSessionInput,
  ): Promise<"daemon_unavailable" | "active_limit" | undefined> {
    const { organizationId } = input.principal;
    const db = tx.drizzle();
    await this.locks.withTxLock(tx, "isession-daemon:" + profile.daemonId);
    const [daemon] = await db
      .select({
        status: daemons.status,
        presence: daemons.presence,
        permissions: daemons.permissions,
      })
      .from(daemons)
      .where(and(eq(daemons.organizationId, organizationId), eq(daemons.id, profile.daemonId)))
      .for("share");
    if (
      daemon?.status !== "active" ||
      daemon.presence !== "connected" ||
      !daemon.permissions.includes("hub.execute")
    ) {
      return "daemon_unavailable";
    }

    const [active] = await db
      .select({ count: count() })
      .from(sessions)
      .where(
        and(
          eq(sessions.organizationId, organizationId),
          eq(sessions.daemonId, profile.daemonId),
          ne(sessions.state, "closed"),
        ),
      );
    if (active!.count >= input.maxActivePerDaemon) return "active_limit";
    if (input.nativeRequester) {
      const [profileActive] = await db
        .select({ count: count() })
        .from(sessions)
        .where(
          and(
            eq(sessions.organizationId, organizationId),
            eq(sessions.profileId, profile.id),
            ne(sessions.state, "closed"),
          ),
        );
      if (profileActive!.count >= profile.maxActive) return "active_limit";
    }
    return undefined;
  }

  private async lockProfile(db: DrizzleHandle, organizationId: string, profileId: string) {
    const [profile] = await db
      .select()
      .from(profiles)
      .where(and(eq(profiles.organizationId, organizationId), eq(profiles.id, profileId)))
      .for("update");
    return profile;
  }

  private async lockSession(db: DrizzleHandle, organizationId: string, sessionId: string) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(sessionScope(organizationId, sessionId))
      .for("update");
    return session;
  }

  private participants(db: DrizzleHandle, session: SessionRecord) {
    return db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.organizationId, session.organizationId),
          eq(participants.sessionId, session.id),
        ),
      )
      .orderBy(asc(participants.userId));
  }

  private async role(db: DrizzleHandle, organizationId: string, userId: string) {
    const [member] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
      .for("share");
    const role = member?.role;
    return role === "owner" || role === "admin" || role === "member" ? role : undefined;
  }

  private async rights(
    db: DrizzleHandle,
    session: SessionRecord,
    userId: string | null,
    people?: SessionParticipantRecord[],
  ) {
    if (userId === null) return undefined;
    const role = await this.role(db, session.organizationId, userId);
    if (!role) return undefined;
    return capabilities(
      { userId, organizationId: session.organizationId, role },
      session,
      people ?? (await this.participants(db, session)),
    );
  }

  private async updateCommand(
    db: DrizzleHandle,
    command: SessionCommandRecord,
    patch: Partial<SessionCommandRecord>,
  ) {
    const [row] = await db
      .update(commands)
      .set(patch)
      .where(
        and(
          eq(commands.organizationId, command.organizationId),
          eq(commands.sessionId, command.sessionId),
          eq(commands.id, command.id),
        ),
      )
      .returning();
    return row!;
  }

  private async supersede(
    db: DrizzleHandle,
    session: SessionRecord,
    kind: "stop" | "close" | "replace",
    now: Date,
  ) {
    const pending = await db
      .select()
      .from(commands)
      .where(
        and(
          commandScope(session),
          eq(commands.generation, session.generation),
          inArray(commands.status, unsettledStatuses),
        ),
      )
      .orderBy(asc(commands.ordinal))
      .for("update");
    const drafts: SessionEventDraft[] = [];
    for (const command of pending) {
      const patch = interruptCommand(command, kind, now);
      if (patch) drafts.push(deliveryEvent(await this.updateCommand(db, command, patch)));
    }
    return drafts;
  }

  private async append(
    db: DrizzleHandle,
    session: SessionRecord,
    now: Date,
    drafts: readonly SessionEventDraft[],
  ) {
    const [stored] = await db
      .update(sessions)
      .set({
        state: session.state,
        stateReason: session.stateReason,
        generation: session.generation,
        turn: session.turn,
        daemonAgentId: session.daemonAgentId,
        daemonWorkspaceId: session.daemonWorkspaceId,
        closedAt: session.closedAt,
        closedByUserId: session.closedByUserId,
        commandSeq: session.commandSeq,
        hubSeq: sql`${sessions.hubSeq} + ${drafts.length}`,
        lastActivityAt: sql`greatest(${sessions.lastActivityAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: sql`greatest(${sessions.updatedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(sessionScope(session.organizationId, session.id))
      .returning();
    await db.insert(events).values(
      drafts.map((event, index) => ({
        ...event,
        organizationId: session.organizationId,
        sessionId: session.id,
        seq: stored!.hubSeq - drafts.length + index + 1,
        at: now,
      })),
    );
    return stored!;
  }

  private async rearmMessage(
    db: DrizzleHandle,
    session: SessionRecord,
    input: Extract<AcceptCommandInput, { kind: "retry" }>,
  ): Promise<AcceptCommandResult> {
    const userId = input.principal.userId;
    const retryKey = input.idempotencyKey.toLowerCase();
    const requestHash = commandHash(input);
    const [prior] = await db
      .select({ requestHash: sql<string>`${auditEvents.evidence}->>'requestHash'` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, session.organizationId),
          eq(auditEvents.subjectType, "interactive_session"),
          eq(auditEvents.subjectId, session.id),
          eq(auditEvents.actorKind, "user"),
          eq(auditEvents.actorIdentity, userId),
          eq(auditEvents.action, "interactive_session.retry"),
          sql`${auditEvents.evidence}->>'retryKey' = ${retryKey}`,
        ),
      )
      .limit(1);
    if (prior && prior.requestHash !== requestHash) return refused("idempotency_conflict");
    if (!prior) {
      if (!(await this.activeSessionDaemon(db, session))) return refused("daemon_unavailable");
      const refusal = commandRefusal(session, input);
      if (refusal) return refused(refusal);
    }
    const [original] = await db
      .select()
      .from(commands)
      .where(
        and(
          commandScope(session),
          eq(commands.id, input.commandId),
          eq(commands.authorUserId, userId),
          eq(commands.generation, input.generation),
          eq(commands.kind, "message"),
        ),
      )
      .for("update");
    if (!original) return refused("not_retryable");
    if (prior)
      return { status: "replayed", session, command: replayCommand(original, input.bodyCutoff) };
    if (!canRetryMessage(original, input.bodyCutoff)) return refused("not_retryable");
    if ((await this.queuedMessageCount(db, session)) >= input.maxQueued)
      return refused("queue_full");
    const command = await this.updateCommand(db, original, retryMessagePatch(original, input.now));
    const stored = await this.append(db, session, input.now, [deliveryEvent(command)]);
    await this.audit(
      db,
      session,
      userId,
      "retry",
      { commandId: command.id, retryKey, requestHash },
      input.now,
    );
    return { status: "accepted", session: stored, command };
  }

  private async queuedMessageCount(db: DrizzleHandle, session: SessionRecord): Promise<number> {
    const [queued] = await db
      .select({ count: count() })
      .from(commands)
      .where(
        and(
          commandScope(session),
          eq(commands.generation, session.generation),
          eq(commands.kind, "message"),
          inArray(commands.status, unsettledStatuses),
          sql`${commands.failureCode} is distinct from 'delivery_unconfirmed'`,
        ),
      );
    return queued!.count;
  }

  private async activeSessionDaemon(db: DrizzleHandle, session: SessionRecord): Promise<boolean> {
    const [daemon] = await db
      .select({ status: daemons.status, permissions: daemons.permissions })
      .from(daemons)
      .where(
        and(eq(daemons.id, session.daemonId), eq(daemons.organizationId, session.organizationId)),
      )
      .for("share");
    return daemon?.status === "active" && daemon.permissions.includes("hub.execute");
  }

  private async audit(
    db: DrizzleHandle,
    session: SessionRecord,
    actorIdentity: string,
    action: string,
    evidence: SessionAuditRecord["evidence"],
    now: Date,
  ) {
    await db
      .insert(auditEvents)
      .values(sessionAudit(session, actorIdentity, action, evidence, now));
  }
}

async function leaseTime(tx: QueryHandle): Promise<Date> {
  // now() is fixed at transaction start, before waits for the session or command locks.
  const {
    rows: [clock],
  } = await tx.query<{ now: Date }>("select clock_timestamp() as now");
  return clock!.now;
}

function sessionScope(organizationId: string, sessionId: string) {
  return and(eq(sessions.organizationId, organizationId), eq(sessions.id, sessionId));
}

function commandScope(session: SessionRecord) {
  return and(
    eq(commands.organizationId, session.organizationId),
    eq(commands.sessionId, session.id),
  );
}

function readEvent(row: typeof events.$inferSelect): SessionEventRecord {
  const { kind, commandId, data, ...scope } = row;
  if (kind === "message" && commandId !== null && "ordinal" in data) {
    return { ...scope, kind, commandId, data };
  }
  if (kind === "delivery" && commandId !== null && "status" in data) {
    return { ...scope, kind, commandId, data };
  }
  if (kind === "state" && commandId === null && "state" in data) {
    return { ...scope, kind, commandId, data };
  }
  if (kind === "participants" && commandId === null && "userId" in data) {
    return { ...scope, kind, commandId, data };
  }
  throw new Error("Invalid persisted interactive session event");
}
