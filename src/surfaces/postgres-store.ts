import { and, asc, eq, getTableColumns, ne } from "drizzle-orm";
import type { DatabaseRuntime, DrizzleHandle, QueryHandle } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import {
  surfaceBindings as bindings,
  interactiveSessionProfiles as profiles,
  interactiveSessions as sessions,
  linearConnections as connections,
  memberIdentities as identities,
  members,
  surfacePolicies as policies,
} from "../db/schema.js";
import {
  nativeBindingValues,
  bindingRecord,
  policyRecord,
  surfaceRevision,
  surfaceUuid,
  validBinding,
  validBindingKey,
  validIdentity,
  validIdentityKey,
  validInstallation,
  validPolicy,
  validSurfaceMember,
} from "./store.js";
import type {
  BindingKey,
  IdentityKey,
  LinearInstallation,
  SurfaceMember,
  SurfaceStore,
} from "./store.js";

const bindingColumns = `
  b.id, b.organization_id as "organizationId", b.workspace_id as "workspaceId",
  b.application_id as "applicationId", b.app_user_id as "appUserId",
  b.native_session_id as "nativeSessionId", b.connection_id as "connectionId",
  b.issue_id as "issueId", b.team_id as "teamId", b.session_id as "sessionId",
  b.policy_revision as "policyRevision", b.generation, b.created_at as "createdAt",
  b.superseded_at as "supersededAt"
`;

const nativeBindingScope = `
  b.workspace_id = $1 and b.application_id = $2 and b.app_user_id = $3 and b.native_session_id = $4
`;
const bindingScope = `${nativeBindingScope} and b.organization_id = $5`;

export class SurfaceRepository implements SurfaceStore {
  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
  ) {}

  createSurfaceIdentity: SurfaceStore["createSurfaceIdentity"] = async (input) => {
    if (!validIdentity(input)) return undefined;
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      const { organizationId, workspaceId, providerUserId, userId, label, now } = input;
      const [member] = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
        .for("key share");
      if (!member) return undefined;
      const [connection] = await db
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.linearOrganizationId, workspaceId),
            eq(connections.organizationId, organizationId),
            ne(connections.appUserId, providerUserId),
          ),
        )
        .for("share");
      if (!connection) return undefined;
      const [identity] = await db
        .insert(identities)
        .values({ organizationId, workspaceId, providerUserId, userId, label, createdAt: now })
        .onConflictDoNothing()
        .returning();
      return identity;
    });
  };

  findSurfaceIdentity: SurfaceStore["findSurfaceIdentity"] = async (key) => {
    if (!validIdentityKey(key)) return undefined;
    const [identity] = await currentIdentities(this.runtime.drizzle()).where(identityKey(key));
    return identity;
  };

  listSurfaceIdentities: SurfaceStore["listSurfaceIdentities"] = async (key) =>
    validSurfaceMember(key)
      ? currentIdentities(this.runtime.drizzle())
          .where(
            and(
              eq(identities.organizationId, key.organizationId),
              eq(identities.workspaceId, key.workspaceId),
              eq(identities.userId, key.userId),
            ),
          )
          .orderBy(asc(identities.id))
      : [];

  removeSurfaceIdentity: SurfaceStore["removeSurfaceIdentity"] = async (key) => {
    if (!validIdentityKey(key) || !surfaceUuid(key.id)) return false;
    const result = await this.runtime
      .drizzle()
      .delete(identities)
      .where(and(identityKey(key), eq(identities.id, key.id)));
    return result.rowCount === 1;
  };

  findSurfacePolicy: SurfaceStore["findSurfacePolicy"] = async (key) => {
    if (!validInstallation(key)) return undefined;
    const [policy] = await this.runtime
      .drizzle()
      .select(getTableColumns(policies))
      .from(connections)
      .innerJoin(policies, policyConnection())
      .where(installationScope(key));
    return policy;
  };

  saveSurfacePolicy: SurfaceStore["saveSurfacePolicy"] = async (input) => {
    if (!validPolicy(input)) return undefined;
    return this.runtime.transaction(async (tx) => {
      const db = tx.drizzle();
      await this.locks.withTxLock(tx, "surface-policy:" + input.connectionId.toLowerCase());
      const [connection] = await db
        .select({ id: connections.id })
        .from(connections)
        .where(and(installationScope(input), eq(connections.id, input.connectionId)))
        .for("share");
      if (!connection) return undefined;
      const [profile] = await db
        .select()
        .from(profiles)
        .where(
          and(eq(profiles.organizationId, input.organizationId), eq(profiles.id, input.profileId)),
        )
        .for("share");
      const [current] = await db
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.organizationId, input.organizationId),
            eq(policies.connectionId, connection.id),
          ),
        )
        .for("update");
      const record = policyRecord(input, profile, current);
      if (!record) return undefined;
      const [policy] = current
        ? await db
            .update(policies)
            .set(record)
            .where(
              and(
                eq(policies.organizationId, input.organizationId),
                eq(policies.connectionId, connection.id),
              ),
            )
            .returning()
        : await db.insert(policies).values(record).returning();
      return policy;
    });
  };

  findSurfaceBinding: SurfaceStore["findSurfaceBinding"] = async (key) => {
    if (!validBindingKey(key)) return undefined;
    const {
      rows: [binding],
    } = await this.runtime.query<typeof bindings.$inferSelect>(
      `select ${bindingColumns}
       from surface_bindings b
       join linear_connections c on c.linear_organization_id = b.workspace_id
         and c.id = b.connection_id and c.organization_id = b.organization_id
         and c.provider_application_id = b.application_id and c.app_user_id = b.app_user_id
       join surface_policies p on p.connection_id = c.id and p.organization_id = c.organization_id
         and p.workspace_id = c.linear_organization_id and p.application_id = c.provider_application_id
         and p.app_user_id = c.app_user_id and p.revision = b.policy_revision and p.enabled
       where ${bindingScope} and b.superseded_at is null limit 1`,
      [...nativeBindingValues(key), key.organizationId],
    );
    return binding;
  };

  findSurfaceBindingGeneration: SurfaceStore["findSurfaceBindingGeneration"] = async (
    key,
    generation,
  ) => {
    if (!validBindingKey(key) || !surfaceRevision(generation)) return undefined;
    const {
      rows: [binding],
    } = await this.runtime.query<typeof bindings.$inferSelect>(
      `select ${bindingColumns} from surface_bindings b
       where ${bindingScope} and b.generation = $6`,
      [...nativeBindingValues(key), key.organizationId, generation],
    );
    return binding;
  };

  supersedeSurfaceBinding: SurfaceStore["supersedeSurfaceBinding"] = async (input) => {
    if (!validBinding(input)) return undefined;
    return this.runtime.transaction(async (tx) => {
      await this.locks.withTxLock(
        tx,
        "surface-binding:" + JSON.stringify(nativeBindingValues(input)),
      );
      const db = tx.drizzle();
      const [policy] = await db
        .select(getTableColumns(policies))
        .from(connections)
        .innerJoin(policies, policyConnection())
        .where(
          and(
            installationScope(input),
            eq(connections.id, input.connectionId),
            eq(policies.enabled, true),
            eq(policies.revision, input.policyRevision),
          ),
        )
        .for("share", { of: [connections, policies] });
      if (!policy) return undefined;
      const prior = await currentBindingRow(tx, input);
      const [session] = await db
        .select({
          id: sessions.id,
          origin: sessions.origin,
          profileId: sessions.profileId,
          profileVersion: sessions.profileVersion,
          state: sessions.state,
        })
        .from(sessions)
        .innerJoin(
          identities,
          and(
            eq(identities.id, sessions.requesterIdentityId),
            eq(identities.organizationId, sessions.organizationId),
            eq(identities.workspaceId, input.workspaceId),
            eq(identities.userId, sessions.startedByUserId),
            ne(identities.providerUserId, input.appUserId),
          ),
        )
        .where(
          and(eq(sessions.organizationId, input.organizationId), eq(sessions.id, input.sessionId)),
        )
        .for("share", { of: [sessions, identities] });
      const record = bindingRecord(input, policy, session, prior);
      if (!record) return undefined;
      if (prior) {
        await tx.query(
          "update surface_bindings set superseded_at = $1 where organization_id = $2 and id = $3",
          [input.now, input.organizationId, prior.id],
        );
      }
      const [binding] = await db.insert(bindings).values(record).returning();
      return binding;
    });
  };
}

export async function isCurrentSurfaceRequester(
  db: DrizzleHandle,
  member: SurfaceMember,
  id: string,
) {
  if (!validSurfaceMember(member) || !surfaceUuid(id)) return false;
  const [identity] = await currentIdentities(db)
    .where(
      and(
        eq(identities.id, id),
        eq(identities.organizationId, member.organizationId),
        eq(identities.workspaceId, member.workspaceId),
        eq(identities.userId, member.userId),
      ),
    )
    .for("key share", { of: identities });
  return identity !== undefined;
}

function currentIdentities(db: DrizzleHandle) {
  return db
    .select(getTableColumns(identities))
    .from(identities)
    .innerJoin(
      connections,
      and(
        eq(identities.organizationId, connections.organizationId),
        eq(identities.workspaceId, connections.linearOrganizationId),
        ne(identities.providerUserId, connections.appUserId),
      ),
    );
}

function identityKey(key: IdentityKey) {
  return and(
    eq(identities.organizationId, key.organizationId),
    eq(identities.workspaceId, key.workspaceId),
    eq(identities.providerUserId, key.providerUserId),
  );
}

function installationScope(key: LinearInstallation) {
  return and(
    eq(connections.linearOrganizationId, key.workspaceId),
    eq(connections.organizationId, key.organizationId),
    eq(connections.providerApplicationId, key.applicationId),
    eq(connections.appUserId, key.appUserId),
  );
}

function policyConnection() {
  return and(
    eq(policies.connectionId, connections.id),
    eq(policies.organizationId, connections.organizationId),
    eq(policies.workspaceId, connections.linearOrganizationId),
    eq(policies.applicationId, connections.providerApplicationId),
    eq(policies.appUserId, connections.appUserId),
  );
}

async function currentBindingRow(tx: QueryHandle, key: BindingKey) {
  const {
    rows: [binding],
  } = await tx.query<typeof bindings.$inferSelect>(
    `select ${bindingColumns} from surface_bindings b
     where ${nativeBindingScope} and b.superseded_at is null for update`,
    nativeBindingValues(key),
  );
  return binding;
}
