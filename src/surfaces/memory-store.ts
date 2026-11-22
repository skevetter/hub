import { randomUUID } from "node:crypto";
import type { LinearConnectionRecord } from "../db/types.js";
import type { StoredSessionProfile, SessionRecord } from "../interactive-sessions/types.js";
import {
  nativeBindingValues,
  bindingRecord,
  matchesInstallation,
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
  IdentityKey,
  LinearInstallation,
  SurfaceBinding,
  SurfaceIdentity,
  SurfaceMember,
  SurfacePolicy,
  SurfaceStore,
} from "./store.js";

interface MemorySurfaceReferences {
  connection(workspaceId: string): LinearConnectionRecord | undefined;
  isMember(organizationId: string, userId: string): boolean;
  profile(id: string): StoredSessionProfile | undefined;
  session(organizationId: string, id: string): SessionRecord | undefined;
}

export class MemorySurfaceStore implements SurfaceStore {
  private readonly identities = new Map<string, SurfaceIdentity>();
  private readonly policies = new Map<string, SurfacePolicy>();
  private readonly bindings = new Map<string, SurfaceBinding[]>();

  constructor(private readonly references: MemorySurfaceReferences) {}

  createSurfaceIdentity: SurfaceStore["createSurfaceIdentity"] = async (input) => {
    if (!validIdentity(input) || !this.references.isMember(input.organizationId, input.userId))
      return undefined;
    const connection = this.references.connection(input.workspaceId);
    if (
      connection?.organizationId !== input.organizationId ||
      connection.appUserId === input.providerUserId
    )
      return undefined;
    const key = identityKey(input);
    if (this.identities.has(key)) return undefined;
    const { organizationId, workspaceId, providerUserId, userId, label, now } = input;
    const record = {
      id: randomUUID(),
      organizationId,
      workspaceId,
      providerUserId,
      userId,
      label,
      createdAt: now,
    };
    this.identities.set(key, structuredClone(record));
    return structuredClone(record);
  };

  findSurfaceIdentity: SurfaceStore["findSurfaceIdentity"] = async (key) => {
    if (!validIdentityKey(key)) return undefined;
    const identity = this.identities.get(identityKey(key));
    return identity && this.currentIdentity(identity) ? structuredClone(identity) : undefined;
  };

  listSurfaceIdentities: SurfaceStore["listSurfaceIdentities"] = async (member) =>
    validSurfaceMember(member)
      ? structuredClone(
          [...this.identities.values()]
            .filter(
              (row) =>
                row.organizationId === member.organizationId &&
                row.workspaceId === member.workspaceId &&
                row.userId === member.userId &&
                this.currentIdentity(row),
            )
            .sort((left, right) => left.id.localeCompare(right.id)),
        )
      : [];

  removeSurfaceIdentity: SurfaceStore["removeSurfaceIdentity"] = async (input) => {
    if (!validIdentityKey(input) || !surfaceUuid(input.id)) return false;
    const key = identityKey(input);
    if (this.identities.get(key)?.id !== input.id.toLowerCase()) return false;
    return this.identities.delete(key);
  };

  dropMember(organizationId: string, userId: string) {
    for (const [key, identity] of this.identities) {
      if (identity.organizationId === organizationId && identity.userId === userId)
        this.identities.delete(key);
    }
  }

  dropConnection(connection: LinearConnectionRecord) {
    this.policies.delete(connection.id);
    for (const [key, identity] of this.identities) {
      if (
        identity.organizationId === connection.organizationId &&
        identity.workspaceId === connection.linearOrganizationId
      )
        this.identities.delete(key);
    }
  }

  isCurrentRequester(member: SurfaceMember, id: string) {
    return (
      surfaceUuid(id) &&
      [...this.identities.values()].some(
        (identity) =>
          identity.id === id.toLowerCase() &&
          identity.organizationId === member.organizationId &&
          identity.workspaceId === member.workspaceId &&
          identity.userId === member.userId &&
          this.currentIdentity(identity),
      )
    );
  }

  private currentIdentity(identity: SurfaceIdentity) {
    const connection = this.references.connection(identity.workspaceId);
    return (
      connection?.organizationId === identity.organizationId &&
      connection.appUserId !== identity.providerUserId
    );
  }

  findSurfacePolicy: SurfaceStore["findSurfacePolicy"] = async (key) =>
    structuredClone(this.currentPolicy(key));

  private currentPolicy(key: LinearInstallation) {
    if (!validInstallation(key)) return undefined;
    const connection = this.references.connection(key.workspaceId);
    if (!matchesInstallation(connection, key)) return undefined;
    const policy = this.policies.get(connection.id);
    if (
      policy?.workspaceId === key.workspaceId &&
      policy.applicationId === key.applicationId &&
      policy.appUserId === key.appUserId &&
      policy.organizationId === key.organizationId
    )
      return policy;
    return undefined;
  }

  saveSurfacePolicy: SurfaceStore["saveSurfacePolicy"] = async (input) => {
    if (!validPolicy(input)) return undefined;
    const connection = this.references.connection(input.workspaceId);
    if (
      !matchesInstallation(connection, input) ||
      connection.id !== input.connectionId.toLowerCase()
    )
      return undefined;
    const policy = policyRecord(
      input,
      this.references.profile(input.profileId),
      this.policies.get(connection.id),
    );
    if (!policy) return undefined;
    this.policies.set(connection.id, structuredClone(policy));
    return structuredClone(policy);
  };

  findSurfaceBinding: SurfaceStore["findSurfaceBinding"] = async (key) => {
    if (!validBindingKey(key)) return undefined;
    const binding = this.bindings.get(JSON.stringify(nativeBindingValues(key)))?.at(-1);
    const policy = this.currentPolicy(key);
    if (
      !policy?.enabled ||
      binding?.organizationId !== key.organizationId ||
      binding.connectionId !== policy.connectionId ||
      binding.policyRevision !== policy.revision
    )
      return undefined;
    return structuredClone(binding);
  };

  findSurfaceBindingGeneration: SurfaceStore["findSurfaceBindingGeneration"] = async (
    key,
    generation,
  ) => {
    if (!validBindingKey(key) || !surfaceRevision(generation)) return undefined;
    const record = this.bindings.get(JSON.stringify(nativeBindingValues(key)))?.[generation - 1];
    return record?.organizationId === key.organizationId ? structuredClone(record) : undefined;
  };

  supersedeSurfaceBinding: SurfaceStore["supersedeSurfaceBinding"] = async (input) => {
    if (!validBinding(input)) return undefined;
    const key = JSON.stringify(nativeBindingValues(input));
    const history = this.bindings.get(key) ?? [];
    const prior = history.at(-1);
    const session = this.references.session(input.organizationId, input.sessionId);
    if (
      !session?.startedByUserId ||
      !session.requesterIdentityId ||
      !this.isCurrentRequester(
        { ...input, userId: session.startedByUserId },
        session.requesterIdentityId,
      )
    )
      return undefined;
    const binding = bindingRecord(input, this.currentPolicy(input), session, prior);
    if (!binding) return undefined;
    const record = { ...binding, id: randomUUID() };
    if (prior) prior.supersededAt = new Date(input.now);
    history.push(structuredClone(record));
    this.bindings.set(key, history);
    return structuredClone(record);
  };
}

function identityKey({ organizationId, workspaceId, providerUserId }: IdentityKey) {
  return JSON.stringify([organizationId, workspaceId, providerUserId]);
}
