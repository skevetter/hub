import { describe, expect, it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { SessionEventBus } from "./bus.js";
import {
  InteractiveSessionService,
  type SaveProfileForm,
  type SessionCoordinator,
} from "./service.js";
import type { SessionRecord } from "./types.js";

const now = new Date("2026-11-20T00:00:00Z");
const id = "12345678-1234-1234-1234-123456789abc";
const scope = { organizationSlug: "org", sessionId: id };
const launch = {
  daemonId: "daemon",
  cwd: "/repo",
  worktree: null,
  provider: "omp",
  model: null,
  mode: "ask",
  thinkingOptionId: null,
  providerOptions: {},
} as const;
const profile: SaveProfileForm = {
  ...launch,
  organizationSlug: "org",
  name: "Profile",
  id: null,
  version: null,
  fullAccessAcknowledged: false,
  status: "active",
};

function fixtureSession(): SessionRecord {
  return {
    id,
    organizationId: "org",
    profileId: id,
    profileVersion: 1,
    launch,
    daemonId: "daemon",
    title: "Session",
    state: "idle",
    stateReason: null,
    generation: 2,
    turn: 3,
    daemonAgentId: null,
    daemonWorkspaceId: null,
    hubSeq: 4,
    commandSeq: 0,
    startedByUserId: "owner",
    startIdempotencyKey: id,
    startRequestHash: "fixture",
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    closedByUserId: null,
  };
}

function fixtureAuth(): AuthServer {
  return {
    handle: vi.fn(),
    resources: vi.fn(),
    resolveOrganizationAccess: vi.fn(),
    close: vi.fn(),
    rejectCookieMutation: () => undefined,
    resolveAccount: async () => ({
      account: { id: "owner", name: "Owner", email: "owner@hub.test" },
      session: { id: "browser", activeOrganizationId: "org" },
      isInstanceOperator: false,
    }),
  };
}

function setup() {
  const database = createMemoryDatabase({
    memberships: [
      {
        membershipId: "owner",
        userId: "owner",
        role: "owner",
        organizationId: "org",
        organizationSlug: "org",
        organizationName: "Org",
      },
    ],
  });
  const session = fixtureSession();
  database.findInteractiveSession = async () => ({
    session,
    participants: [
      {
        organizationId: "org",
        sessionId: id,
        userId: "owner",
        role: "controller",
        addedByUserId: null,
        createdAt: now,
      },
    ],
  });
  database.listInteractiveSessions = async () => ({ sessions: [session], nextCursor: null });
  const coordinator = {
    start: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    replaceAgent: vi.fn(),
  } satisfies SessionCoordinator;
  const validateAgentConfiguration = vi.fn(() => Promise.resolve({ valid: true as const }));
  const service = new InteractiveSessionService({
    database,
    coordinator,
    auth: fixtureAuth(),
    bus: new SessionEventBus(),
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    connectionForDaemon: () => ({ validateAgentConfiguration }),
    bodyCutoff: () => null,
    now: () => now,
    scrubValues: [],
  });
  const request = new Request("https://hub.test", {
    method: "POST",
    headers: { cookie: "fixture" },
  });
  return { database, service, coordinator, request, validateAgentConfiguration };
}

describe("interactive session command, profile, and list policy", () => {
  it("validates a start message and dispatches each allowed command with its control values", async () => {
    const { service, coordinator, request } = setup();
    const start = {
      kind: "start",
      organizationSlug: "org",
      profileId: id,
      profileVersion: 2,
      idempotencyKey: "start",
      participants: [],
      message: "",
    } as const;
    expect(await service.command(request, start)).toEqual({
      outcome: "refused",
      code: "message_too_long",
    });
    const startInput = { ...start, message: "begin" };
    await service.command(request, startInput);
    expect(coordinator.start).toHaveBeenCalledWith(
      { organizationId: "org", userId: "owner", role: "owner" },
      {
        profileId: id,
        profileVersion: 2,
        idempotencyKey: "start",
        message: "begin",
        participants: [],
      },
    );
    const control = { ...scope, idempotencyKey: "control", generation: 2 };
    for (const kind of ["stop", "close", "replace", "retry", "send"] as const) {
      await service.command(request, {
        kind,
        ...control,
        commandId: "retry-target",
        message: "send",
        delivery: "queue",
      });
      expect(coordinator[kind === "replace" ? "replaceAgent" : kind]).toHaveBeenCalledTimes(1);
    }
  });

  it("validates profile data before daemon lookup or configuration validation", async () => {
    const { service, request, validateAgentConfiguration } = setup();
    expect(await service.saveProfile(request, { ...profile, name: "" })).toMatchObject({
      code: "invalid_profile",
    });
    expect(
      await service.saveProfile(request, { ...profile, provider: "codex", mode: "full" }),
    ).toMatchObject({ code: "invalid_mode" });
    expect(await service.saveProfile(request, { ...profile, id })).toMatchObject({
      code: "profile_unavailable",
    });
    expect(await service.saveProfile(request, profile)).toMatchObject({
      code: "daemon_unavailable",
    });
    expect(validateAgentConfiguration).not.toHaveBeenCalled();
  });

  it("preserves list fallbacks and rejects malformed list cursor payloads", async () => {
    const { service, request } = setup();
    const input = { organizationSlug: "org", filter: "all" as const };
    const valid = Buffer.from(JSON.stringify([now.toISOString(), id])).toString("base64url");
    const page = await service.list(request, { ...input, cursor: valid });
    expect(page).toMatchObject({
      sessions: [
        {
          id,
          profile: { name: "Session" },
          daemon: { id: "daemon", slug: "", connection: "offline" },
          startedBy: null,
          closedAt: null,
          createdAt: now.toISOString(),
        },
      ],
      nextCursor: null,
    });
    for (const value of [
      [],
      [null, id],
      ["2026-11-20", id],
      [now.toISOString(), "invalid"],
      [now.toISOString(), id, 0],
    ]) {
      const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
      const error = await service
        .list(request, { ...input, cursor })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        name: "SessionReadError",
        message: "invalid_request",
        code: "invalid_request",
      });
    }
  });
});
