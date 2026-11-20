import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { AuthServer } from "../auth/server.js";
import type { QueryHandle } from "../db/runtime/index.js";
import { createMemoryDatabase } from "../db/memory.js";
import { SessionEventBus } from "./bus.js";
import { InteractiveSessionService } from "./service.js";

const organizationId = "org";
const sessionId = randomUUID();
const daemonId = randomUUID();
const profileId = randomUUID();
const now = new Date("2026-11-20T00:00:00Z");
const launch = {
  daemonId,
  cwd: "/repo",
  worktree: null,
  provider: "omp",
  model: null,
  mode: "ask",
  thinkingOptionId: null,
  providerOptions: {},
};
const users = [
  { userId: "owner", role: "owner" as const },
  { userId: "admin", role: "admin" as const },
  { userId: "controller", role: "member" as const },
  { userId: "viewer", role: "member" as const },
  { userId: "outsider", role: "member" as const },
];

function request(userId: string, origin?: string) {
  return new Request("https://hub.test", {
    method: origin === undefined ? "GET" : "POST",
    headers: { cookie: userId, ...(origin === undefined ? {} : { origin }) },
  });
}

describe("interactive session service", () => {
  const database = createMemoryDatabase({
    memberships: users.map((user) => ({
      ...user,
      organizationId,
      organizationSlug: "org",
      organizationName: "Org",
      membershipId: user.userId,
    })),
  });
  const session = {
    id: sessionId,
    organizationId,
    profileId,
    profileVersion: 1,
    launch,
    daemonId,
    title: "Session",
    state: "running" as const,
    stateReason: null,
    generation: 1,
    turn: 2,
    daemonAgentId: "private-agent",
    daemonWorkspaceId: "private-workspace",
    hubSeq: 0,
    commandSeq: 0,
    startedByUserId: "controller",
    startIdempotencyKey: randomUUID(),
    startRequestHash: "private-hash",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closedByUserId: null,
  };
  const participants = [
    { userId: "controller", role: "controller" as const },
    { userId: "viewer", role: "viewer" as const },
  ].map(({ userId, role }) => ({
    userId,
    role,
    organizationId,
    sessionId,
    addedByUserId: null,
    createdAt: now,
  }));
  const auth: AuthServer = {
    handle: vi.fn(),
    resources: vi.fn(),
    resolveOrganizationAccess: vi.fn(),
    close: vi.fn(),
    async resolveAccount(req) {
      const id = req.headers.get("cookie")!;
      return {
        account: { id, name: id, email: id + "@example.test" },
        session: { id, activeOrganizationId: null },
        isInstanceOperator: false,
      };
    },
    rejectCookieMutation(req, policy) {
      expect(policy).toEqual({ requireOrigin: true });
      return req.headers.get("origin") === "https://hub.test"
        ? undefined
        : new Response(null, { status: 403 });
    },
  };
  const accepted = {
    outcome: "accepted" as const,
    sessionId,
    commandId: randomUUID(),
    status: "pending" as const,
    replayed: false,
  };
  const coordinator = {
    start: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    replaceAgent: vi.fn(),
  };
  const validate = vi.fn(async () => ({ valid: true as const }));
  const bus = new SessionEventBus();
  const saveInput = {
    organizationSlug: "org",
    id: null,
    version: null,
    name: "Profile",
    ...launch,
    fullAccessAcknowledged: false,
    status: "active" as const,
  };
  const profile = {
    ...saveInput,
    id: profileId,
    version: 1,
    organizationId,
    createdByUserId: "owner",
    createdAt: now,
    updatedAt: now,
  };
  const pool: QueryHandle = {
    async query() {
      throw new Error("Missing query fixture");
    },
  };
  let query: MockInstance<QueryHandle["query"]>;
  const save = vi.fn<typeof database.saveSessionProfile>();

  const service = new InteractiveSessionService({
    database,
    auth,
    coordinator,
    bus,
    pool,
    bodyCutoff: () => null,
    connectionForDaemon: () => ({ validateAgentConfiguration: validate }),
  });
  const scope = { organizationSlug: "org", sessionId };
  const control = { ...scope, generation: 1, idempotencyKey: randomUUID() };

  let findSession: MockInstance<typeof database.findInteractiveSession>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    query = vi.spyOn(pool, "query");
    query.mockResolvedValue({
      rows: users.map(({ userId }) => ({ id: userId, name: userId })),
      rowCount: users.length,
    });
    save.mockResolvedValue(profile);
    findSession = vi
      .spyOn(database, "findInteractiveSession")
      .mockResolvedValue({ session, participants });
    vi.spyOn(database, "findSessionProfile").mockResolvedValue(profile);
    vi.spyOn(database, "findDaemonForOrganization").mockResolvedValue({
      id: daemonId,
      slug: "daemon",
      status: "active",
      presence: "connected",
      registeredByCliCredentialId: randomUUID(),
      registeredByApiKeyId: null,
      permissions: ["hub.execute"],
      createdAt: now,
      connectedAt: now,
      disconnectedAt: null,
      lastSeenAt: now,
      machineId: randomUUID(),
      serverId: "private-server",
      credentialVerifier: "private-verifier",
      daemonPublicKey: "private-public-key",
    });
    vi.spyOn(database, "saveSessionProfile").mockImplementation(save);
    coordinator.stop.mockResolvedValue(accepted);
    coordinator.send.mockResolvedValue({ ...accepted, replayed: true });
    coordinator.start.mockResolvedValue(accepted);
  });

  it("hides a session from a non-participating member and permits an admin to view and stop but not send", async () => {
    await expect(service.snapshot(request("outsider"), scope)).rejects.toMatchObject({
      message: "not_found",
    });
    const snapshot = await service.snapshot(request("admin"), scope);
    expect(snapshot.session.turn).toBe(2);
    expect(snapshot.capabilities).toMatchObject({ send: false, stop: true });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-/);
    const admin = request("admin", "https://hub.test");
    await expect(
      service.command(admin, { ...control, kind: "send", delivery: "steer", message: "hello" }),
    ).resolves.toEqual({ outcome: "refused", code: "forbidden" });
    expect(coordinator.send).not.toHaveBeenCalled();
    await expect(service.command(admin, { ...control, kind: "stop" })).resolves.toEqual(accepted);
    expect(coordinator.stop).toHaveBeenCalledWith(
      { organizationId, userId: "admin", role: "admin" },
      expect.objectContaining({ idempotencyKey: control.idempotencyKey }),
    );
  });

  it("denies a removed starter stop and close while an admin can still stop", async () => {
    findSession.mockResolvedValue({
      session,
      participants: participants.filter(({ userId }) => userId !== session.startedByUserId),
    });

    const starter = request("controller", "https://hub.test");
    await expect(service.snapshot(starter, scope)).rejects.toMatchObject({ message: "not_found" });
    for (const kind of ["stop", "close"] as const) {
      await expect(service.command(starter, { ...control, kind })).resolves.toEqual({
        outcome: "refused",
        code: "not_found",
      });
    }
    expect(coordinator.stop).not.toHaveBeenCalled();
    expect(coordinator.close).not.toHaveBeenCalled();

    const admin = request("admin", "https://hub.test");
    await expect(service.command(admin, { ...control, kind: "stop" })).resolves.toEqual(accepted);
    expect(coordinator.stop).toHaveBeenCalledExactlyOnceWith(
      { organizationId, userId: "admin", role: "admin" },
      { sessionId, generation: control.generation, idempotencyKey: control.idempotencyKey },
    );
  });

  it("refuses participant management by a starter demoted to viewer", async () => {
    findSession.mockResolvedValue({
      session,
      participants: [{ ...participants[0]!, role: "viewer" }, participants[1]!],
    });
    const set = vi.spyOn(database, "setInteractiveSessionParticipant");
    await expect(
      service.participants(request("controller", "https://hub.test"), {
        ...scope,
        userId: "viewer",
        role: null,
      }),
    ).resolves.toEqual({ outcome: "refused", code: "forbidden" });
    expect(set).not.toHaveBeenCalled();
  });

  it("passes delivery, idempotency keys and replay through the coordinator and checks Origin first", async () => {
    const input = {
      ...control,
      kind: "send" as const,
      delivery: "queue" as const,
      message: "hello",
    };
    await expect(
      service.command(request("controller", "https://other.test"), input),
    ).resolves.toEqual({ outcome: "refused", code: "forbidden" });
    await expect(service.command(request("controller", ""), input)).resolves.toEqual({
      outcome: "refused",
      code: "forbidden",
    });
    expect(coordinator.send).not.toHaveBeenCalled();
    await expect(
      service.command(request("controller", "https://hub.test"), input),
    ).resolves.toEqual({ ...accepted, replayed: true });
    expect(coordinator.send).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "controller" }),
      expect.objectContaining({ delivery: "queue", idempotencyKey: input.idempotencyKey }),
    );
    const start = {
      kind: "start" as const,
      organizationSlug: "org",
      profileId,
      profileVersion: 1,
      idempotencyKey: randomUUID(),
      message: "first",
      participants: [{ userId: "viewer", role: "viewer" as const }],
    };
    await expect(
      service.command(request("controller", "https://hub.test"), start),
    ).resolves.toEqual(accepted);
    expect(coordinator.start).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "controller" }),
      expect.objectContaining({
        idempotencyKey: start.idempotencyKey,
        participants: start.participants,
      }),
    );
  });

  it("refuses omp without a mode and full mode without acknowledgement before validation", async () => {
    for (const mode of [null, "full"]) {
      await expect(
        service.saveProfile(request("owner", "https://hub.test"), { ...saveInput, mode }),
      ).resolves.toEqual({ outcome: "refused", code: "invalid_mode" });
    }
    expect(validate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("permits owners and personal enrollers and refuses other admins before contacting the daemon", async () => {
    query.mockResolvedValueOnce({ rows: [{ enrolled_by: "controller" }], rowCount: 1 });
    await expect(
      service.saveProfile(request("admin", "https://hub.test"), saveInput),
    ).resolves.toEqual({ outcome: "refused", code: "forbidden" });
    expect(validate).not.toHaveBeenCalled();
    await expect(
      service.saveProfile(request("owner", "https://hub.test"), saveInput),
    ).resolves.toMatchObject({ outcome: "saved" });
    query.mockResolvedValueOnce({ rows: [{ enrolled_by: "admin" }], rowCount: 1 });
    await expect(
      service.saveProfile(request("admin", "https://hub.test"), saveInput),
    ).resolves.toMatchObject({ outcome: "saved" });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("publishes access changes only after a participant mutation succeeds", async () => {
    vi.spyOn(database, "setInteractiveSessionParticipant").mockResolvedValue("removed");
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(sessionId, listener);
    try {
      await expect(
        service.participants(request("admin", "https://hub.test"), {
          ...scope,
          userId: "viewer",
          role: null,
        }),
      ).resolves.toMatchObject({ outcome: "accepted" });
      expect(listener).toHaveBeenCalledWith({ kind: "access_changed" });
    } finally {
      unsubscribe();
    }
  });
});
