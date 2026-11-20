import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createApplicationRuntime } from "../application-runtime.js";
import { accountStateSchema } from "../auth/organization-contract.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { AuthServer } from "../auth/server.js";
import { TestDaemon } from "../daemons/test-utils/hub-harness.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { createFetchServer } from "../http/node-server.js";
import { beginProductionShutdown, startProductionRuntime } from "../index.js";
import { startApplication, stopApplication, type ApplicationRuntime } from "../server/runtime.js";
import { handleInteractiveSessionEvents } from "../routes/api/v1/interactive-sessions/$sessionId/events.js";
import { InteractiveSessionCoordinator, type CommandOutcome } from "./coordinator.js";
import { readInteractiveSessionSettings } from "./settings.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  ["PASEO_HUB_INTERACTIVE_SESSIONS", "yes"],
  ["PASEO_HUB_SESSION_MAX_ACTIVE_PER_DAEMON", "51"],
  ["PASEO_HUB_SESSION_MAX_QUEUED", "101"],
])("refuses startup with an invalid %s before connecting to the database", async (name, value) => {
  vi.stubEnv("DATABASE_URL", "postgres://postgres@127.0.0.1:1/postgres");
  vi.stubEnv(name, value);
  try {
    await expect(startProductionRuntime()).rejects.toThrow(name);
  } finally {
    await stopApplication().catch(() => undefined);
  }
});

it("keeps the disabled runtime off the daemon and refuses its stream", async () => {
  const begin = vi.spyOn(InteractiveSessionCoordinator.prototype, "begin");
  const recover = vi.spyOn(InteractiveSessionCoordinator.prototype, "recoverDaemon");
  const fixture = await embeddedHub();
  try {
    const { runtime, daemon, origin } = await fixture.start(false);
    expect(begin).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(daemon.timelineAgentIds).toEqual([]);
    const response = await handleInteractiveSessionEvents({
      request: new Request(origin + "/events?organization=sessions", { headers: fixture.headers }),
      params: { sessionId: randomUUID() },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
    expect(runtime.interactiveSessions).toBeNull();
    const state = await fixture.accountState(runtime);
    expect(state.status).toBe("active");
    expect(state).not.toHaveProperty("features");
  } finally {
    await fixture.close();
  }
}, 120_000);

it("starts, steers, queues and stops through the real embedded runtime, then re-watches on restart", async () => {
  const fixture = await embeddedHub();
  try {
    const { runtime, daemon, origin } = await fixture.start(true);
    const state = await fixture.accountState(runtime);
    expect(state).toMatchObject({ status: "active", features: { interactiveSessions: true } });
    const sessions = runtime.interactiveSessions;
    assert.ok(sessions);
    const { service } = sessions;
    const request = new Request(origin + "/sessions", { method: "POST", headers: fixture.headers });
    const profile = await service.saveProfile(request, {
      organizationSlug: "sessions",
      daemonId: daemon.daemonId,
      id: null,
      version: null,
      name: "Embedded session",
      cwd: "/workspace",
      worktree: null,
      provider: "opencode",
      model: null,
      mode: null,
      thinkingOptionId: null,
      fullAccessAcknowledged: false,
      status: "active",
    });
    assert.equal(profile.outcome, "saved");
    const start = accepted(
      await service.command(request, {
        kind: "start",
        organizationSlug: "sessions",
        profileId: profile.profile.id,
        profileVersion: profile.profile.version,
        idempotencyKey: randomUUID(),
        message: "first",
        participants: [],
      }),
    );
    const scope = { organizationSlug: "sessions", sessionId: start.sessionId };
    const snapshot = () => service.snapshot(request, scope);
    const agentId = "agent-isession:" + start.sessionId + ":1";
    await vi.waitFor(
      async () => {
        expect((await snapshot()).session.state).toBe("running");
        expect(daemon.timelineAgentIds).toEqual([agentId]);
        expect(daemon.createdAgent()["prompt"]).toBe("first");
      },
      { timeout: 5000 },
    );
    expect(daemon.createdAgent()).not.toHaveProperty("mcpServers");

    const command = { ...scope, generation: 1 };
    const steer = accepted(
      await service.command(request, {
        ...command,
        kind: "send",
        idempotencyKey: randomUUID(),
        message: "steer",
        delivery: "steer",
      }),
    );
    const queued = accepted(
      await service.command(request, {
        ...command,
        kind: "send",
        idempotencyKey: randomUUID(),
        message: "queued",
        delivery: "queue",
      }),
    );
    await vi.waitFor(
      async () => {
        expect(daemon.createdAgent()["prompt"]).toBe("steer");
        expect((await snapshot()).messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ commandId: steer.commandId, status: "delivered" }),
            expect.objectContaining({ commandId: queued.commandId, status: "queued" }),
          ]),
        );
      },
      { timeout: 5000 },
    );
    await daemon.completesTurnWithoutFinishTimeline(agentId);
    await vi.waitFor(() => expect(daemon.createdAgent()["prompt"]).toBe("queued"), {
      timeout: 5000,
    });

    accepted(
      await service.command(request, { ...command, kind: "stop", idempotencyKey: randomUUID() }),
    );
    await vi.waitFor(() => expect(daemon.controlActions()).toEqual(["interrupt"]), {
      timeout: 5000,
    });
    await vi.waitFor(async () => expect((await snapshot()).session.state).toBe("idle"), {
      timeout: 5000,
    });

    const stream = await handleInteractiveSessionEvents({
      request: new Request(origin + "/events?organization=sessions", { headers: fixture.headers }),
      params: { sessionId: start.sessionId },
    });
    expect(stream.status).toBe(200);
    await beginProductionShutdown();
    expect(await stream.text()).toContain('event: shutdown\ndata: {"reconnectMs":5000}');

    await fixture.stop();
    const restart = await fixture.start(true, daemon);
    assert.ok(restart.runtime.interactiveSessions);
    await vi.waitFor(() => expect(restart.daemon.timelineAgentIds).toEqual([agentId]), {
      timeout: 5000,
    });
    expect(restart.daemon.createdAgentRequestCount()).toBe(1);
    expect(restart.daemon.createdAgentCount()).toBe(1);
  } finally {
    await fixture.close();
  }
}, 120_000);

function accepted(outcome: CommandOutcome) {
  assert.equal(outcome.outcome, "accepted");
  return outcome;
}

async function embeddedHub() {
  const root = await mkdtemp(join(tmpdir(), "hub-sessions-"));
  const organization = { id: "sessions-org", slug: "sessions", name: "Sessions" };
  const account = { id: "sessions-owner", name: "Owner", email: "owner@example.test" };
  const membership = { id: "sessions-membership", role: "owner" as const };
  const access = {
    organization,
    account,
    membership,
    capabilities: capabilitiesFor(membership.role),
    session: { id: "test-session", activeOrganizationId: organization.id },
    isInstanceOperator: false,
  };
  const auth: AuthServer = {
    handle: vi.fn(),
    browserAccount: () =>
      Promise.resolve(
        Response.json({
          status: "active",
          ...access,
          memberships: [
            {
              ...organization,
              membershipId: membership.id,
              role: membership.role,
            },
          ],
          team: { members: [] },
          canCreateOrganization: true,
        }),
      ),
    resolveOrganizationAccess: async () => access,
    resolveAccount: async () => access,
    resources: vi.fn(),
    rejectCookieMutation: () => undefined,
    close: async () => undefined,
  };
  const headers = { cookie: "session=test" };
  let server: Server | undefined;
  let activeDaemon: TestDaemon | undefined;
  async function stop() {
    try {
      await stopApplication();
    } finally {
      await activeDaemon?.disconnect();
      if (server) {
        server.closeAllConnections();
        await promisify(server.close.bind(server))();
      }
      server = undefined;
      activeDaemon = undefined;
    }
  }
  return {
    headers,
    async accountState(runtime: ApplicationRuntime) {
      const response = await runtime.browserAccount!(
        new Request("http://hub.test/api/auth/paseo/state", { headers }),
      );
      return accountStateSchema.parse(await response.json());
    },
    async start(enabled: boolean, previous?: TestDaemon) {
      const bundle = await embeddedDatabaseRuntime(root);
      await bundle.runtime.migrate();
      const database = createDatabase(bundle.runtime, bundle.locks);
      let runtime: ApplicationRuntime | undefined;
      server = createFetchServer((request) => runtime!.operations.handleDaemonEnrollment(request), {
        handleUpgrade: (request, socket, head) =>
          void runtime!.hub.handleUpgrade!(request, socket, head),
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = "http://127.0.0.1:" + address.port;
      const entitlements = createUnlimitedEntitlementsService();
      runtime = await startApplication(() =>
        createApplicationRuntime({
          database,
          databaseQuery: bundle.runtime,
          auth,
          entitlements,
          billing: null,
          publicBaseUrl: origin,
          interactiveSessions: readInteractiveSessionSettings({
            PASEO_HUB_INTERACTIVE_SESSIONS: String(enabled),
          }),
          close: () => database.close(),
        }),
      );
      const daemon = previous?.replacement(origin) ?? TestDaemon.create(origin);
      activeDaemon = daemon;
      if (previous) {
        await daemon.connectExisting();
      } else {
        const token = randomUUID();
        await bundle.runtime.query("insert into organization (id, name, slug) values ($1,$2,$3)", [
          organization.id,
          organization.name,
          organization.slug,
        ]);
        await bundle.runtime.query('insert into "user" (id, name, email) values ($1,$2,$3)', [
          account.id,
          account.name,
          account.email,
        ]);
        await bundle.runtime.query(
          "insert into member (id, organization_id, user_id, role) values ($1,$2,$3,'owner')",
          [membership.id, organization.id, account.id],
        );
        await database.issueEnrollmentToken({
          id: randomUUID(),
          organizationId: organization.id,
          verifier: createHash("sha256").update(token).digest("base64url"),
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        });
        await daemon.connect(await daemon.enroll(token));
        await vi.waitFor(
          () => expect(runtime?.hub.connectionForDaemon(daemon.daemonId)).toBeDefined(),
          { timeout: 5000 },
        );
      }
      return { runtime, daemon, origin };
    },
    stop,
    async close() {
      try {
        await stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
