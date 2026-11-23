import type { LinearConnectionRecord } from "../db/types.js";
import type { StoredSessionProfile, SessionRecord } from "../interactive-sessions/types.js";

export interface SurfaceWorkspace {
  organizationId: string;
  workspaceId: string;
}

export type SurfaceMember = SurfaceWorkspace & { userId: string };
export type IdentityKey = SurfaceWorkspace & { providerUserId: string };

export type IdentityInput = IdentityKey & {
  userId: string;
  label: string;
  now: Date;
};

export type SurfaceIdentity = IdentityKey & {
  id: string;
  userId: string;
  label: string;
  createdAt: Date;
};

export type LinearInstallation = SurfaceWorkspace & {
  applicationId: string;
  appUserId: string;
};

interface PolicyScope {
  teamIds: readonly string[];
}
type IssueStateOnBegin = "unchanged" | "started";

export type PolicyInput = LinearInstallation & {
  connectionId: string;
  expectedRevision: number | null;
  profileId: string;
  profileVersion: number;
  scope: PolicyScope;
  enabled?: boolean;
  publishAnswers?: boolean;
  moveOnBegin?: IssueStateOnBegin;
  verifiedAppHandle?: string | null;
  now: Date;
};

export type SurfacePolicy = LinearInstallation & {
  connectionId: string;
  revision: number;
  profileId: string;
  profileVersion: number;
  scope: PolicyScope;
  enabled: boolean;
  publishAnswers: boolean;
  moveOnBegin: IssueStateOnBegin;
  moveOnFinish: "unchanged";
  verifiedAppHandle: string | null;
  updatedAt: Date;
};

export type BindingKey = LinearInstallation & { nativeSessionId: string };

interface BindingTarget {
  connectionId: string;
  issueId: string;
  teamId: string;
  sessionId: string;
  policyRevision: number;
}

export type BindingInput = BindingKey &
  BindingTarget & {
    expectedGeneration: number | null;
    now: Date;
  };

export type SurfaceBinding = BindingKey &
  BindingTarget & {
    id: string;
    generation: number;
    createdAt: Date;
    supersededAt: Date | null;
  };

export interface SurfaceStore {
  createSurfaceIdentity(input: IdentityInput): Promise<SurfaceIdentity | undefined>;
  findSurfaceIdentity(key: IdentityKey): Promise<SurfaceIdentity | undefined>;
  listSurfaceIdentities(member: SurfaceMember): Promise<SurfaceIdentity[]>;
  removeSurfaceIdentity(key: IdentityKey & { id: string }): Promise<boolean>;
  findSurfacePolicy(installation: LinearInstallation): Promise<SurfacePolicy | undefined>;
  saveSurfacePolicy(input: PolicyInput): Promise<SurfacePolicy | undefined>;
  findSurfaceBinding(key: BindingKey): Promise<SurfaceBinding | undefined>;
  findSurfaceBindingGeneration(
    key: BindingKey,
    generation: number,
  ): Promise<SurfaceBinding | undefined>;
  supersedeSurfaceBinding(input: BindingInput): Promise<SurfaceBinding | undefined>;
}

function identifier(value: string) {
  return value.length > 0 && Buffer.byteLength(value) <= 255 && !value.includes("\0");
}

export function surfaceUuid(value: string) {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
}

export function surfaceRevision(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

export function validWorkspace(key: SurfaceWorkspace) {
  return identifier(key.organizationId) && identifier(key.workspaceId);
}

export function validIdentityKey(key: IdentityKey) {
  return validWorkspace(key) && identifier(key.providerUserId);
}

function boundedDisplayName(value: string) {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  );
}

export function validIdentity(input: IdentityInput) {
  return validIdentityKey(input) && identifier(input.userId) && boundedDisplayName(input.label);
}

export function validSurfaceMember(member: SurfaceMember) {
  return validWorkspace(member) && identifier(member.userId);
}

export function validInstallation(key: LinearInstallation) {
  return validWorkspace(key) && identifier(key.applicationId) && identifier(key.appUserId);
}

export function matchesInstallation(
  connection: LinearConnectionRecord | undefined,
  key: LinearInstallation,
): connection is LinearConnectionRecord {
  return (
    connection !== undefined &&
    connection.organizationId === key.organizationId &&
    connection.linearOrganizationId === key.workspaceId &&
    connection.providerApplicationId === key.applicationId &&
    connection.appUserId === key.appUserId
  );
}

export function validPolicy(input: PolicyInput) {
  const handle = input.verifiedAppHandle ?? null;
  const { teamIds } = input.scope;
  return (
    validInstallation(input) &&
    surfaceUuid(input.connectionId) &&
    surfaceUuid(input.profileId) &&
    surfaceRevision(input.profileVersion) &&
    (input.expectedRevision === null || surfaceRevision(input.expectedRevision)) &&
    validPolicyMoveOnBegin(input) &&
    validPolicyScope(input, teamIds, handle)
  );
}

function validPolicyMoveOnBegin(input: PolicyInput) {
  return (
    input.moveOnBegin === undefined ||
    input.moveOnBegin === "unchanged" ||
    input.moveOnBegin === "started"
  );
}

function validPolicyScope(input: PolicyInput, teamIds: readonly string[], handle: string | null) {
  return (
    teamIds.length <= 200 &&
    teamIds.every(identifier) &&
    new Set(teamIds).size === teamIds.length &&
    (handle === null || boundedDisplayName(handle)) &&
    (input.enabled !== true || (handle !== null && teamIds.length > 0))
  );
}

export function policyRecord(
  input: PolicyInput,
  profile: StoredSessionProfile | undefined,
  current: SurfacePolicy | undefined,
): SurfacePolicy | undefined {
  const revision = (current?.revision ?? 0) + 1;
  if (
    (current?.revision ?? null) !== input.expectedRevision ||
    !surfaceRevision(revision) ||
    !profileMatchesPolicy(input, profile)
  )
    return undefined;
  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    appUserId: input.appUserId,
    connectionId: input.connectionId.toLowerCase(),
    revision,
    profileId: profile.id,
    profileVersion: profile.version,
    scope: { teamIds: [...input.scope.teamIds] },
    enabled: input.enabled === true,
    publishAnswers: input.publishAnswers === true,
    moveOnBegin: input.moveOnBegin ?? "unchanged",
    moveOnFinish: "unchanged",
    verifiedAppHandle: input.verifiedAppHandle ?? null,
    updatedAt: input.now,
  };
}

function profileMatchesPolicy(
  input: PolicyInput,
  profile: StoredSessionProfile | undefined,
): profile is StoredSessionProfile {
  return (
    profile?.organizationId === input.organizationId &&
    profile.version === input.profileVersion &&
    (input.enabled !== true || profile.status === "active")
  );
}

export function validBindingKey(key: BindingKey) {
  return validInstallation(key) && identifier(key.nativeSessionId);
}

export function nativeBindingValues(key: BindingKey) {
  return [key.workspaceId, key.applicationId, key.appUserId, key.nativeSessionId] as const;
}

export function validBinding(input: BindingInput) {
  return (
    validBindingKey(input) &&
    surfaceUuid(input.connectionId) &&
    surfaceUuid(input.sessionId) &&
    identifier(input.issueId) &&
    identifier(input.teamId) &&
    surfaceRevision(input.policyRevision) &&
    (input.expectedGeneration === null || surfaceRevision(input.expectedGeneration))
  );
}

type BindingSession = Pick<
  SessionRecord,
  "id" | "origin" | "profileId" | "profileVersion" | "state"
>;

export function bindingRecord(
  input: BindingInput,
  policy: SurfacePolicy | undefined,
  session: BindingSession | undefined,
  prior: SurfaceBinding | undefined,
): Omit<SurfaceBinding, "id"> | undefined {
  const generation = (prior?.generation ?? 0) + 1;
  if (
    !policyAllowsBinding(input, policy) ||
    !sessionMatchesBindingPolicy(policy, session) ||
    (prior?.generation ?? null) !== input.expectedGeneration ||
    !surfaceRevision(generation) ||
    !bindingCanReplace(input, prior)
  )
    return undefined;
  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    applicationId: input.applicationId,
    appUserId: input.appUserId,
    nativeSessionId: input.nativeSessionId,
    connectionId: policy.connectionId,
    issueId: input.issueId,
    teamId: input.teamId,
    sessionId: session.id,
    policyRevision: policy.revision,
    generation,
    createdAt: input.now,
    supersededAt: null,
  };
}

function policyAllowsBinding(
  input: BindingInput,
  policy: SurfacePolicy | undefined,
): policy is SurfacePolicy {
  return (
    !!policy?.enabled &&
    policy.connectionId === input.connectionId.toLowerCase() &&
    policy.revision === input.policyRevision &&
    policy.scope.teamIds.includes(input.teamId)
  );
}

function sessionMatchesBindingPolicy(
  policy: SurfacePolicy,
  session: BindingSession | undefined,
): session is BindingSession {
  return (
    session?.origin === "linear" &&
    session.state !== "closed" &&
    session.profileId === policy.profileId &&
    session.profileVersion === policy.profileVersion
  );
}

function bindingCanReplace(input: BindingInput, prior: SurfaceBinding | undefined) {
  return (
    prior === undefined ||
    (prior.organizationId === input.organizationId &&
      prior.issueId === input.issueId &&
      prior.teamId === input.teamId &&
      prior.sessionId !== input.sessionId.toLowerCase())
  );
}
