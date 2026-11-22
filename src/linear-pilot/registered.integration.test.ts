import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { SessionEventBus } from "../interactive-sessions/bus.js";
import { InteractiveSessionCoordinator } from "../interactive-sessions/coordinator.js";
import { readInteractiveSessionSettings } from "../interactive-sessions/settings.js";
import { FakeAgents } from "../interactive-sessions/test-utils/fake-agents.js";
import { createLinearRegistration } from "../providers/linear/index.js";
import { prepareProfile, surfaceTenant } from "../surfaces/store.contract.js";
import { pilotActivityIds } from "./activities.js";
import { createLinearPilotRuntime } from "./runtime.js";
import { createdPayload, objectAt, type JsonObject } from "./test-utils/intake-fixtures.js";

const secret = "synthetic-linear-signature";
const graphQLRequest = z.object({
  query: z.string(),
  variables: z.looseObject({
    input: z
      .object({
        id: z.string(),
        agentSessionId: z.string(),
        content: z.object({ type: z.string(), body: z.string() }),
        signal: z.string().optional(),
      })
      .optional(),
  }),
});

function signedDelivery(payload: ReturnType<typeof createdPayload>): Request {
  const type = payload["type"];
  assert(typeof type === "string");
  const body = JSON.stringify({ ...payload, webhookTimestamp: Date.now() });
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "linear-delivery": randomUUID(),
      "linear-event": type,
      "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
}

test("the registered Linear pilot publishes the first answer, advances a capacity-one profile and stops only the fresh turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hub-pilot-registered-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(dir);
  try {
    await runtime.migrate();
    const tenant = surfaceTenant();
    const outside = surfaceTenant();
    const { organizationId, userId, connection } = tenant;
    const database = createDatabase(runtime, locks);
    for (const { organizationId: tenantId, connection: installed } of [tenant, outside]) {
      await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
        tenantId,
      ]);
      await runtime.query(
        `insert into linear_connections
          (id, organization_id, linear_organization_id, provider_application_id, slug,
           linear_organization_name, app_user_id, access_token, scopes)
         values ($1, $2, $3, $4, $5, $5, $6, $7, $8::jsonb)`,
        [
          installed.id,
          tenantId,
          installed.linearOrganizationId,
          installed.providerApplicationId,
          installed.slug,
          installed.appUserId,
          "synthetic-access-token",
          JSON.stringify(["read", "write", "comments:create", "app:assignable", "app:mentionable"]),
        ],
      );
    }
    await runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
      userId,
      userId + "@example.test",
    ]);
    await runtime.query(
      "insert into member (id, organization_id, user_id, role) values ($1, $2, $1, 'owner')",
      [userId, organizationId],
    );
    const { profile: original, settings } = await prepareProfile(database, tenant);
    const profile = await database.saveSessionProfile({
      ...settings,
      id: original.id,
      version: original.version,
      maxActive: 1,
    });
    assert(typeof profile !== "string");
    assert.equal(profile.maxActive, 1);
    const config = {
      hubOrganizationId: organizationId,
      linearOrganizationId: connection.linearOrganizationId,
      allowedHumanId: randomUUID(),
      profileId: profile.id,
    };
    const pilot = createLinearPilotRuntime({ config, database, runtime, locks });
    const agents = new FakeAgents();
    const coordinator = new InteractiveSessionCoordinator({
      database,
      entitlements: {
        async meterReservation(_organizationId, meter) {
          return { meter, periodStart: new Date(0), limit: 20 };
        },
      },
      connectionForDaemon: (id) => (id === profile.daemonId ? agents.connection : undefined),
      bus: new SessionEventBus(),
      settings: { ...readInteractiveSessionSettings({}), enabled: true },
      instanceId: randomUUID(),
      reportFailure: vi.fn(),
      linearPilot: pilot.sessionHooks,
    });
    pilot.attachCoordinator(coordinator);
    try {
      const nativeSessionId = randomUUID();
      const followUpId = randomUUID();
      const followUpBody = "What did the previous turn find?";
      const timelineStart = Date.now() - 60_000;
      const at = (second: number) => new Date(timelineStart + second * 1_000).toISOString();
      const followUpAt = at(3);
      const freshTurnAt = at(4);
      const historyReads: string[] = [];
      const publication: Array<{ id: string; type: string; body: string; signal?: string }> = [];
      const appId = connection.providerApplicationId;
      assert(appId);
      const payload = createdPayload();
      payload["organizationId"] = config.linearOrganizationId;
      payload["oauthClientId"] = appId;
      payload["appUserId"] = connection.appUserId;
      const session = objectAt(payload, "agentSession");
      session["id"] = nativeSessionId;
      session["organizationId"] = config.linearOrganizationId;
      session["appUserId"] = connection.appUserId;
      session["creatorId"] = config.allowedHumanId;
      objectAt(session, "creator")["id"] = config.allowedHumanId;
      objectAt(session, "comment")["userId"] = config.allowedHumanId;
      const issueId = session["issueId"];
      assert(typeof issueId === "string");

      function prompted(id: string, createdAt: string, body: string | null): JsonObject {
        return {
          ...payload,
          action: "prompted",
          createdAt,
          agentSession: { ...session, status: "active" },
          agentActivity: {
            id,
            agentSessionId: nativeSessionId,
            userId: config.allowedHumanId,
            user: { id: config.allowedHumanId, name: "Synthetic Owner" },
            content: body === null ? { type: "prompt" } : { type: "prompt", body },
            signal: body === null ? "stop" : null,
            createdAt,
            updatedAt: createdAt,
          },
        };
      }

      function historyRow(
        id: string,
        createdAt: string,
        type: "prompt" | "response",
        body: string,
      ) {
        const human = { id: config.allowedHumanId };
        const app = { id: connection.appUserId };
        return {
          id,
          createdAt,
          agentSession: { id: nativeSessionId },
          user: type === "prompt" ? human : app,
          promptAuthor: type === "prompt" ? human : null,
          signal: null,
          content: {
            __typename:
              type === "prompt" ? "AgentActivityPromptContent" : "AgentActivityResponseContent",
            type,
            body,
          },
        };
      }

      function page(nodes: ReturnType<typeof historyRow>[], hasNextPage = false) {
        return Response.json({
          data: {
            agentSession: {
              id: nativeSessionId,
              issue: { id: issueId },
              appUser: { id: connection.appUserId },
              activities: { nodes, pageInfo: { hasNextPage, hasPreviousPage: false } },
            },
          },
        });
      }
      const earlierPromptId = randomUUID();
      const earlierPrompt = "Synthetic previous question";
      const provider = vi.fn<typeof fetch>(async (_input, init) => {
        const body = init?.body;
        assert(typeof body === "string");
        const request = graphQLRequest.parse(JSON.parse(body));
        if (request.query.includes("PaseoAgentViewer")) {
          return Response.json({
            data: {
              viewer: {
                id: connection.appUserId,
                organization: { id: connection.linearOrganizationId },
                active: true,
                app: true,
                displayName: "paseo",
                name: "paseo",
              },
            },
          });
        }
        if (request.query.includes("PaseoPilotPrompt")) {
          assert.match(request.query, /first: 1,/u);
          assert.match(request.query, /agentSessionId: \{ eq: \$sessionId \}/u);
          assert.match(request.query, /id: \{ eq: \$activityId \}/u);
          assert.deepEqual(request.variables, {
            sessionId: nativeSessionId,
            activityId: followUpId,
          });
          historyReads.push("anchor");
          return page([historyRow(followUpId, followUpAt, "prompt", followUpBody)]);
        }
        if (request.query.includes("PaseoPilotHistory")) {
          assert.match(request.query, /first: 24, orderBy: createdAt/u);
          assert.match(request.query, /agentSessionId: \{ eq: \$sessionId \}/u);
          assert.match(request.query, /createdAt: \{ lt: \$before \}/u);
          assert.deepEqual(request.variables, { sessionId: nativeSessionId, before: followUpAt });
          historyReads.push("older");
          const previousAnswer = publication[1];
          assert(previousAnswer?.type === "response");
          assert.equal(
            previousAnswer.id,
            pilotActivityIds(nativeSessionId, nativeSessionId).response,
          );
          return page(
            [
              historyRow(previousAnswer.id, at(2), "response", previousAnswer.body),
              historyRow(earlierPromptId, at(1), "prompt", earlierPrompt),
            ],
            true,
          );
        }
        assert.match(request.query, /PaseoAgentActivityCreate/u);
        const activity = request.variables.input;
        assert(activity);
        assert.equal(activity.agentSessionId, nativeSessionId);
        const signal = activity.signal === undefined ? {} : { signal: activity.signal };
        publication.push({ id: activity.id, ...activity.content, ...signal });
        return Response.json({
          data: {
            agentActivityCreate: {
              success: true,
              agentActivity: {
                id: activity.id,
                agentSession: { id: nativeSessionId },
                user: { id: connection.appUserId },
                ...signal,
              },
            },
          },
        });
      });
      const registration = createLinearRegistration({
        database,
        auth: null,
        applicationBaseUrl: "https://hub.test",
        publicBaseUrl: "https://hub.test",
        configuration: { clientId: appId, clientSecret: "synthetic-secret", webhookSecret: secret },
        fetch: provider,
        linearPilot: pilot.registration,
      });
      const legacy = vi.fn(async () => undefined);
      await registration.sources[0]!.start(legacy);
      const endpoint = registration.requests.find(({ name }) => name === "linear.events");
      assert(endpoint);

      const wrongWorkspace = {
        ...payload,
        organizationId: outside.connection.linearOrganizationId,
      };
      const credentialLookup = vi.spyOn(database, "findLinearConnection");
      assert.equal((await endpoint.handle(signedDelivery(wrongWorkspace))).status, 200);
      expect(credentialLookup).not.toHaveBeenCalled();
      assert.equal(provider.mock.calls.length, 0);
      assert.equal(agents.creations.length, 0);
      const {
        rows: [declined],
      } = await runtime.query(
        "select payload, dropped_reason from provider_event_receipts where organization_id = $1",
        [outside.organizationId],
      );
      expect(declined).toMatchObject({
        payload: { type: "agent_session", action: "created" },
        dropped_reason: "unsupported_event",
      });

      const watch = agents.watch.bind(agents);
      agents.connection.agents.watch = (agentId, listener) =>
        watch(agentId, (event) => {
          if (event.type === "agent_stream" && event.event.type === "turn_started") {
            const wireTimestamp = event.event["turnId"] === "turn-2" ? freshTurnAt : at(0);
            const frame = { ...event, wireTimestamp };
            listener(frame);
          } else {
            listener(event);
          }
        });
      agents.afterSend = async () => {
        assert.equal(publication[0]?.type, "thought");
        const send = agents.sends.at(-1);
        assert(send);
        const turnId = `turn-${agents.sends.length}`;
        agents.emit(send.agentId, { type: "turn_started", provider: "codex", turnId });
        agents.emit(
          send.agentId,
          {
            type: "timeline",
            provider: "codex",
            turnId,
            item: { type: "user_message", clientMessageId: send.messageId },
          },
          { epoch: turnId, seq: 1 },
        );
      };
      const began = performance.now();
      assert.equal((await endpoint.handle(signedDelivery(payload))).status, 200);
      assert(performance.now() - began < 5_000);
      await vi.waitFor(
        async () => {
          const {
            rows: [command],
          } = await runtime.query<{ status: string }>(
            "select status from interactive_session_commands where organization_id = $1 and ordinal = 1",
            [organizationId],
          );
          expect(command?.status).toBe("delivered");
        },
        { timeout: 10_000 },
      );

      const send = agents.sends.at(-1);
      assert(send);
      agents.emit(
        send.agentId,
        {
          type: "timeline",
          provider: "codex",
          turnId: "turn-1",
          item: { type: "assistant_message", text: "Synthetic final answer", messageId: "answer" },
        },
        { epoch: "turn-1", seq: 2 },
      );
      agents.emit(send.agentId, { type: "turn_completed", provider: "codex", turnId: "turn-1" });
      await vi.waitFor(() =>
        expect(publication.map(({ type }) => type)).toEqual(["thought", "response"]),
      );
      assert.match(publication[1]?.body ?? "", /Synthetic final answer/u);
      assert.equal((await endpoint.handle(signedDelivery(payload))).status, 200);

      const legacyAdmission = vi.spyOn(database, "acceptLinearEvent");
      const companion = signedDelivery({
        type: "Comment",
        action: "create",
        organizationId: config.linearOrganizationId,
        actor: { id: config.allowedHumanId },
        data: {
          id: randomUUID(),
          issueId,
          body: "@paseo check this",
        },
      });
      assert.equal((await endpoint.handle(companion)).status, 200);
      expect(legacyAdmission).not.toHaveBeenCalled();

      assert.equal(agents.creations.length, 1);
      assert.equal(agents.sends.length, 1);
      assert.equal(publication.length, 2);

      async function startRow(key: string) {
        const {
          rows: [row],
        } = await runtime.query<{
          id: string;
          state: string;
          generation: number;
          turn: number;
          daemon_agent_id: string;
          closed_at: Date | null;
          state_reason: string | null;
          closed_by_user_id: string | null;
        }>(
          `select id, state, generation, turn, daemon_agent_id, closed_at, state_reason, closed_by_user_id
            from interactive_sessions where organization_id = $1 and start_idempotency_key = $2`,
          [organizationId, key],
        );
        return row;
      }
      const prior = await startRow(nativeSessionId);
      assert(prior);
      assert.notEqual(prior.state, "closed");
      assert.equal(prior.daemon_agent_id, send.agentId);
      const reserve = database.startInteractiveSession.bind(database);
      const reservation = vi
        .spyOn(database, "startInteractiveSession")
        .mockImplementation(async (input) => {
          if (input.idempotencyKey === followUpId) {
            expect(historyReads).toEqual(["anchor", "older"]);
            const retired = await startRow(nativeSessionId);
            expect(retired?.closed_at).toBeInstanceOf(Date);
            expect(retired).toMatchObject({
              id: prior.id,
              state: "closed",
              generation: prior.generation,
              turn: prior.turn,
              daemon_agent_id: send.agentId,
              state_reason: null,
              closed_by_user_id: null,
            });
          }
          return reserve(input);
        });
      const followUp = prompted(followUpId, followUpAt, followUpBody);
      assert.equal((await endpoint.handle(signedDelivery(followUp))).status, 200);
      await vi.waitFor(() => expect(agents.sends).toHaveLength(2), { timeout: 5_000 });
      const fresh = agents.sends[1];
      assert(fresh);
      assert.notEqual(fresh.agentId, send.agentId);
      assert.match(fresh.text, /Synthetic previous question/u);
      assert.match(fresh.text, /Synthetic final answer/u);
      assert.match(fresh.text, /What did the previous turn find\?/u);
      await vi.waitFor(
        async () => {
          const {
            rows: [current],
          } = await runtime.query(
            `select b.generation, s.start_idempotency_key, s.daemon_agent_id, c.status
           from surface_bindings b join interactive_sessions s on s.id = b.session_id
           join interactive_session_commands c on c.session_id = s.id and c.ordinal = 1
           where b.organization_id = $1 and b.native_session_id = $2 and b.superseded_at is null`,
            [organizationId, nativeSessionId],
          );
          expect(current).toMatchObject({
            generation: 2,
            start_idempotency_key: followUpId,
            daemon_agent_id: fresh.agentId,
            status: "delivered",
          });
        },
        { timeout: 5_000 },
      );
      assert.equal((await endpoint.handle(signedDelivery(followUp))).status, 200);
      assert.equal(
        (await endpoint.handle(signedDelivery(prompted(randomUUID(), freshTurnAt, null)))).status,
        200,
      );
      const busyId = randomUUID();
      assert.equal(
        (await endpoint.handle(signedDelivery(prompted(busyId, at(5), "Another question")))).status,
        200,
      );
      await vi.waitFor(
        () =>
          expect(publication[2]).toEqual({
            id: pilotActivityIds(nativeSessionId, busyId).busy,
            type: "response",
            body: "Still working on the previous message; reply when I have answered.",
            signal: "continue",
          }),
        { timeout: 5_000 },
      );
      expect(historyReads).toEqual(["anchor", "older"]);
      expect(agents.interrupts).toEqual([]);
      expect(agents.sends).toHaveLength(2);
      expect(reservation).toHaveBeenCalledTimes(1);

      const interrupt = agents.control.bind(agents);
      agents.connection.agents.control = async (id, workspace, action, onWritten) => {
        onWritten?.();
        await interrupt(id, workspace, action);
      };
      agents.afterInterrupt = async () => {
        agents.emit(fresh.agentId, {
          type: "turn_canceled",
          provider: "codex",
          turnId: "turn-2",
          reason: "interrupted",
        });
        agents.emit(
          fresh.agentId,
          {
            type: "timeline",
            provider: "codex",
            turnId: "turn-2",
            item: { type: "assistant_message", text: "Late success", messageId: "late-answer" },
          },
          { epoch: "turn-2", seq: 2 },
        );
        agents.emit(fresh.agentId, { type: "turn_completed", provider: "codex", turnId: "turn-2" });
      };
      const stop = prompted(randomUUID(), at(6), null);
      assert.equal((await endpoint.handle(signedDelivery(stop))).status, 200);
      await vi.waitFor(
        () =>
          expect(publication[3]).toEqual({
            id: pilotActivityIds(nativeSessionId, followUpId).stop,
            type: "response",
            body: "Stopped.",
          }),
        { timeout: 5_000 },
      );
      await pilot.stop();
      expect(agents.interrupts).toEqual([fresh.agentId]);
      expect(agents.archives).toEqual([]);
      expect(agents.creations).toHaveLength(2);
      expect(agents.sends).toHaveLength(2);
      expect(historyReads).toEqual(["anchor", "older"]);
      expect(publication).toHaveLength(4);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      await pilot.stop();
      await coordinator.stopAccepting();
    }
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
