import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { readRunProgressSettings } from "../run-progress/settings.js";
import { SessionEventBus } from "./bus.js";
import { InteractiveSessionService } from "./service.js";
import { InteractiveSessionStream } from "./stream.js";

let container: StartedPostgreSqlContainer | undefined;
let root: Awaited<ReturnType<typeof createPostgresTestRuntime>> | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  root = await createPostgresTestRuntime(container.getConnectionUri());
}, 120_000);

afterAll(async () => {
  try {
    await root?.runtime.close();
  } finally {
    await container?.stop();
  }
}, 30_000);

it("relays and reads assistant text without persisting it in session tables or audit events", async () => {
  const { database, runtime } = root!;
  const organizationId = "stream-org";
  const userId = "stream-owner";
  const viewerId = "stream-viewer";
  const principal = { organizationId, userId, role: "owner" as const };
  const daemonId = randomUUID();
  const now = new Date();
  const bus = new SessionEventBus();
  await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    organizationId,
  ]);
  for (const [id, role] of [
    [userId, "owner"],
    [viewerId, "member"],
  ] as const) {
    await runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
      id,
      id + "@example.test",
    ]);
    await runtime.query(
      "insert into member (id, organization_id, user_id, role) values ($1, $2, $1, $3)",
      [id, organizationId, role],
    );
  }
  const token = randomUUID();
  await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier: token,
    organizationId,
    expiresAt: new Date(now.getTime() + 60000),
    consumedAt: null,
  });
  await database.enrollDaemon({
    daemonId,
    tokenVerifier: token,
    idempotencyKey: randomUUID(),
    serverId: randomUUID(),
    daemonPublicKey: "test-public-key",
    credentialVerifier: "test-verifier",
    permissions: ["hub.execute"],
    now,
  });
  await database.setDaemonPresence(daemonId, "connected");

  const auth: AuthServer = {
    handle: vi.fn(),
    resources: vi.fn(),
    resolveOrganizationAccess: vi.fn(),
    close: vi.fn(),
    resolveAccount: async (request) => {
      const id = request.headers.get("cookie")!;
      return {
        account: { id, name: id, email: id + "@example.test" },
        session: { id: id + "-session", activeOrganizationId: null },
        isInstanceOperator: false,
      };
    },
    rejectCookieMutation: () => undefined,
  };
  const transcript = "Assistant fixture: the violet cat sleeps at sunrise.";
  const epoch = "history-epoch";
  const history = {
    timeline: vi.fn(async () => ({
      entries: [
        {
          item: { type: "assistant_message" as const, text: transcript },
          timestamp: now.toISOString(),
          seqStart: 1,
          seqEnd: 2,
        },
      ],
      epoch,
      reset: false,
      staleCursor: false,
      gap: false,
      startCursor: { epoch, seq: 1 },
      endCursor: { epoch, seq: 2 },
      hasOlder: false,
      hasNewer: false,
    })),
  };
  let bodyCutoff: Date | null = null;
  const service = new InteractiveSessionService({
    database,
    pool: runtime,
    auth,
    bus,
    bodyCutoff: () => bodyCutoff,
    coordinator: {
      start: async (actor, input) => {
        const result = await database.startInteractiveSession({
          ...input,
          principal: actor,
          usage: { periodStart: now, limit: 10 },
          maxActivePerDaemon: 4,
          bodyCutoff,
          now,
        });
        if (result.status === "refused") return { outcome: "refused", code: result.code };
        return {
          outcome: "accepted",
          sessionId: result.session.id,
          commandId: result.command.id,
          status: result.command.status,
          replayed: result.status === "replayed",
        };
      },
      send: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
      replaceAgent: vi.fn(),
    },
    connectionForDaemon: () => ({
      history,
      validateAgentConfiguration: async () => ({ valid: true }),
    }),
  });
  const request = new Request("https://hub.test/events?organization=" + organizationId, {
    headers: { cookie: userId },
  });
  const mutation = new Request(request.url, {
    method: "POST",
    headers: { origin: "https://hub.test", cookie: userId },
  });
  const profile = await service.saveProfile(mutation, {
    organizationSlug: organizationId,
    id: null,
    version: null,
    name: "Chat",
    daemonId,
    cwd: "/repo",
    worktree: null,
    provider: "codex",
    model: null,
    mode: null,
    thinkingOptionId: null,
    fullAccessAcknowledged: false,
    status: "active",
  });
  expect(profile.outcome).toBe("saved");
  if (profile.outcome !== "saved") throw new Error(profile.code);
  const accepted = await service.command(mutation, {
    kind: "start",
    organizationSlug: organizationId,
    profileId: profile.profile.id,
    profileVersion: 1,
    idempotencyKey: randomUUID(),
    message: "Persisted human message",
    participants: [{ userId: viewerId, role: "viewer" }],
  });
  expect(accepted.outcome).toBe("accepted");
  if (accepted.outcome !== "accepted") throw new Error(accepted.code);
  const { sessionId } = accepted;
  expect(
    await database.bindInteractiveSessionAgent({
      ...principal,
      sessionId,
      generation: 1,
      agentId: "test-agent",
      workspaceId: "test-workspace",
      now,
    }),
  ).toBe(true);

  const stream = new InteractiveSessionStream({
    service,
    bus,
    settings: readRunProgressSettings({}),
  });
  const response = await stream.handle(request, sessionId);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  try {
    const snapshot = await service.snapshot(request, {
      organizationSlug: organizationId,
      sessionId,
    });
    expect(snapshot.messages[0]?.text).toBe("Persisted human message");
    const page = await service.history(request, {
      organizationSlug: organizationId,
      sessionId,
      before: null,
      limit: 50,
    });
    expect(page).toMatchObject({ entries: [{ text: transcript, seqStart: 1, seqEnd: 2 }] });
    bus.publish(sessionId, {
      kind: "agent",
      epoch,
      item: {
        kind: "assistant",
        seq: 3,
        text: transcript,
        truncated: false,
        at: now.toISOString(),
      },
    });
    let frames = "";
    while (!frames.includes(transcript)) {
      const data = await reader.read();
      if (data.done) throw new Error("stream ended before assistant text");
      frames += new TextDecoder().decode(data.value);
    }
    expect(frames).toContain("event: message");
    expect(frames).toContain("event: agent");

    bodyCutoff = new Date(now.getTime() + 1);
    const expired = await service.snapshot(request, {
      organizationSlug: organizationId,
      sessionId,
    });
    expect(expired.messages[0]).toMatchObject({
      commandId: accepted.commandId,
      text: null,
      expired: true,
    });
    const events = await service.streamEvents(principal, sessionId, 0, 10);
    const message = events.find((event) => event.kind === "message");
    if (message === undefined) throw new Error("Missing recorded message event");
    await expect(service.streamEventData(principal, message)).resolves.toMatchObject({
      commandId: accepted.commandId,
      text: null,
      expired: true,
    });

    const viewerRequest = new Request(request.url + "&after=" + snapshot.hubSeq, {
      headers: { cookie: viewerId },
    });
    const viewerResponse = await stream.handle(viewerRequest, sessionId);
    expect(viewerResponse.status).toBe(200);
    const viewer = viewerResponse.body!.getReader();
    try {
      expect((await viewer.read()).done).toBe(false);
      const started = performance.now();
      expect(
        await service.participants(mutation, {
          organizationSlug: organizationId,
          sessionId,
          userId: viewerId,
          role: null,
        }),
      ).toEqual({ outcome: "accepted", sessionId });
      const terminal = await viewer.read();
      expect(new TextDecoder().decode(terminal.value)).toContain('"code":"reauth"');
      expect(performance.now() - started).toBeLessThan(1000);
      expect((await viewer.read()).done).toBe(true);
      expect((await stream.handle(viewerRequest, sessionId)).status).toBe(404);
    } finally {
      await viewer.cancel();
    }

    const { rows } = await runtime.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = current_schema() and tablename ~ '^interactive_session(s|_)' union all select 'audit_events'",
    );
    expect(rows.map(({ tablename }) => tablename).sort()).toEqual([
      "audit_events",
      "interactive_session_commands",
      "interactive_session_events",
      "interactive_session_participants",
      "interactive_session_profiles",
      "interactive_sessions",
    ]);
    for (const { tablename } of rows) {
      const match = await runtime.query(
        'select 1 from "' +
          tablename.replaceAll('"', '""') +
          '" row where strpos(to_jsonb(row)::text, $1) > 0',
        [transcript],
      );
      expect(match.rowCount, tablename).toBe(0);
    }
  } finally {
    await reader.cancel();
    await stream.beginShutdown();
  }
}, 15_000);
