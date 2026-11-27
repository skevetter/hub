import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "vitest";
import type { LinearConnectionRecord, Database } from "../db/types.js";
import type { StartSessionInput } from "../interactive-sessions/store.js";
import type { BindingInput, BindingKey, LinearInstallation, PolicyInput } from "./store.js";

export const surfaceTestTime = new Date("2026-11-20T00:00:00Z");

export function surfaceTenant() {
  const organizationId = randomUUID();
  const userId = organizationId + "-owner";
  const connection: LinearConnectionRecord = {
    id: randomUUID(),
    organizationId,
    slug: "linear",
    linearOrganizationId: randomUUID(),
    providerApplicationId: "test-shared-app",
    linearOrganizationName: "Test workspace",
    appUserId: randomUUID(),
    accessToken: "test",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: [],
  };
  return { organizationId, userId, connection };
}

export type SurfaceTenant = ReturnType<typeof surfaceTenant>;

export interface SurfaceFixture {
  database: Database;
  removeMember(tenant: SurfaceTenant): Promise<void>;
  removeConnection(tenant: SurfaceTenant): Promise<void>;
  restoreConnection(tenant: SurfaceTenant): Promise<void>;
}

export function installation({ connection }: SurfaceTenant): LinearInstallation {
  return {
    organizationId: connection.organizationId,
    workspaceId: connection.linearOrganizationId,
    applicationId: connection.providerApplicationId!,
    appUserId: connection.appUserId,
  };
}

export async function prepareProfile(database: Database, tenant: SurfaceTenant) {
  const now = surfaceTestTime;
  const verifier = randomUUID();
  const daemonId = randomUUID();
  const principal = {
    organizationId: tenant.organizationId,
    userId: tenant.userId,
    role: "owner" as const,
  };
  assert.equal(
    await database.issueEnrollmentToken({
      id: randomUUID(),
      organizationId: tenant.organizationId,
      verifier,
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null,
    }),
    true,
  );
  assert.ok(
    await database.enrollDaemon({
      daemonId,
      idempotencyKey: randomUUID(),
      tokenVerifier: verifier,
      serverId: randomUUID(),
      daemonPublicKey: "test-public-key",
      credentialVerifier: "test-verifier",
      permissions: ["hub.execute"],
      now,
    }),
  );
  await database.setDaemonPresence(daemonId, "connected");
  const settings = {
    principal,
    daemonId,
    id: null,
    version: null,
    name: "Contract profile",
    cwd: "/repo",
    worktree: null,
    provider: "codex",
    providerOptions: {},
    model: null,
    mode: null,
    thinkingOptionId: null,
    fullAccessAcknowledged: false,
    status: "active" as const,
    now,
  };
  const profile = await database.saveSessionProfile(settings);
  if (typeof profile === "string") throw new Error(profile);
  const request: StartSessionInput = {
    principal,
    profileId: profile.id,
    profileVersion: profile.version,
    idempotencyKey: randomUUID(),
    message: "test start",
    participants: [],
    usage: { periodStart: now, limit: null },
    maxActivePerDaemon: 10,
    bodyCutoff: null,
    now,
  };
  return { profile, settings, request };
}

export async function startFixtureSession(database: Database, request: StartSessionInput) {
  const result = await database.startInteractiveSession({
    ...request,
    idempotencyKey: randomUUID(),
  });
  assert.equal(result.status, "created");
  return result.session;
}

export function policyInput(tenant: SurfaceTenant, request: StartSessionInput): PolicyInput {
  return {
    ...installation(tenant),
    connectionId: tenant.connection.id,
    expectedRevision: null,
    profileId: request.profileId,
    profileVersion: request.profileVersion,
    scope: { teamIds: ["team"] },
    now: surfaceTestTime,
  };
}

async function nativeRequest(
  database: Database,
  tenant: SurfaceTenant,
  request: StartSessionInput,
): Promise<StartSessionInput> {
  const identity = await database.createSurfaceIdentity({
    organizationId: tenant.organizationId,
    workspaceId: tenant.connection.linearOrganizationId,
    providerUserId: randomUUID(),
    userId: request.principal.userId,
    label: "Native requester",
    now: surfaceTestTime,
  });
  assert.ok(identity);
  return {
    ...request,
    nativeRequester: { identityId: identity.id, workspaceId: identity.workspaceId },
  };
}

export async function prepareBinding(database: Database, tenant: SurfaceTenant) {
  const { request } = await prepareProfile(database, tenant);
  const policy = policyInput(tenant, request);
  assert.ok(
    await database.saveSurfacePolicy({ ...policy, enabled: true, verifiedAppHandle: "paseo" }),
  );
  const native = await nativeRequest(database, tenant, request);
  const session = await startFixtureSession(database, native);
  const binding: BindingInput = {
    ...installation(tenant),
    connectionId: tenant.connection.id,
    nativeSessionId: randomUUID(),
    issueId: "issue",
    teamId: "team",
    sessionId: session.id,
    policyRevision: 1,
    expectedGeneration: null,
    now: surfaceTestTime,
  };
  return { binding, request: native };
}

export function surfaceStoreContract(
  backend: string,
  createFixture: (tenants: SurfaceTenant[]) => Promise<SurfaceFixture>,
) {
  describe(backend + " surface store", () => {
    let left: SurfaceTenant;
    let right: SurfaceTenant;
    let fixture: SurfaceFixture;
    let database: Database;

    beforeEach(async () => {
      left = surfaceTenant();
      right = surfaceTenant();
      fixture = await createFixture([left, right]);
      ({ database } = fixture);
    });

    it("identity is unique within the exact workspace and drops on member removal", async () => {
      const another = surfaceTenant();
      another.organizationId = left.organizationId;
      another.userId = left.userId;
      another.connection.organizationId = left.organizationId;
      await fixture.restoreConnection(another);
      const key = {
        organizationId: left.organizationId,
        workspaceId: left.connection.linearOrganizationId,
        providerUserId: "human",
      };
      const input = { ...key, userId: left.userId, label: "Test human", now: surfaceTestTime };
      assert.ok(await database.createSurfaceIdentity(input));
      assert.equal(await database.createSurfaceIdentity(input), undefined);
      assert.equal(
        await database.createSurfaceIdentity({
          ...input,
          providerUserId: "other",
          userId: right.userId,
        }),
        undefined,
      );
      assert.equal(
        await database.createSurfaceIdentity({
          ...input,
          providerUserId: left.connection.appUserId,
        }),
        undefined,
      );
      assert.equal(
        await database.createSurfaceIdentity({
          ...input,
          workspaceId: right.connection.linearOrganizationId,
        }),
        undefined,
      );
      assert.ok(
        await database.createSurfaceIdentity({
          ...input,
          workspaceId: another.connection.linearOrganizationId,
        }),
      );
      assert.ok(
        await database.createSurfaceIdentity({
          ...input,
          organizationId: right.organizationId,
          userId: right.userId,
          workspaceId: right.connection.linearOrganizationId,
        }),
      );
      assert.equal((await database.findSurfaceIdentity(key))?.userId, left.userId);
      assert.equal(
        await database.findSurfaceIdentity({ ...key, organizationId: right.organizationId }),
        undefined,
      );
      const memberScope = {
        organizationId: left.organizationId,
        workspaceId: key.workspaceId,
        userId: left.userId,
      };
      const memberships = await database.listSurfaceIdentities(memberScope);
      assert.deepEqual(
        memberships.map(({ providerUserId }) => providerUserId),
        ["human"],
      );
      assert.deepEqual(
        await database.listSurfaceIdentities({
          ...memberScope,
          organizationId: right.organizationId,
        }),
        [],
      );
      const extra = await database.createSurfaceIdentity({ ...input, providerUserId: "extra" });
      assert.ok(extra);
      assert.equal(
        await database.removeSurfaceIdentity({ ...extra, organizationId: right.organizationId }),
        false,
      );
      assert.equal(await database.removeSurfaceIdentity(extra), true);
      assert.equal(await database.findSurfaceIdentity(extra), undefined);

      const otherKey = { ...key, workspaceId: another.connection.linearOrganizationId };
      const unlinkOnDisconnect = await database.createSurfaceIdentity({
        ...otherKey,
        providerUserId: "second-member",
        userId: left.userId + "-member",
        label: "Member",
        now: surfaceTestTime,
      });
      assert.ok(unlinkOnDisconnect);
      await fixture.removeMember(left);
      assert.equal(await database.findSurfaceIdentity(otherKey), undefined);
      assert.ok(await database.findSurfaceIdentity(unlinkOnDisconnect));
      await fixture.removeConnection(another);
      await fixture.restoreConnection(another);
      assert.equal(await database.findSurfaceIdentity(unlinkOnDisconnect), undefined);
      assert.equal(await database.findSurfaceIdentity(key), undefined);
      assert.ok(
        await database.findSurfaceIdentity({
          ...key,
          organizationId: right.organizationId,
          workspaceId: right.connection.linearOrganizationId,
        }),
      );
    });

    it("a policy cannot reference another tenant connection or profile", async () => {
      const leftProfile = await prepareProfile(database, left);
      const rightProfile = await prepareProfile(database, right);
      const input = policyInput(left, leftProfile.request);
      assert.equal(
        await database.saveSurfacePolicy({ ...input, connectionId: right.connection.id }),
        undefined,
      );
      assert.equal(
        await database.saveSurfacePolicy({ ...input, profileId: rightProfile.profile.id }),
        undefined,
      );
      assert.equal(await database.saveSurfacePolicy({ ...input, profileVersion: 2 }), undefined);
      assert.equal(await database.saveSurfacePolicy({ ...input, enabled: true }), undefined);
      assert.equal(
        await database.saveSurfacePolicy({
          ...input,
          enabled: true,
          verifiedAppHandle: "invalid\u202ehandle",
        }),
        undefined,
      );
      assert.equal(
        await database.saveSurfacePolicy({
          ...input,
          enabled: true,
          verifiedAppHandle: "x".repeat(257),
        }),
        undefined,
      );
      assert.equal(
        await database.saveSurfacePolicy({
          ...input,
          enabled: true,
          verifiedAppHandle: "paseo",
          appUserId: right.connection.appUserId,
        }),
        undefined,
      );
      const enabled = await database.saveSurfacePolicy({
        ...input,
        enabled: true,
        verifiedAppHandle: "Paseo App",
        publishAnswers: true,
        moveOnBegin: "started",
      });
      assert.ok(enabled);
      assert.equal(enabled.verifiedAppHandle, "Paseo App");
      assert.equal(enabled.publishAnswers, true);
      assert.equal(enabled.moveOnBegin, "started");
      assert.equal(await database.saveSurfacePolicy(input), undefined);
      assert.equal(
        (await database.saveSurfacePolicy({ ...input, expectedRevision: 1 }))?.revision,
        2,
      );
      assert.equal((await database.findSurfacePolicy(installation(left)))?.enabled, false);
      assert.equal(
        await database.findSurfacePolicy({
          ...installation(left),
          organizationId: right.organizationId,
        }),
        undefined,
      );
      assert.equal(
        await database.findSurfacePolicy({
          ...installation(left),
          appUserId: right.connection.appUserId,
        }),
        undefined,
      );
      await fixture.removeConnection(left);
      assert.equal(await database.findSurfacePolicy(installation(left)), undefined);
      await fixture.restoreConnection(left);
      assert.equal(await database.findSurfacePolicy(installation(left)), undefined);
    });

    it("a new policy and preexisting profile default to disabled and private", async () => {
      const { profile, request } = await prepareProfile(database, left);
      assert.equal(await database.findSurfacePolicy(installation(left)), undefined);
      const policy = await database.saveSurfacePolicy(policyInput(left, request));
      assert.ok(policy);
      assert.equal(policy.enabled, false);
      assert.equal(policy.publishAnswers, false);
      assert.equal(policy.moveOnBegin, "unchanged");
      assert.equal(policy.moveOnFinish, "unchanged");
      assert.equal(policy.verifiedAppHandle, null);
      assert.equal(policy.revision, 1);
      assert.equal(profile.access, "private");
      assert.equal(profile.maxActive, 4);
      assert.equal(profile.linearTemplate, null);
      const session = await startFixtureSession(database, request);
      assert.equal(session.origin, "web");
      assert.equal(session.profileVersion, profile.version);
    });

    it("one active binding per native session and installation survives concurrent supersede", async () => {
      const { binding, request } = await prepareBinding(database, left);
      const first = await database.supersedeSurfaceBinding(binding);
      assert.ok(first);
      assert.equal(first.generation, 1);
      const second = await startFixtureSession(database, request);
      const third = await startFixtureSession(database, request);
      const contenders = await Promise.all(
        [second, third].map((session) =>
          database.supersedeSurfaceBinding({
            ...binding,
            expectedGeneration: 1,
            sessionId: session.id,
          }),
        ),
      );
      const winners = contenders.filter((row) => row !== undefined);
      assert.equal(winners.length, 1);
      assert.equal(winners[0]?.generation, 2);
      assert.deepEqual(await database.findSurfaceBinding(binding), winners[0]);
      assert.equal(
        (await database.findSurfaceBindingGeneration(binding, 1))?.sessionId,
        first.sessionId,
      );
      assert.ok((await database.findSurfaceBindingGeneration(binding, 1))?.supersededAt);
      await fixture.removeConnection(left);
      assert.equal(await database.findSurfaceBinding(binding), undefined);
      assert.equal((await database.findSurfaceBindingGeneration(binding, 1))?.id, first.id);
      await fixture.restoreConnection({
        ...left,
        connection: { ...left.connection, id: randomUUID() },
      });
      assert.equal(await database.findSurfaceBinding(binding), undefined);
      assert.equal((await database.findSurfaceBindingGeneration(binding, 2))?.id, winners[0]?.id);
    });

    it("a policy revision hides the old binding and replacement requires its current generation", async () => {
      const { binding, request } = await prepareBinding(database, left);
      const first = await database.supersedeSurfaceBinding(binding);
      assert.ok(first);
      const second = await database.supersedeSurfaceBinding({
        ...binding,
        expectedGeneration: first.generation,
        sessionId: (await startFixtureSession(database, request)).id,
      });
      assert.ok(second);
      assert.equal(second.generation, 2);
      assert.deepEqual(await database.findSurfaceBinding(binding), second);

      const revisedAt = new Date(binding.now.getTime() + 1_000);
      const policy = await database.saveSurfacePolicy({
        ...policyInput(left, request),
        expectedRevision: binding.policyRevision,
        enabled: true,
        verifiedAppHandle: "paseo",
        publishAnswers: true,
        now: revisedAt,
      });
      assert.equal(policy?.revision, 2);
      assert.equal(await database.findSurfaceBinding(binding), undefined);
      assert.deepEqual(await database.findSurfaceBindingGeneration(binding, 2), second);

      const eligible = await startFixtureSession(database, request);
      const { nativeRequester: _nativeRequester, ...webRequest } = request;
      const web = await startFixtureSession(database, webRequest);
      const replacement = {
        ...binding,
        policyRevision: 2,
        sessionId: eligible.id,
        now: revisedAt,
      };
      for (const expectedGeneration of [null, first.generation]) {
        assert.equal(
          await database.supersedeSurfaceBinding({ ...replacement, expectedGeneration }),
          undefined,
        );
      }
      const exact = { ...replacement, expectedGeneration: second.generation };
      assert.equal(
        await database.supersedeSurfaceBinding({
          ...exact,
          policyRevision: binding.policyRevision,
        }),
        undefined,
      );
      for (const sessionId of [second.sessionId, web.id]) {
        assert.equal(await database.supersedeSurfaceBinding({ ...exact, sessionId }), undefined);
      }
      assert.equal(await database.findSurfaceBinding(binding), undefined);
      assert.deepEqual(await database.findSurfaceBindingGeneration(binding, 2), second);
      assert.equal(await database.findSurfaceBindingGeneration(binding, 3), undefined);

      const current = await database.supersedeSurfaceBinding(exact);
      assert.ok(current);
      assert.equal(current.generation, 3);
      assert.equal(current.policyRevision, 2);
      assert.equal(current.sessionId, eligible.id);
      assert.deepEqual(await database.findSurfaceBinding(binding), current);
      assert.deepEqual(await database.findSurfaceBindingGeneration(binding, 1), {
        ...first,
        supersededAt: binding.now,
      });
      assert.deepEqual(await database.findSurfaceBindingGeneration(binding, 2), {
        ...second,
        supersededAt: revisedAt,
      });
    });

    it("retains the native session fence when an installation moves to a different tenant", async () => {
      const { binding } = await prepareBinding(database, left);
      const original = await database.supersedeSurfaceBinding(binding);
      assert.ok(original);
      await fixture.removeConnection(left);
      const moved = {
        ...right,
        connection: { ...left.connection, id: randomUUID(), organizationId: right.organizationId },
      };
      await fixture.restoreConnection(moved);
      const { binding: replacement } = await prepareBinding(database, moved);
      const replay = { ...replacement, nativeSessionId: binding.nativeSessionId };
      assert.equal(await database.supersedeSurfaceBinding(replay), undefined);
      assert.equal(await database.findSurfaceBinding(replay), undefined);
      assert.equal(await database.findSurfaceBindingGeneration(replay, 1), undefined);
      assert.equal((await database.findSurfaceBindingGeneration(binding, 1))?.id, original.id);
    });

    it("two native sessions on one issue have independent bindings", async () => {
      const { binding, request } = await prepareBinding(database, left);
      const next = {
        ...binding,
        nativeSessionId: randomUUID(),
        sessionId: (await startFixtureSession(database, request)).id,
      };
      assert.ok(await database.supersedeSurfaceBinding(binding));
      assert.ok(await database.supersedeSurfaceBinding(next));
      assert.equal((await database.findSurfaceBinding(binding))?.sessionId, binding.sessionId);
      assert.equal((await database.findSurfaceBinding(next))?.sessionId, next.sessionId);
    });

    it("native starts enforce private ownership and profile caps while web starts keep their behavior", async () => {
      const { profile, settings, request } = await prepareProfile(database, left);
      const updated = await database.saveSessionProfile({
        ...settings,
        id: profile.id,
        version: profile.version,
        maxActive: 1,
        linearTemplate: "{{request}}",
      });
      if (typeof updated === "string") throw new Error(updated);
      assert.equal(updated.linearTemplate, "{{request}}");
      const edited = await database.saveSessionProfile({
        ...settings,
        id: updated.id,
        version: updated.version,
        name: "Edited in browser",
      });
      if (typeof edited === "string") throw new Error(edited);
      assert.equal(edited.linearTemplate, "{{request}}");
      assert.equal(edited.maxActive, 1);
      const requestAtCurrentVersion = { ...request, profileVersion: edited.version };
      const member = {
        ...request.principal,
        userId: left.userId + "-member",
        role: "member" as const,
      };
      const native = await nativeRequest(database, left, requestAtCurrentVersion);
      const memberNative = await nativeRequest(database, left, {
        ...requestAtCurrentVersion,
        principal: member,
      });
      assert.deepEqual(await database.startInteractiveSession(memberNative), {
        status: "refused",
        code: "forbidden",
      });
      const first = await startFixtureSession(database, native);
      assert.equal(first.origin, "linear");
      assert.equal(first.requesterIdentityId, native.nativeRequester?.identityId);
      assert.deepEqual(
        await database.startInteractiveSession({ ...native, idempotencyKey: randomUUID() }),
        { status: "refused", code: "active_limit" },
      );
      const web = await startFixtureSession(database, {
        ...requestAtCurrentVersion,
        principal: member,
      });
      assert.equal(web.origin, "web");
      assert.equal(web.requesterIdentityId, null);
      await fixture.removeMember(left);
      assert.deepEqual(await database.startInteractiveSession(native), {
        status: "refused",
        code: "forbidden",
      });
      assert.equal(
        (await database.findInteractiveSession(left.organizationId, first.id))?.session
          .requesterIdentityId,
        first.requesterIdentityId,
      );
    });

    it("preserves exact scope and binding fences for 2,048 generated cases", async () => {
      const { binding, request } = await prepareBinding(database, left);
      const rightRequest = await prepareProfile(database, right);
      assert.ok(await database.saveSurfacePolicy(policyInput(right, rightRequest.request)));
      const otherSession = await startFixtureSession(database, rightRequest.request);
      const alternate = await startFixtureSession(database, request);
      const identity = {
        organizationId: left.organizationId,
        workspaceId: binding.workspaceId,
        providerUserId: "human",
      };
      assert.ok(
        await database.createSurfaceIdentity({
          ...identity,
          userId: left.userId,
          label: "Human",
          now: surfaceTestTime,
        }),
      );
      assert.ok(await database.supersedeSurfaceBinding(binding));
      assert.ok(
        await database.supersedeSurfaceBinding({
          ...binding,
          sessionId: alternate.id,
          expectedGeneration: 1,
        }),
      );
      // Exhaustively replay the 11 binary input dimensions in numeric order.
      for (let mask = 0; mask < 2_048; mask++) {
        const flag = (bit: number) => (mask & (1 << bit)) !== 0;
        await checkGeneratedSurfaceCase(database, mask, flag, {
          left,
          right,
          binding,
          alternate,
          identity,
          otherSession,
        });
      }
      assert.equal((await database.findSurfaceBinding(binding))?.generation, 2);
      assert.equal(await database.findSurfaceBindingGeneration(binding, 3), undefined);
    }, 90_000);
  });
}

interface GeneratedSurfaceCase {
  left: SurfaceTenant;
  right: SurfaceTenant;
  binding: BindingInput;
  alternate: { id: string };
  identity: { providerUserId: string };
  otherSession: { id: string };
}

async function checkGeneratedSurfaceCase(
  database: Database,
  mask: number,
  flag: (bit: number) => boolean,
  { left, right, binding, alternate, identity, otherSession }: GeneratedSurfaceCase,
) {
  const key = generatedBindingKey(flag, { left, right, binding });
  const generation = flag(5) ? 1 : 2;
  const exact = (mask & 31) === 0;
  await assertGeneratedSurfaceReads(database, {
    mask,
    key,
    generation,
    expectedSessions: exact ? [binding.sessionId, alternate.id] : [],
    providerUserId: identity.providerUserId,
    leftUserId: left.userId,
    disabledInstallation: flag(7) ? installation(right) : undefined,
  });
  if (!exact || (mask & 1_792) !== 0) {
    await assertGeneratedSurfaceWrite(database, flag, {
      binding,
      key,
      generation,
      alternate,
      otherSession,
    });
  }
}

function generatedBindingKey(
  flag: (bit: number) => boolean,
  { left, right, binding }: Pick<GeneratedSurfaceCase, "left" | "right" | "binding">,
): BindingKey {
  return {
    organizationId: flag(0) ? right.organizationId : left.organizationId,
    workspaceId: flag(1) ? right.connection.linearOrganizationId : binding.workspaceId,
    applicationId: flag(2) ? "other-app" : binding.applicationId,
    appUserId: flag(3) ? "other-actor" : binding.appUserId,
    nativeSessionId: flag(4) ? "other-native" : binding.nativeSessionId,
  };
}

async function assertGeneratedSurfaceWrite(
  database: Database,
  flag: (bit: number) => boolean,
  {
    binding,
    key,
    generation,
    alternate,
    otherSession,
  }: Pick<GeneratedSurfaceCase, "binding" | "alternate" | "otherSession"> & {
    key: BindingKey;
    generation: number;
  },
) {
  assert.equal(
    await database.supersedeSurfaceBinding({
      ...binding,
      ...key,
      expectedGeneration: flag(8) ? 2 : generation,
      sessionId: flag(8) ? otherSession.id : alternate.id,
      policyRevision: flag(9) ? 15 : 1,
      teamId: flag(10) ? "out-of-scope" : binding.teamId,
    }),
    undefined,
  );
}

async function assertGeneratedSurfaceReads(
  database: Database,
  {
    mask,
    key,
    generation,
    expectedSessions,
    providerUserId,
    leftUserId,
    disabledInstallation,
  }: {
    mask: number;
    key: BindingKey;
    generation: number;
    expectedSessions: string[];
    providerUserId: string;
    leftUserId: string;
    disabledInstallation: LinearInstallation | undefined;
  },
) {
  assert.equal(
    (await database.findSurfaceBinding(key))?.sessionId,
    expectedSessions[1],
    "case " + mask,
  );
  assert.equal(
    (await database.findSurfaceBindingGeneration(key, generation))?.sessionId,
    expectedSessions[generation - 1],
  );
  const identity = await database.findSurfaceIdentity({
    organizationId: key.organizationId,
    workspaceId: key.workspaceId,
    providerUserId: (mask & 64) === 0 ? providerUserId : "other-human",
  });
  assert.equal(identity?.userId, (mask & 67) === 0 ? leftUserId : undefined);
  const policy = await database.findSurfacePolicy(disabledInstallation ?? key);
  const expectedInstallEnabled = (mask & 15) === 0 ? true : undefined;
  assert.equal(policy?.enabled, disabledInstallation ? false : expectedInstallEnabled);
}
