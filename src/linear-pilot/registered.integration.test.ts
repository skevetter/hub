import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createDatabase } from "../db/pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  readDatabasePoolOptions,
  type DatabaseRuntime,
} from "../db/runtime/index.js";
import { observedRuntime } from "../db/test-utils/run-timeline-postgres.js";
import { SessionEventBus } from "../interactive-sessions/bus.js";
import { InteractiveSessionCoordinator } from "../interactive-sessions/coordinator.js";
import { readInteractiveSessionSettings } from "../interactive-sessions/settings.js";
import { FakeAgents } from "../interactive-sessions/test-utils/fake-agents.js";
import { logger } from "../logger.js";
import { createLinearRegistration } from "../providers/linear/index.js";
import { prepareProfile, surfaceTenant } from "../surfaces/store.contract.js";
import { pilotActivityIds } from "./activities.js";
import { createLinearPilotRuntime } from "./runtime.js";
import type { LinearPilotTerminal } from "./session.js";
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

async function registeredDatabase(backend: "embedded" | "postgres") {
  if (backend === "postgres") {
    const container = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(20_000)
      .start();
    try {
      const bundle = await postgresDatabaseRuntime(
        container.getConnectionUri(),
        readDatabasePoolOptions({
          PASEO_HUB_DATABASE_POOL_MAX: "1",
          PASEO_HUB_DATABASE_ACQUIRE_TIMEOUT_MS: "1000",
        }),
      );
      return {
        ...bundle,
        cleanup: async () => {
          await container.stop({ timeout: 2_000 });
        },
      };
    } catch (error) {
      await container.stop({ timeout: 2_000 });
      throw error;
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "hub-pilot-registered-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    return { ...(await embeddedDatabaseRuntime(dir)), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

type Publication = Array<{ id: string; type: string; body: string; signal?: string }>;
interface Endpoint {
  handle(request: Request): Promise<Response> | Response;
}

async function deliver(endpoint: Endpoint, payload: JsonObject) {
  assert.equal((await endpoint.handle(signedDelivery(payload))).status, 200);
}

function removeSignedComment(payload: JsonObject, session: JsonObject, delegation: boolean) {
  if (!delegation) return;
  session["comment"] = null;
  session["commentId"] = null;
  session["sourceCommentId"] = null;
  payload["promptContext"] = "not first-turn context";
}

const delegationSessionId = "2138c045-6eb6-4cde-a191-84d4bdee87cd";
const reusedSessionId = "2138c045-6eb6-4cde-a191-84d4bdee87ce";
const delegationHistoryId = "2138c045-6eb6-4cde-a191-84d4bdee87cf";
type RefusalScenario = "delegation-refusal" | "delegation-oversized";

function delegationResult(input: {
  request: z.infer<typeof graphQLRequest>;
  nativeSessionId: string;
  issueId: string;
  at: (second: number) => string;
  appUserId: string;
  workspaceId: string;
  humanId: string;
  teamId: JsonObject[string] | undefined;
  scenario: string;
}) {
  const {
    request,
    nativeSessionId,
    issueId,
    at,
    appUserId,
    workspaceId,
    humanId,
    teamId,
    scenario,
  } = input;
  assert.match(request.query, /history\(first: 20, orderBy: createdAt\)/u);
  assert.match(request.query, /nodes\s*\{\s*id createdAt/u);
  const requested = request.variables["sessionId"];
  assert.ok(requested === nativeSessionId || requested === reusedSessionId);
  if (scenario === "delegation-refusal")
    return Response.json({
      errors: [
        {
          message: "Origin read unavailable",
          extensions: { type: "unavailable", code: "unavailable" },
        },
      ],
    });
  const human = { id: humanId };
  const app = { id: appUserId };
  return Response.json({
    data: {
      agentSession: {
        id: requested,
        createdAt: at(0),
        appUser: app,
        creator: human,
        comment: null,
        sourceComment: null,
        issue: {
          id: issueId,
          identifier: "TEST-1",
          title: "Check delegation",
          description:
            scenario === "delegation-oversized" ? "x".repeat(20_000) : "Use this description.",
          team: { id: teamId, organization: { id: workspaceId } },
          delegate: app,
          assignee: null,
          history: {
            nodes: [
              {
                id: delegationHistoryId,
                createdAt: at(-1),
                actor: human,
                botActor: null,
                toDelegate: app,
                toAssignee: null,
                triageResponsibilityAutoAssigned: null,
              },
            ],
          },
        },
      },
    },
  });
}

function activityResult(
  activity: NonNullable<z.infer<typeof graphQLRequest>["variables"]["input"]>,
  appUserId: string,
  publication: Publication,
) {
  const signal = activity.signal === undefined ? {} : { signal: activity.signal };
  publication.push({ id: activity.id, ...activity.content, ...signal });
  return Response.json({
    data: {
      agentActivityCreate: {
        success: true,
        agentActivity: {
          id: activity.id,
          agentSession: { id: activity.agentSessionId },
          user: { id: appUserId },
          ...signal,
        },
      },
    },
  });
}

async function assertDeclinesOutsideScope(input: {
  payload: JsonObject;
  session: JsonObject;
  endpoint: Endpoint;
  runtime: DatabaseRuntime;
  database: ReturnType<typeof createDatabase>;
  provider: ReturnType<typeof vi.fn<typeof fetch>>;
  agents: FakeAgents;
  outside: ReturnType<typeof surfaceTenant>;
  delegation: boolean;
}) {
  const { payload, session, endpoint, runtime, database, provider, agents, outside, delegation } =
    input;
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
  if (delegation) {
    const otherCreator = { ...payload, agentSession: { ...session, creatorId: randomUUID() } };
    assert.equal((await endpoint.handle(signedDelivery(otherCreator))).status, 200);
    expect(credentialLookup).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  }
}

function isRefusalScenario(scenario: string): scenario is RefusalScenario {
  return scenario === "delegation-refusal" || scenario === "delegation-oversized";
}

function refusalDetails(scenario: RefusalScenario) {
  if (scenario === "delegation-oversized") return { reason: "oversized" };
  return {
    reason: "origin_unproven",
    linearErrorText: "Linear GraphQL Origin read unavailable",
    linearErrorType: "unavailable",
    linearErrorKinds: ["UNAVAILABLE"],
  };
}

async function assertDelegationRefusal(input: {
  endpoint: Endpoint;
  payload: JsonObject;
  runtime: DatabaseRuntime;
  organizationId: string;
  nativeSessionId: string;
  publication: Publication;
  agents: FakeAgents;
  legacy: () => Promise<void>;
  originReads: () => number;
  scenario: RefusalScenario;
}) {
  const {
    endpoint,
    payload,
    runtime,
    organizationId,
    nativeSessionId,
    publication,
    agents,
    legacy,
    originReads,
    scenario,
  } = input;
  const info = vi.spyOn(logger, "info");
  try {
    await deliver(endpoint, payload);
    await vi.waitFor(() => expect(publication).toHaveLength(1));
    expect(publication[0]?.id).toBe("b3b15181-944e-4a14-923f-786fb8ec8433");
    expect(publication[0]).toMatchObject({
      type: "error",
      body: "Paseo could not confirm who started this. Mention @paseo in a comment instead.",
    });
    expect(info).toHaveBeenCalledWith(
      {
        ...refusalDetails(scenario),
        action: "created",
        nativeSessionId,
      },
      "Linear pilot refused delivery",
    );
    await deliver(endpoint, payload);
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        { reason: "duplicate", action: "created", nativeSessionId },
        "Linear pilot refused delivery",
      ),
    );
    const { rows } = await runtime.query(
      "select 1 from interactive_sessions where organization_id = $1",
      [organizationId],
    );
    expect(rows).toEqual([]);
    await expectDelegationReceipts(
      runtime,
      organizationId,
      scenario === "delegation-oversized"
        ? [delegationReceipt("oversized", delegationHistoryId)]
        : [delegationReceipt("origin_unproven")],
    );
    expect(publication).toHaveLength(1);
    expect(originReads()).toBe(1);
    expect(agents.creations).toEqual([]);
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    info.mockRestore();
  }
}

function delegationReceipt(reason: string, historyEntryId?: string) {
  return {
    dropped_reason: reason,
    payload: {
      type: "agent_session",
      action: "created",
      ...(historyEntryId && { historyEntryId }),
    },
  };
}

async function expectDelegationReceipts(
  runtime: DatabaseRuntime,
  organizationId: string,
  expected: ReturnType<typeof delegationReceipt>[],
) {
  const { rows } = await runtime.query(
    `select dropped_reason, payload from provider_event_receipts
     where organization_id = $1 and delivery_id like 'linear-pilot:%' order by dropped_reason`,
    [organizationId],
  );
  expect(rows).toEqual(expected);
}

async function assertDelegationReuse(input: {
  endpoint: Endpoint;
  payload: JsonObject;
  session: JsonObject;
  runtime: DatabaseRuntime;
  organizationId: string;
  publication: Publication;
  agents: FakeAgents;
}) {
  const { endpoint, payload, session, runtime, organizationId, publication, agents } = input;
  const replay = { ...payload, agentSession: { ...session, id: reusedSessionId } };
  await deliver(endpoint, replay);
  await vi.waitFor(() =>
    expect(publication.map(({ type }) => type)).toEqual(["thought", "response", "error"]),
  );
  await expectDelegationReceipts(runtime, organizationId, [
    delegationReceipt("linear_pilot_admitted", delegationHistoryId),
    delegationReceipt("origin_reused", delegationHistoryId),
  ]);
  expect(agents.creations).toHaveLength(1);
  expect(agents.sends).toHaveLength(1);
}

function registeredBackend(scenario: string) {
  return scenario === "postgres" ? "postgres" : "embedded";
}

function registeredSessionId(scenario: string) {
  return scenario.startsWith("delegation") ? delegationSessionId : randomUUID();
}

function coordinatorOptions(scenario: string) {
  return scenario === "stop-race" ? { shutdownTimeoutMs: 1_000 } : {};
}

async function exerciseRegisteredPilot(
  scenario: "stop" | "stop-race" | "postgres" | "start-refusal" | "delegation" | RefusalScenario,
  terminalFailure?: "failed" | "canceled" | "unconfirmed",
) {
  const backend = registeredBackend(scenario);
  const { runtime, locks, cleanup } = await registeredDatabase(backend);
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
    let initialOutcome: "failed" | "sent" | undefined;
    const pilotFailure = vi.fn(() => {
      initialOutcome = "failed";
    });
    const transactionFailures: string[] = [];
    let bindingLookups = 0;
    const observed = observedRuntime(runtime, {
      async afterQuery(sql) {
        if (sql.includes("from surface_bindings b") && sql.includes("order by b.generation")) {
          bindingLookups++;
        }
      },
    });
    const pilotRuntime: DatabaseRuntime = {
      ...observed,
      async transaction(operation) {
        try {
          return await observed.transaction(operation);
        } catch (error) {
          transactionFailures.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    };
    const pilot = createLinearPilotRuntime({
      config,
      database,
      runtime: backend === "postgres" ? pilotRuntime : runtime,
      locks,
      reportFailure: pilotFailure,
    });
    const agents = new FakeAgents();
    const reportCoordinatorFailure = vi.fn();
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
      reportFailure: reportCoordinatorFailure,
      ...coordinatorOptions(scenario),
      linearPilot: pilot.sessionHooks,
    });
    pilot.attachCoordinator(coordinator);
    try {
      const nativeSessionId = registeredSessionId(scenario);
      const followUpId = randomUUID();
      const followUpBody = "What did the previous turn find?";
      const timelineStart = Date.now() - 60_000;
      const at = (second: number) => new Date(timelineStart + second * 1_000).toISOString();
      const followUpAt = at(3);
      const freshTurnAt = at(4);
      const historyReads: string[] = [];
      let originReads = 0;
      const publication: Publication = [];
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
      const delegation = scenario.startsWith("delegation");
      removeSignedComment(payload, session, delegation);

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
        if (request.query.includes("PaseoPilotDelegationOrigin")) {
          originReads++;
          return delegationResult({
            request,
            nativeSessionId,
            issueId,
            at,
            appUserId: connection.appUserId,
            workspaceId: config.linearOrganizationId,
            humanId: config.allowedHumanId,
            teamId: objectAt(session, "issue")["teamId"],
            scenario,
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
        assert.ok([nativeSessionId, reusedSessionId].includes(activity.agentSessionId));
        return activityResult(activity, connection.appUserId, publication);
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

      await assertDeclinesOutsideScope({
        payload,
        session,
        endpoint,
        runtime,
        database,
        provider,
        agents,
        outside,
        delegation,
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
        initialOutcome = "sent";
      };
      if (scenario === "start-refusal") {
        vi.spyOn(coordinator, "startLinearPilot").mockResolvedValue({
          outcome: "refused",
          code: "active_limit",
        });
        objectAt(session, "comment")["body"] = "@paseo private-body-canary";
        assert.equal((await endpoint.handle(signedDelivery(payload))).status, 200);
        await vi.waitFor(
          () =>
            expect(pilotFailure).toHaveBeenCalledExactlyOnceWith({
              sessionId: nativeSessionId,
              failureCode: "active_limit",
              operation: "created",
            }),
          { timeout: 2_000 },
        );
        expect(provider).not.toHaveBeenCalled();
        expect(agents.sends).toEqual([]);
        return;
      }
      if (isRefusalScenario(scenario)) {
        await assertDelegationRefusal({
          endpoint,
          payload,
          runtime,
          organizationId,
          nativeSessionId,
          publication,
          agents,
          legacy,
          originReads: () => originReads,
          scenario,
        });
        return;
      }
      const began = performance.now();
      assert.equal((await endpoint.handle(signedDelivery(payload))).status, 200);
      assert(performance.now() - began < 5_000);
      if (backend === "postgres") {
        await vi.waitFor(() => expect(initialOutcome).toBeDefined(), { timeout: 5_000 });
        assert.equal(
          initialOutcome,
          "sent",
          `Signed webhook returned 200, job failures=${pilotFailure.mock.calls.length}, binding lookups=${bindingLookups}, ACKs=${publication.length}, sends=${agents.sends.length}, transaction errors=${transactionFailures.join(", ")}`,
        );
      }
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

      if (backend === "postgres") {
        const { rows: bindings } = await runtime.query(
          "select 1 from surface_bindings where native_session_id = $1 and superseded_at is null",
          [nativeSessionId],
        );
        expect(bindings).toHaveLength(1);
        expect(bindingLookups).toBeGreaterThan(0);
        expect(publication.map(({ type, body }) => ({ type, body }))).toEqual([
          { type: "thought", body: "Paseo Hub received your request." },
        ]);
        expect(agents.creations).toHaveLength(1);
        expect(agents.sends).toHaveLength(1);
        expect(pilotFailure).not.toHaveBeenCalled();
        expect(transactionFailures).toEqual([]);
        expect(legacy).not.toHaveBeenCalled();
        return;
      }
      const send = agents.sends.at(-1);
      assert(send);
      if (scenario === "stop" && terminalFailure) {
        const before = publication.slice();
        const onTerminal = pilot.sessionHooks.onTerminal.bind(pilot.sessionHooks);
        let publicationResult: { terminal: LinearPilotTerminal; done: Promise<void> } | undefined;
        vi.spyOn(pilot.sessionHooks, "onTerminal").mockImplementation((terminal) => {
          const done = Promise.resolve(onTerminal(terminal));
          publicationResult = { terminal, done };
          return done;
        });
        const emit = {
          failed: () =>
            agents.emit(send.agentId, {
              type: "turn_failed",
              provider: "codex",
              turnId: "turn-1",
              error: "private daemon error",
            }),
          canceled: () =>
            agents.emit(send.agentId, {
              type: "turn_canceled",
              provider: "codex",
              turnId: "turn-1",
              reason: "interrupted",
            }),
          unconfirmed: () =>
            agents.emit(
              send.agentId,
              {
                type: "timeline",
                provider: "codex",
                turnId: "turn-1",
                item: {
                  type: "assistant_message",
                  messageId: "gap",
                  text: "private assistant text",
                },
              },
              { epoch: "turn-1", seq: 3 },
            ),
        };
        emit[terminalFailure]();
        const first = await vi.waitFor(
          () => {
            assert.ok(publicationResult);
            return publicationResult;
          },
          { timeout: 5_000 },
        );
        await first.done;
        expect(first.terminal.status).toBe(terminalFailure);
        const expected = [
          ...before,
          {
            id: pilotActivityIds(nativeSessionId, nativeSessionId).response,
            type: "error",
            body: "Paseo Hub could not complete this request.",
          },
        ];
        expect(publication).toEqual(expected);
        await onTerminal(first.terminal);
        expect(publication).toEqual(expected);
        return;
      }
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
      if (scenario === "delegation") {
        expect(send.text).toBe("Work on TEST-1: Check delegation\n\nUse this description.");
        expect(originReads).toBe(1);
        await assertDelegationReuse({
          endpoint,
          payload,
          session,
          runtime,
          organizationId,
          publication,
          agents,
        });
        expect(legacy).not.toHaveBeenCalled();
        return;
      }
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

      if (scenario === "stop-race") {
        const priorActivities = publication.slice();
        const stopFinished = Promise.withResolvers<void>();
        const releasePublication = Promise.withResolvers<void>();
        let publicationTask: Promise<void> | undefined;
        const onTerminal = pilot.sessionHooks.onTerminal.bind(pilot.sessionHooks);
        vi.spyOn(pilot.sessionHooks, "onTerminal").mockImplementation(async (terminal) => {
          const task = Promise.resolve(onTerminal(terminal));
          publicationTask = task;
          // Let the old lane unwind on failure while still joining the real callback.
          await Promise.race([
            task.then(() => releasePublication.promise),
            releasePublication.promise,
          ]);
        });

        const stopCurrent = coordinator.stopLinearPilot.bind(coordinator);
        vi.spyOn(coordinator, "stopLinearPilot").mockImplementation(async (input) => {
          agents.emit(
            fresh.agentId,
            {
              type: "timeline",
              provider: "codex",
              turnId: "turn-2",
              item: {
                type: "assistant_message",
                text: "Exact final answer",
                messageId: "answer-2",
              },
            },
            { epoch: "turn-2", seq: 2 },
          );
          const terminal = { provider: "codex", turnId: "turn-2" } as const;
          agents.emit(
            fresh.agentId,
            terminalFailure
              ? { ...terminal, type: "turn_failed", error: "private daemon error" }
              : { ...terminal, type: "turn_completed" },
          );
          try {
            return await stopCurrent(input);
          } finally {
            stopFinished.resolve();
          }
        });

        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const stop = prompted(randomUUID(), at(6), null);
          assert.equal((await endpoint.handle(signedDelivery(stop))).status, 200);
          const finished = await Promise.race([
            stopFinished.promise.then(() => "Stop settled"),
            new Promise<string>((resolve) => {
              deadline = setTimeout(
                () => resolve("Stop timed out behind terminal publication"),
                5_000,
              );
            }),
          ]);
          expect(finished).toBe("Stop settled");
          expect(agents.interrupts).toEqual([]);
          await vi.waitFor(() => expect(publicationTask).toBeDefined(), { timeout: 5_000 });
          await publicationTask;
          expect(publication).toEqual([
            ...priorActivities,
            {
              id: pilotActivityIds(nativeSessionId, followUpId).stop,
              type: "error",
              body: "Stop requested; I could not confirm it stopped",
            },
          ]);

          let drained = false;
          const shutdown = coordinator.stopAccepting().then(() => {
            drained = true;
            return undefined;
          });
          await setImmediate();
          expect(drained).toBe(false);
          releasePublication.resolve();
          await shutdown;
          expect(reportCoordinatorFailure).not.toHaveBeenCalledWith(
            expect.objectContaining({ message: "Session coordinator shutdown deadline expired" }),
            "interactive_session.shutdown",
            expect.anything(),
          );
        } finally {
          clearTimeout(deadline);
          releasePublication.resolve();
          await pilot.stop();
          await publicationTask;
        }
        return;
      }

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
    try {
      await runtime.close();
    } finally {
      await cleanup();
    }
  }
}

test(
  "the registered Linear pilot publishes the first answer, advances a capacity-one profile and stops only the fresh turn",
  () => exerciseRegisteredPilot("stop"),
  120_000,
);

test(
  "the registered Linear pilot acknowledges and sends one owner start with a one-connection PostgreSQL pool",
  () => exerciseRegisteredPilot("postgres"),
  45_000,
);

test(
  "registered Stop settles when the exact active turn completes just before coordinator enqueue",
  () => exerciseRegisteredPilot("stop-race"),
  120_000,
);

test.each(["failed", "canceled", "unconfirmed"] as const)(
  "publishes one fixed terminal error for %s and ignores a replay",
  (status) => exerciseRegisteredPilot("stop", status),
  120_000,
);

test(
  "registered Stop publishes only its own error when a failure races coordinator enqueue",
  () => exerciseRegisteredPilot("stop-race", "failed"),
  120_000,
);

test(
  "reports only the fixed start refusal code and native session id",
  () => exerciseRegisteredPilot("start-refusal"),
  120_000,
);

test(
  "a proven owner delegation acknowledges, starts a turn and publishes its answer",
  () => exerciseRegisteredPilot("delegation"),
  120_000,
);

test(
  "a failed delegation read posts one fixed error and creates no Hub session",
  () => exerciseRegisteredPilot("delegation-refusal"),
  120_000,
);

test(
  "an oversized delegation records a refusal and posts one fixed error across replays",
  () => exerciseRegisteredPilot("delegation-oversized"),
  120_000,
);
