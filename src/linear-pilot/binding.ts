import type { DatabaseRuntime, QueryHandle, TransactionHandle } from "../db/runtime/index.js";
import type {
  interactiveSessionProfiles,
  interactiveSessions,
  surfaceBindings,
} from "../db/schema.js";
import type { Locks } from "../db/runtime/locks/index.js";
import {
  nativeBindingValues,
  surfaceRevision,
  surfaceUuid,
  validBinding,
  validIdentityKey,
  validInstallation,
  validSurfaceMember,
} from "../surfaces/store.js";
import type { SurfaceBinding, SurfaceIdentity, SurfaceStore } from "../surfaces/store.js";

/**
 * Pilot rows reuse `surface_bindings` with no schema change. A pilot row is marked by the
 * largest value the `policy_revision` column accepts. General policies start at 1 and add one
 * per save. General current lookup requires a matching enabled policy. After rollout, a general
 * writer can replace the pilot row by supplying its exact current binding generation.
 */
export const PILOT_POLICY_REVISION = 2_147_483_647;

/** Operator config. Never build this from a webhook payload. */
export interface PilotAuthority {
  organizationId: string;
  workspaceId: string;
  applicationId: string;
  appUserId: string;
  connectionId: string;
  profileId: string;
  /** Hub user who owns the profile, starts the sessions and is the only mapped human. */
  ownerUserId: string;
  /** Linear user id of that human. */
  humanProviderUserId: string;
  teamIds: readonly string[];
}

export type PilotRefusal =
  | "invalid_input"
  | "access_lost"
  | "rolled_out"
  | "team_out_of_scope"
  | "profile_unavailable"
  | "profile_changed"
  | "owner_mismatch"
  | "identity_unmapped"
  | "identity_conflict"
  | "actor_mismatch"
  | "session_unavailable"
  | "session_already_bound"
  | "foreign_binding"
  | "history_mismatch"
  | "reconnect_unqualified";

interface Refused {
  status: "refused";
  reason: PilotRefusal;
}

export interface PilotNativeOrigin {
  nativeSessionId: string;
  issueId: string;
  teamId: string;
  /** Linear user from the signed event who acted. */
  actorProviderUserId: string;
}

export interface PilotAdmitInput extends PilotNativeOrigin {
  sessionId: string;
  now: Date;
}

export interface PilotAdvanceExpected {
  bindingId: string;
  generation: number;
  sessionId: string;
  /** Hub session generation, separate from the binding generation. */
  sessionGeneration: number;
  turn: number;
  agentId: string;
  firstCommandId: string;
}

export interface PilotAdvanceInput extends PilotNativeOrigin {
  expected: PilotAdvanceExpected;
  nextSessionId: string;
  now: Date;
}

export type PilotIdentityResult =
  | { status: "mapped" | "existing"; identity: SurfaceIdentity }
  | Refused;
export type PilotFindResult =
  | { status: "none" }
  | { status: "bound"; binding: SurfaceBinding }
  | Refused;
export type PilotAdmitResult =
  | { status: "created" | "replayed"; binding: SurfaceBinding }
  | Refused;

export type PilotAdvanceResult =
  | { status: "advanced"; binding: SurfaceBinding }
  | { status: "replayed"; binding: SurfaceBinding }
  | Refused;

/** Installation metadata only. Never selects token, refresh or scope columns. */
export interface PilotConnection {
  connectionId: string;
  organizationId: string;
  workspaceId: string;
  applicationId: string;
  appUserId: string;
}

export type PilotConnectionResult = { status: "resolved"; connection: PilotConnection } | Refused;

export interface PilotBindingStore {
  resolveConnection(authority: PilotAuthority): Promise<PilotConnectionResult>;
  mapIdentity(authority: PilotAuthority, label: string, now: Date): Promise<PilotIdentityResult>;
  find(
    authority: PilotAuthority,
    origin: PilotNativeOrigin,
    query?: QueryHandle,
  ): Promise<PilotFindResult>;
  admit(authority: PilotAuthority, input: PilotAdmitInput): Promise<PilotAdmitResult>;
  advance(authority: PilotAuthority, input: PilotAdvanceInput): Promise<PilotAdvanceResult>;
}

export type PilotIdentityStore = Pick<
  SurfaceStore,
  "createSurfaceIdentity" | "findSurfaceIdentity"
>;

const refuse = (reason: PilotRefusal): Refused => ({ status: "refused", reason });

function bounded(value: string) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 255 &&
    !value.includes("\0")
  );
}

export function validPilotAuthority(a: PilotAuthority) {
  return (
    validInstallation(a) &&
    surfaceUuid(a.connectionId) &&
    surfaceUuid(a.profileId) &&
    validSurfaceMember({
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      userId: a.ownerUserId,
    }) &&
    validIdentityKey({
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      providerUserId: a.humanProviderUserId,
    }) &&
    a.humanProviderUserId !== a.appUserId &&
    a.teamIds.length > 0 &&
    a.teamIds.length <= 200 &&
    a.teamIds.every(bounded) &&
    new Set(a.teamIds).size === a.teamIds.length
  );
}

function validOrigin(a: PilotAuthority, o: PilotNativeOrigin) {
  return (
    validBinding({
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      applicationId: a.applicationId,
      appUserId: a.appUserId,
      nativeSessionId: o.nativeSessionId,
      connectionId: a.connectionId,
      issueId: o.issueId,
      teamId: o.teamId,
      sessionId: "00000000-0000-4000-8000-000000000000",
      policyRevision: PILOT_POLICY_REVISION,
      expectedGeneration: null,
      now: new Date(0),
    }) && bounded(o.actorProviderUserId)
  );
}

function validAdvance(input: PilotAdvanceInput) {
  const { expected, nextSessionId, now } = input;
  return (
    expected !== undefined &&
    expected !== null &&
    [expected.bindingId, expected.sessionId, expected.firstCommandId, nextSessionId].every(
      (id) => typeof id === "string" && surfaceUuid(id),
    ) &&
    expected.sessionId.toLowerCase() !== nextSessionId.toLowerCase() &&
    surfaceRevision(expected.generation) &&
    surfaceRevision(expected.sessionGeneration) &&
    surfaceRevision(expected.turn) &&
    bounded(expected.agentId) &&
    now instanceof Date &&
    Number.isFinite(now.getTime())
  );
}

const bindingColumns = `
  b.id, b.organization_id as "organizationId", b.workspace_id as "workspaceId",
  b.application_id as "applicationId", b.app_user_id as "appUserId",
  b.native_session_id as "nativeSessionId", b.connection_id as "connectionId",
  b.issue_id as "issueId", b.team_id as "teamId", b.session_id as "sessionId",
  b.policy_revision as "policyRevision", b.generation, b.created_at as "createdAt",
  b.superseded_at as "supersededAt"
`;

type BindingRow = typeof surfaceBindings.$inferSelect;

type ProfileRow = Pick<
  typeof interactiveSessionProfiles.$inferSelect,
  "status" | "version" | "createdByUserId"
> & { access: string };

type SessionRow = Pick<
  typeof interactiveSessions.$inferSelect,
  | "origin"
  | "state"
  | "stateReason"
  | "profileId"
  | "profileVersion"
  | "startedByUserId"
  | "requesterIdentityId"
  | "closedAt"
  | "closedByUserId"
  | "generation"
  | "turn"
  | "commandSeq"
  | "daemonAgentId"
  | "daemonWorkspaceId"
>;

interface VerifiedOwner {
  status: "verified";
  profile: ProfileRow;
  identityId: string | null;
}

type Owner = VerifiedOwner | Refused;

function mappedIdentity(
  identity: SurfaceIdentity,
  ownerUserId: string,
  status: "mapped" | "existing",
): PilotIdentityResult {
  return identity.userId === ownerUserId ? { status, identity } : refuse("identity_conflict");
}

export class PilotBindings implements PilotBindingStore {
  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
    private readonly identities: PilotIdentityStore,
  ) {}

  resolveConnection: PilotBindingStore["resolveConnection"] = async (authority) => {
    if (!validPilotAuthority(authority)) return refuse("invalid_input");
    const {
      rows: [connection],
    } = await this.runtime.query<Record<keyof PilotConnection, string>>(
      `select id as "connectionId", organization_id as "organizationId",
              linear_organization_id as "workspaceId", provider_application_id as "applicationId",
              app_user_id as "appUserId"
       from linear_connections
       where id = $1 and organization_id = $2 and linear_organization_id = $3
         and provider_application_id = $4 and app_user_id = $5`,
      [
        authority.connectionId,
        authority.organizationId,
        authority.workspaceId,
        authority.applicationId,
        authority.appUserId,
      ],
    );
    return connection ? { status: "resolved", connection } : refuse("access_lost");
  };

  mapIdentity: PilotBindingStore["mapIdentity"] = async (authority, label, now) => {
    if (!validPilotAuthority(authority) || !(now instanceof Date)) return refuse("invalid_input");
    const identityKey = {
      organizationId: authority.organizationId,
      workspaceId: authority.workspaceId,
      providerUserId: authority.humanProviderUserId,
    };
    const input = { ...identityKey, userId: authority.ownerUserId, label, now };
    const owner = await this.runtime.transaction((tx) => authorizeOwner(tx, authority, false));
    if (owner.status === "refused") return owner;
    const settle = (identity: SurfaceIdentity | undefined, status: "mapped" | "existing") => {
      if (identity === undefined) return undefined;
      return mappedIdentity(identity, authority.ownerUserId, status);
    };
    const existing = settle(await this.identities.findSurfaceIdentity(identityKey), "existing");
    if (existing) return existing;
    const created = await this.identities.createSurfaceIdentity(input);
    if (created) return mappedIdentity(created, authority.ownerUserId, "mapped");
    // Lost a create race or the identity predates a connection change: re-read, never overwrite.
    return (
      settle(await this.identities.findSurfaceIdentity(identityKey), "existing") ??
      refuse("identity_unmapped")
    );
  };

  find: PilotBindingStore["find"] = async (authority, origin, query) => {
    if (!validPilotAuthority(authority) || !validOrigin(authority, origin))
      return refuse("invalid_input");
    if (origin.actorProviderUserId !== authority.humanProviderUserId)
      return refuse("actor_mismatch");
    if (!authority.teamIds.includes(origin.teamId)) return refuse("team_out_of_scope");
    const read = async (tx: QueryHandle): Promise<PilotFindResult> => {
      const rows = await nativeRows(tx, authority, origin, false);
      const owner = await authorizeOwner(tx, authority, false);
      if (owner.status === "refused") return owner;
      if (rows.length === 0) return { status: "none" };
      const row = currentPilotRow(rows, authority, origin);
      if ("status" in row) return row;
      const session = await authorizeSession({
        tx,
        a: authority,
        owner,
        sessionId: row.sessionId,
        lock: false,
      });
      if ("status" in session) return session;
      return { status: "bound", binding: row };
    };
    return query === undefined ? this.runtime.transaction(read) : read(query);
  };

  admit: PilotBindingStore["admit"] = async (authority, input) => {
    if (
      !validPilotAuthority(authority) ||
      !validOrigin(authority, input) ||
      !surfaceUuid(input.sessionId) ||
      !(input.now instanceof Date) ||
      Number.isNaN(input.now.getTime())
    )
      return refuse("invalid_input");
    if (input.actorProviderUserId !== authority.humanProviderUserId)
      return refuse("actor_mismatch");
    if (!authority.teamIds.includes(input.teamId)) return refuse("team_out_of_scope");
    const sessionId = input.sessionId.toLowerCase();
    return this.runtime.transaction(async (tx) => {
      await this.lockMutation(tx, authority, input);
      const owner = await authorizeOwner(tx, authority, true);
      if (owner.status === "refused") return owner;
      const session = await authorizeSession({ tx, a: authority, owner, sessionId, lock: true });
      if ("status" in session) return session;
      const rows = await nativeRows(tx, authority, input, true);
      if (rows.length === 0) {
        if (await sessionHasBinding(tx, authority.organizationId, sessionId))
          return refuse("session_already_bound");
        const binding = await insertPilotBinding({
          tx,
          authority,
          origin: input,
          sessionId,
          generation: 1,
          now: input.now,
        });
        return binding ? ({ status: "created", binding } as const) : refuse("history_mismatch");
      }
      const row = currentPilotRow(rows, authority, input);
      if ("status" in row) return row;
      // A different Hub session for a bound native session needs owner qualification first.
      if (row.sessionId !== sessionId) return refuse("reconnect_unqualified");
      return { status: "replayed", binding: row } as const;
    });
  };

  advance: PilotBindingStore["advance"] = async (authority, input) => {
    if (!validPilotAuthority(authority) || !validOrigin(authority, input) || !validAdvance(input))
      return refuse("invalid_input");
    if (input.actorProviderUserId !== authority.humanProviderUserId)
      return refuse("actor_mismatch");
    if (!authority.teamIds.includes(input.teamId)) return refuse("team_out_of_scope");

    const { expected } = input;
    const nextSessionId = input.nextSessionId.toLowerCase();
    return this.runtime.transaction<PilotAdvanceResult>(async (tx) => {
      await this.lockMutation(tx, authority, input);
      const owner = await authorizeOwner(tx, authority, true);
      if (owner.status === "refused") return owner;
      const rows = await nativeRows(tx, authority, input, true);
      const current = currentPilotRow(rows, authority, input);
      if ("status" in current) return current;

      const predecessor = advancePredecessor({ rows, expected, current, nextSessionId });
      if (predecessor === undefined) return refuse("history_mismatch");
      const { nextGeneration, replay } = predecessor;
      const retired = await authorizeRetirement({
        tx,
        authority,
        owner,
        sessionId: predecessor.sessionId,
        expected,
      });
      if (retired) return retired;

      const next = await authorizeSession({
        tx,
        a: authority,
        owner,
        sessionId: nextSessionId,
        lock: true,
      });
      if ("status" in next) return next;
      if (replay) return { status: "replayed", binding: current };
      if (!isFreshSession(next)) return refuse("session_unavailable");
      if (await sessionHasBinding(tx, authority.organizationId, nextSessionId))
        return refuse("session_already_bound");
      if (!surfaceRevision(nextGeneration)) return refuse("history_mismatch");

      return advanceBinding({ tx, authority, input, nextSessionId, nextGeneration, current });
    });
  };

  private async lockMutation(
    tx: TransactionHandle,
    authority: PilotAuthority,
    origin: PilotNativeOrigin,
  ) {
    // The general writer uses the same binding lock. The policy lock also serializes session reuse.
    await this.locks.withTxLock(
      tx,
      "surface-binding:" +
        JSON.stringify(
          nativeBindingValues({ ...authority, nativeSessionId: origin.nativeSessionId }),
        ),
    );
    await this.locks.withTxLock(tx, "surface-policy:" + authority.connectionId.toLowerCase());
  }
}

interface AdvanceHistory {
  rows: BindingRow[];
  expected: PilotAdvanceExpected;
  current: BindingRow;
  nextSessionId: string;
}

function advancePredecessor({ rows, expected, current, nextSessionId }: AdvanceHistory) {
  const predecessor = rows[expected.generation - 1];
  if (
    predecessor?.id !== expected.bindingId.toLowerCase() ||
    predecessor.sessionId !== expected.sessionId.toLowerCase()
  )
    return undefined;

  const nextGeneration = expected.generation + 1;
  const replay = current.generation === nextGeneration && current.sessionId === nextSessionId;
  if (current.id !== predecessor.id && !replay) return undefined;
  return { sessionId: predecessor.sessionId, nextGeneration, replay };
}

interface AdvanceBindingOptions {
  tx: TransactionHandle;
  authority: PilotAuthority;
  input: PilotAdvanceInput;
  nextSessionId: string;
  nextGeneration: number;
  current: BindingRow;
}

async function advanceBinding({
  tx,
  authority,
  input,
  nextSessionId,
  nextGeneration,
  current,
}: AdvanceBindingOptions): Promise<PilotAdvanceResult> {
  const updated = await tx.query(
    `update surface_bindings set superseded_at = $1
         where organization_id = $2 and id = $3 and superseded_at is null`,
    [input.now, authority.organizationId, current.id],
  );
  if (updated.rowCount !== 1) return refuse("history_mismatch");
  const binding = await insertPilotBinding({
    tx,
    authority,
    origin: input,
    sessionId: nextSessionId,
    generation: nextGeneration,
    now: input.now,
  });
  if (binding === undefined) return tx.rollback(refuse("history_mismatch"));
  return { status: "advanced", binding };
}

function activePrivateProfile(profile: ProfileRow | undefined): profile is ProfileRow {
  return !!profile && profile.status === "active" && profile.access === "private";
}

function verifiedOwner(
  a: PilotAuthority,
  profile: ProfileRow,
  identity: { id: string; userId: string } | undefined,
): Owner {
  if (identity && identity.userId !== a.ownerUserId) return refuse("identity_conflict");
  return { status: "verified", profile, identityId: identity?.id ?? null };
}

/** Checks everything about the owner chain that does not depend on a session. */
async function authorizeOwner(tx: QueryHandle, a: PilotAuthority, lock: boolean): Promise<Owner> {
  const share = lock ? " for share" : "";
  const {
    rows: [connection],
  } = await tx.query(
    `select 1 from linear_connections
     where id = $1 and organization_id = $2 and linear_organization_id = $3
       and provider_application_id = $4 and app_user_id = $5${share}`,
    [a.connectionId, a.organizationId, a.workspaceId, a.applicationId, a.appUserId],
  );
  if (!connection) return refuse("access_lost");
  const {
    rows: [policy],
  } = await tx.query(
    `select 1 from surface_policies where connection_id = $1 and organization_id = $2 and enabled${share}`,
    [a.connectionId, a.organizationId],
  );
  if (policy) return refuse("rolled_out");
  const {
    rows: [profile],
  } = await tx.query<ProfileRow>(
    `select status, access, version, created_by_user_id as "createdByUserId"
     from interactive_session_profiles where id = $1 and organization_id = $2${share}`,
    [a.profileId, a.organizationId],
  );
  if (!activePrivateProfile(profile)) return refuse("profile_unavailable");
  if (profile.createdByUserId !== a.ownerUserId) return refuse("owner_mismatch");
  const {
    rows: [member],
  } = await tx.query(
    `select 1 from member where organization_id = $1 and user_id = $2 and role = 'owner'${share}`,
    [a.organizationId, a.ownerUserId],
  );
  if (!member) return refuse("owner_mismatch");
  const {
    rows: [identity],
  } = await tx.query<{ id: string; userId: string }>(
    `select id, user_id as "userId" from member_identities
     where organization_id = $1 and workspace_id = $2 and provider_user_id = $3${share}`,
    [a.organizationId, a.workspaceId, a.humanProviderUserId],
  );
  return verifiedOwner(a, profile, identity);
}

function usableSession(
  session: SessionRow | undefined,
  a: PilotAuthority,
  allowClosed: boolean,
): session is SessionRow {
  return (
    !!session &&
    session.origin === "linear" &&
    (allowClosed || session.state !== "closed") &&
    session.profileId === a.profileId &&
    session.startedByUserId === a.ownerUserId
  );
}

interface AuthorizeSessionOptions {
  tx: QueryHandle;
  a: PilotAuthority;
  owner: VerifiedOwner;
  sessionId: string;
  lock: boolean;
  allowClosed?: boolean;
}

async function authorizeSession({
  tx,
  a,
  owner,
  sessionId,
  lock,
  allowClosed = false,
}: AuthorizeSessionOptions): Promise<SessionRow | Refused> {
  const {
    rows: [session],
  } = await tx.query<SessionRow>(
    `select origin, state, state_reason as "stateReason", profile_id as "profileId",
            profile_version as "profileVersion", started_by_user_id as "startedByUserId",
            requester_identity_id as "requesterIdentityId", closed_at as "closedAt",
            closed_by_user_id as "closedByUserId", generation, turn, command_seq as "commandSeq",
            daemon_agent_id as "daemonAgentId", daemon_workspace_id as "daemonWorkspaceId"
     from interactive_sessions where id = $1 and organization_id = $2${lock ? " for share" : ""}`,
    [sessionId, a.organizationId],
  );
  if (!usableSession(session, a, allowClosed)) return refuse("session_unavailable");
  if (session.profileVersion !== owner.profile.version) return refuse("profile_changed");
  if (owner.identityId === null) return refuse("identity_unmapped");
  if (session.requesterIdentityId !== owner.identityId) return refuse("actor_mismatch");
  return session;
}

interface AuthorizeRetirementOptions {
  tx: QueryHandle;
  authority: PilotAuthority;
  owner: VerifiedOwner;
  sessionId: string;
  expected: PilotAdvanceExpected;
}

async function authorizeRetirement({
  tx,
  authority,
  owner,
  sessionId,
  expected,
}: AuthorizeRetirementOptions): Promise<Refused | undefined> {
  const old = await authorizeSession({
    tx,
    a: authority,
    owner,
    sessionId,
    lock: true,
    allowClosed: true,
  });
  if ("status" in old) return old;
  if (
    old.state !== "closed" ||
    old.closedAt === null ||
    old.stateReason !== null ||
    old.closedByUserId !== null ||
    old.generation !== expected.sessionGeneration ||
    old.turn !== expected.turn ||
    old.daemonAgentId !== expected.agentId
  ) {
    return refuse("session_unavailable");
  }
  const {
    rows: [delivered],
  } = await tx.query(
    `select 1 from interactive_session_commands
     where id = $1 and organization_id = $2 and session_id = $3 and generation = $4
       and ordinal = 1 and kind = 'message' and status = 'delivered' and author_user_id = $5
       and settled_at is not null and failure_code is null for share`,
    [
      expected.firstCommandId,
      authority.organizationId,
      sessionId,
      expected.sessionGeneration,
      authority.ownerUserId,
    ],
  );
  return delivered ? undefined : refuse("session_unavailable");
}

function isFreshSession(session: SessionRow) {
  return (
    session.state === "starting" &&
    session.stateReason === null &&
    session.closedAt === null &&
    session.closedByUserId === null &&
    session.generation === 1 &&
    session.turn === 0 &&
    session.commandSeq === 1 &&
    session.daemonAgentId === null &&
    session.daemonWorkspaceId === null
  );
}

async function sessionHasBinding(tx: QueryHandle, organizationId: string, sessionId: string) {
  const {
    rows: [binding],
  } = await tx.query(
    "select 1 from surface_bindings where organization_id = $1 and session_id = $2 limit 1",
    [organizationId, sessionId],
  );
  return binding !== undefined;
}

interface InsertPilotBindingOptions {
  tx: QueryHandle;
  authority: PilotAuthority;
  origin: PilotNativeOrigin;
  sessionId: string;
  generation: number;
  now: Date;
}

async function insertPilotBinding({
  tx,
  authority,
  origin,
  sessionId,
  generation,
  now,
}: InsertPilotBindingOptions) {
  const {
    rows: [binding],
  } = await tx.query<BindingRow>(
    `insert into surface_bindings as b
      (organization_id, workspace_id, application_id, app_user_id, native_session_id,
       connection_id, issue_id, team_id, session_id, policy_revision, generation, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     returning ${bindingColumns}`,
    [
      authority.organizationId,
      ...nativeBindingValues({ ...authority, nativeSessionId: origin.nativeSessionId }),
      authority.connectionId,
      origin.issueId,
      origin.teamId,
      sessionId,
      PILOT_POLICY_REVISION,
      generation,
      now,
    ],
  );
  return binding;
}

async function nativeRows(tx: QueryHandle, a: PilotAuthority, o: PilotNativeOrigin, lock: boolean) {
  const { rows } = await tx.query<BindingRow>(
    `select ${bindingColumns} from surface_bindings b
     where b.workspace_id = $1 and b.application_id = $2 and b.app_user_id = $3
       and b.native_session_id = $4 order by b.generation${lock ? " for update" : ""}`,
    [a.workspaceId, a.applicationId, a.appUserId, o.nativeSessionId],
  );
  return rows;
}

function currentPilotRow(
  rows: BindingRow[],
  authority: PilotAuthority,
  origin: PilotNativeOrigin,
): BindingRow | Refused {
  if (rows.some((row) => row.policyRevision !== PILOT_POLICY_REVISION))
    return refuse("foreign_binding");
  const current = rows.at(-1);
  if (current === undefined || current.supersededAt !== null) return refuse("history_mismatch");

  const connectionId = authority.connectionId.toLowerCase();
  const sessions = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (
      row.generation !== index + 1 ||
      (row !== current && row.supersededAt === null) ||
      !matchesBindingChain(row, authority, origin, connectionId) ||
      sessions.has(row.sessionId)
    ) {
      return refuse("history_mismatch");
    }
    sessions.add(row.sessionId);
  }
  return current;
}

function matchesBindingChain(
  row: BindingRow,
  authority: PilotAuthority,
  origin: PilotNativeOrigin,
  connectionId: string,
) {
  return (
    row.organizationId === authority.organizationId &&
    row.connectionId === connectionId &&
    row.issueId === origin.issueId &&
    row.teamId === origin.teamId
  );
}
