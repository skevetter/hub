import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime, type QueryHandle } from "../db/runtime/index.js";
import { SessionEventBus } from "../interactive-sessions/bus.js";
import { InteractiveSessionCoordinator } from "../interactive-sessions/coordinator.js";
import { readInteractiveSessionSettings } from "../interactive-sessions/settings.js";
import { FakeAgents } from "../interactive-sessions/test-utils/fake-agents.js";
import { logger } from "../logger.js";
import { createLinearRegistration } from "../providers/linear/index.js";
import { prepareProfile, surfaceTenant } from "../surfaces/store.contract.js";
import type { LinearPilotConfig } from "./config.js";
import { originActivityId } from "./origin-activities.js";
import { DELEGATION_CONFIRM_TTL_MS } from "./origin-confirmation.js";
import { createLinearPilotRuntime } from "./runtime.js";
import { createdPayload, objectAt, type JsonObject } from "./test-utils/intake-fixtures.js";

const secret = "test-origin-signature";
const appId = "test-shared-app";
const startText = "Start with the new test.";
const providerRequest = z.object({
  query: z.string(),
  variables: z.looseObject({
    input: z
      .object({
        id: z.string(),
        agentSessionId: z.string(),
        content: z.object({ type: z.string(), body: z.string() }),
      })
      .optional(),
  }),
});

interface ProviderScope {
  sessionId: string;
  appUserId: string;
  workspaceId: string;
  humanId: string;
  issueId: string;
  teamId: string;
}

type Scenario =
  | "ok"
  | "read failure"
  | "timeout"
  | "creator mismatch"
  | "not delegated"
  | "app only assignee"
  | "source comment present"
  | "root author mismatch"
  | "delegate removed"
  | "delegate changed"
  | "issue read failure"
  | "oversized prompt";

function scopeFrom(config: LinearPilotConfig, appUserId: string): ProviderScope {
  return {
    sessionId: randomUUID(),
    appUserId,
    workspaceId: config.linearOrganizationId,
    humanId: config.allowedHumanId,
    issueId: randomUUID(),
    teamId: randomUUID(),
  };
}

function delegatedPayload(scope: ProviderScope) {
  const payload = createdPayload();
  Object.assign(payload, {
    appUserId: scope.appUserId,
    oauthClientId: appId,
    organizationId: scope.workspaceId,
  });
  const session = objectAt(payload, "agentSession");
  Object.assign(session, {
    id: scope.sessionId,
    organizationId: scope.workspaceId,
    appUserId: scope.appUserId,
    creatorId: scope.humanId,
    issueId: scope.issueId,
    creator: { id: scope.humanId },
    issue: { id: scope.issueId, teamId: scope.teamId },
    sourceCommentId: null,
  });
  const comment = objectAt(session, "comment");
  Object.assign(comment, { issueId: scope.issueId, userId: null });
  return payload;
}

function prompted(
  scope: ProviderScope,
  options: {
    activityId?: string;
    actor?: string | null;
    issueId?: string;
    sessionId?: string;
  } = {},
) {
  const signed = {
    ...scope,
    issueId: options.issueId ?? scope.issueId,
    sessionId: options.sessionId ?? scope.sessionId,
  };
  const actor = options.actor === undefined ? scope.humanId : options.actor;
  return {
    ...delegatedPayload(signed),
    action: "prompted",
    agentActivity: {
      id: options.activityId ?? randomUUID(),
      userId: actor,
      user: actor === null ? null : { id: actor },
      agentSessionId: signed.sessionId,
      content: { type: "prompt", body: startText },
      signal: null,
    },
  };
}

function signedDelivery(payload: JsonObject) {
  const body = JSON.stringify({ ...payload, webhookTimestamp: Date.now() });
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "linear-delivery": randomUUID(),
      "linear-event": "AgentSessionEvent",
      "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
    },
    body,
  });
}

function issueData(scope: ProviderScope) {
  return {
    id: scope.issueId,
    identifier: "TEST-1",
    team: { id: scope.teamId, organization: { id: scope.workspaceId } },
  };
}

function confirmationData(scope: ProviderScope, scenario: Scenario) {
  const delegated = scenario !== "not delegated" && scenario !== "app only assignee";
  return {
    id: scope.sessionId,
    appUser: { id: scope.appUserId },
    creator: { id: scenario === "creator mismatch" ? "unexpected-user" : scope.humanId },
    sourceComment: scenario === "source comment present" ? { id: "unexpected-source" } : null,
    comment: { user: scenario === "root author mismatch" ? { id: "other-user" } : null },
    issue: {
      ...issueData(scope),
      title: "[Title]`!|<> " + "x".repeat(113) + "\u{1F600}",
      delegate: delegated ? { id: scope.appUserId } : null,
      assignee: scenario === "app only assignee" ? { id: scope.appUserId } : { id: scope.humanId },
    },
  };
}

async function confirmationResponse(
  scope: ProviderScope,
  scenario: Scenario,
  signal: AbortSignal | null | undefined,
) {
  if (scenario === "timeout") {
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  if (scenario === "read failure") {
    return Response.json({ errors: [{ message: "synthetic failure" }] });
  }
  return Response.json({ data: { agentSession: confirmationData(scope, scenario) } });
}

function replyIssueResponse(scope: ProviderScope, scenario: Scenario) {
  if (scenario === "issue read failure") {
    return Response.json({ errors: [{ message: "synthetic issue read failure" }] });
  }
  const delegateId = scenario === "delegate changed" ? "other-delegate" : scope.appUserId;
  return Response.json({
    data: {
      issue: {
        ...issueData(scope),
        title: "Fresh title",
        description: scenario === "oversized prompt" ? "x".repeat(20_000) : "Fresh description.",
        delegate: scenario === "delegate removed" ? null : { id: delegateId },
      },
    },
  });
}

function originProvider(scope: ProviderScope, scenario: Scenario) {
  const writes: { id: string; type: string; body: string }[] = [];
  const reads: string[] = [];
  const send: typeof fetch = async (_url, options) => {
    assert(typeof options?.body === "string");
    const { query, variables } = providerRequest.parse(JSON.parse(options.body));
    if (query.includes("PaseoAgentViewer"))
      return Response.json({
        data: {
          viewer: {
            id: scope.appUserId,
            organization: { id: scope.workspaceId },
            active: true,
            app: true,
            name: "Test",
            displayName: "Paseo",
          },
        },
      });
    if (query.includes("PaseoPilotDelegationConfirmation")) {
      reads.push("confirmation");
      expect(query).not.toMatch(/\bhistory\b/u);
      return confirmationResponse(scope, scenario, options.signal);
    }
    if (query.includes("PaseoPilotDelegationIssue")) {
      reads.push("issue");
      expect(variables["issueId"]).toBe(scope.issueId);
      expect(query).toMatch(/\bdelegate\s*\{\s*id\s*\}/u);
      return replyIssueResponse(scope, scenario);
    }
    if (/PaseoPilot(?:DelegationOrigin|History)/u.test(query)) reads.push("history");
    assert.match(query, /PaseoAgentActivityCreate/u);
    const { input } = variables;
    assert(input);
    writes.push({ id: input.id, ...input.content });
    return Response.json({
      data: {
        agentActivityCreate: {
          success: true,
          agentActivity: {
            id: input.id,
            user: { id: scope.appUserId },
            agentSession: { id: input.agentSessionId },
          },
        },
      },
    });
  };
  return { writes, reads, send };
}

async function insertTenant(runtime: QueryHandle, tenant: ReturnType<typeof surfaceTenant>) {
  const { organizationId, userId, connection } = tenant;
  await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    organizationId,
  ]);
  await runtime.query('insert into "user" (id, name, email) values ($1, $1, $2)', [
    userId,
    userId + "@example.test",
  ]);
  await runtime.query(
    "insert into member (id, organization_id, user_id, role) values ($1, $2, $1, 'owner')",
    [userId, organizationId],
  );
  await runtime.query(
    `insert into linear_connections
      (id, organization_id, linear_organization_id, provider_application_id, slug,
        linear_organization_name, app_user_id, access_token, scopes)
      values ($1, $2, $3, $4, 'pilot', 'pilot', $5, 'synthetic-token', $6::jsonb)`,
    [
      connection.id,
      organizationId,
      connection.linearOrganizationId,
      appId,
      connection.appUserId,
      JSON.stringify(["read", "write", "comments:create", "app:assignable", "app:mentionable"]),
    ],
  );
}

function reflectFirstTurn(agents: FakeAgents) {
  agents.afterSend = async () => {
    const send = agents.sends.at(-1);
    assert(send);
    const turnId = "origin-first-turn";
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
}

async function fixture(scenario: Scenario = "ok") {
  const dir = await mkdtemp(join(tmpdir(), "hub-confirmation-test-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(dir);
  const database = createDatabase(runtime, locks);
  const close = async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await runtime.migrate();
    const tenant = surfaceTenant();
    await insertTenant(runtime, tenant);
    const { profile } = await prepareProfile(database, tenant);
    const config = {
      hubOrganizationId: tenant.organizationId,
      linearOrganizationId: tenant.connection.linearOrganizationId,
      profileId: profile.id,
      allowedHumanId: randomUUID(),
    };
    const scope = scopeFrom(config, tenant.connection.appUserId);
    const provider = originProvider(scope, scenario);
    const agents = new FakeAgents();
    reflectFirstTurn(agents);

    function open() {
      const pilot = createLinearPilotRuntime({ config, runtime, locks, database });
      const sessions = new InteractiveSessionCoordinator({
        database,
        entitlements: {
          async meterReservation(_id, meter) {
            return { meter, periodStart: new Date(0), limit: 20 };
          },
        },
        connectionForDaemon: (id) => (id === profile.daemonId ? agents.connection : undefined),
        bus: new SessionEventBus(),
        settings: { ...readInteractiveSessionSettings({}), enabled: true },
        instanceId: randomUUID(),
        linearPilot: pilot.sessionHooks,
        reportFailure: vi.fn(),
      });
      pilot.attachCoordinator(sessions);
      const registration = createLinearRegistration({
        database,
        auth: null,
        applicationBaseUrl: "https://hub.test",
        publicBaseUrl: "https://hub.test",
        configuration: { clientId: appId, clientSecret: "synthetic-secret", webhookSecret: secret },
        fetch: provider.send,
        linearPilot: pilot.registration,
      });
      const endpoint = registration.requests.find(({ name }) => name === "linear.events");
      assert(endpoint);
      return {
        async deliver(payload: JsonObject) {
          expect((await endpoint.handle(signedDelivery(payload))).status).toBe(200);
        },
        async stop() {
          await pilot.stop();
          await sessions.stopAccepting();
        },
      };
    }

    return {
      scope,
      agents,
      ...provider,
      open,
      close,
      async claims(reason: string) {
        return (
          await runtime.query(
            "select 1 from provider_event_receipts where organization_id = $1 and dropped_reason = $2",
            [tenant.organizationId, reason],
          )
        ).rowCount;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Endpoint = ReturnType<Fixture["open"]>;
const waiting = "linear_pilot_awaiting_owner";
const started = "linear_pilot_owner_confirmed";

async function elicit(test: Fixture, endpoint: Endpoint) {
  await endpoint.deliver(delegatedPayload(test.scope));
  await vi.waitFor(() => expect(test.writes).toHaveLength(1));
  expect(test.writes[0]).toEqual({
    id: originActivityId(test.scope.sessionId, "awaiting_owner"),
    type: "elicitation",
    body: "Reply here to start work on TEST-1: Title " + "x".repeat(113) + ".",
  });
  expect(test.agents.creations).toHaveLength(0);
  expect(await test.claims(waiting)).toBe(1);
}

async function runTest(
  scenario: Scenario,
  check: (test: Fixture, endpoint: Endpoint) => Promise<void>,
) {
  const test = await fixture(scenario);
  const endpoint = test.open();
  try {
    await check(test, endpoint);
  } finally {
    await endpoint.stop();
    await test.close();
  }
}

async function expectOneShot(endpoint: Endpoint, scope: ProviderScope, reply: JsonObject) {
  const info = vi.spyOn(logger, "info");
  try {
    await endpoint.deliver(reply);
    await endpoint.deliver(prompted(scope));
    await vi.waitFor(() => {
      const reused = info.mock.calls.filter(
        ([fields]) =>
          typeof fields === "object" &&
          fields !== null &&
          "reason" in fields &&
          fields.reason === "origin_reused",
      );
      expect(reused).toHaveLength(2);
    });
  } finally {
    info.mockRestore();
  }
}

it("owner reply starts exactly once after restart and delegation never calls the history read", async () => {
  await runTest("ok", async (test, first) => {
    await elicit(test, first);
    await first.stop();
    const restarted = test.open();
    try {
      const reply = prompted(test.scope);
      await restarted.deliver(reply);
      await vi.waitFor(() => expect(test.agents.sends).toHaveLength(1));
      expect(test.agents.sends[0]?.text).toBe(
        "Work on TEST-1: Fresh title\n\nFresh description.\n\n" + startText,
      );
      await expectOneShot(restarted, test.scope, reply);
      expect(await test.claims(started)).toBe(1);
      expect(test.agents.sends).toHaveLength(1);
      expect(test.reads).toEqual(["confirmation", "issue"]);
      expect(test.writes.map(({ type }) => type)).toEqual(["elicitation", "thought"]);
    } finally {
      await restarted.stop();
    }
  });
}, 25_000);

it("non-owner, app and null actor replies stay silent, and wrong issue, session or elicitation id do not match", async () => {
  await runTest("ok", async (test, endpoint) => {
    await elicit(test, endpoint);
    const { scope } = test;
    const options = [
      { actor: "other" },
      { actor: scope.appUserId },
      { actor: null },
      { issueId: randomUUID() },
      { sessionId: randomUUID() },
      { activityId: originActivityId(scope.sessionId, "awaiting_owner") },
    ];
    for (const option of options) await endpoint.deliver(prompted(scope, option));
    await endpoint.deliver(prompted(scope));
    await vi.waitFor(() => expect(test.agents.sends).toHaveLength(1));
    expect(test.reads).toEqual(["confirmation", "issue"]);
    expect(test.writes.map(({ type }) => type)).toEqual(["elicitation", "thought"]);
  });
}, 25_000);

it.each([
  ["after 24 hours", DELEGATION_CONFIRM_TTL_MS + 1, false],
  ["exactly at 24 hours", DELEGATION_CONFIRM_TTL_MS, true],
  ["one millisecond before 24 hours", DELEGATION_CONFIRM_TTL_MS - 1, true],
] as const)(
  "handles a reply %s with a fake clock",
  async (_label, elapsed, starts) => {
    await runTest("ok", async (test, endpoint) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        await elicit(test, endpoint);
        clock.mockReturnValue(now + elapsed);
        await endpoint.deliver(prompted(test.scope));
        await endpoint.deliver(prompted(test.scope));
        if (starts) {
          await vi.waitFor(() => expect(test.agents.sends).toHaveLength(1));
          expect(await test.claims(started)).toBe(1);
        } else {
          await vi.waitFor(() => expect(test.writes).toHaveLength(2));
          expect(test.writes[1]).toMatchObject({
            type: "error",
            body: "This start request expired. Mention @paseo in a comment instead.",
          });
          expect(await test.claims(started)).toBe(0);
          expect(test.agents.creations).toHaveLength(0);
        }
      } finally {
        clock.mockRestore();
      }
    });
  },
  25_000,
);

it("drops a reply with negative claim age without writing or starting", async () => {
  await runTest("ok", async (test, endpoint) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await elicit(test, endpoint);
      clock.mockReturnValue(now - 1);
      const early = prompted(test.scope);
      objectAt(objectAt(early, "agentActivity"), "content")["body"] = "Too early to start.";
      await endpoint.deliver(early);
      clock.mockReturnValue(now);
      await endpoint.deliver(prompted(test.scope));
      await vi.waitFor(() => expect(test.agents.sends).toHaveLength(1));
      expect(test.agents.sends[0]?.text).toBe(
        "Work on TEST-1: Fresh title\n\nFresh description.\n\n" + startText,
      );
      expect(test.reads).toEqual(["confirmation", "issue"]);
      expect(test.writes.map(({ type }) => type)).toEqual(["elicitation", "thought"]);
      expect(await test.claims(started)).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
}, 25_000);

it.each([
  "delegate removed",
  "delegate changed",
  "issue read failure",
  "oversized prompt",
] as const)(
  "posts one fixed error and never starts if confirmation fails with %s",
  async (scenario) => {
    await runTest(scenario, async (test, endpoint) => {
      await elicit(test, endpoint);
      const reply = prompted(test.scope);
      await endpoint.deliver(reply);
      await vi.waitFor(() => expect(test.writes).toHaveLength(2));
      await expectOneShot(endpoint, test.scope, reply);
      expect(test.writes.map(({ type }) => type)).toEqual(["elicitation", "error"]);
      expect(test.writes[1]?.body).toBe(
        "Paseo could not confirm who started this. Mention @paseo in a comment instead.",
      );
      expect(test.reads).toEqual(["confirmation", "issue"]);
      expect(await test.claims(started)).toBe(1);
      expect(test.agents.creations).toHaveLength(0);
    });
  },
  25_000,
);

it.each([
  "read failure",
  "timeout",
  "creator mismatch",
  "not delegated",
  "app only assignee",
  "source comment present",
  "root author mismatch",
] as const)(
  "refuses delegation with %s, posts a fixed error and stores no waiting claim",
  async (scenario) => {
    await runTest(scenario, async (test, endpoint) => {
      await endpoint.deliver(delegatedPayload(test.scope));
      await vi.waitFor(() => expect(test.writes).toHaveLength(1), { timeout: 6_000 });
      expect(test.writes[0]).toMatchObject({
        type: "error",
        body: "Paseo could not confirm who started this. Mention @paseo in a comment instead.",
      });
      expect(test.reads).toEqual(["confirmation"]);
      expect(await test.claims(waiting)).toBe(0);
      expect(test.agents.creations).toHaveLength(0);
    });
  },
  25_000,
);

it("refuses a missing signed creator without readback or waiting claim", async () => {
  await runTest("ok", async (test, endpoint) => {
    const created = delegatedPayload(test.scope);
    objectAt(created, "agentSession")["creatorId"] = null;
    await endpoint.deliver(created);
    expect(test.reads).toEqual([]);
    expect(test.writes).toEqual([]);
    expect(await test.claims(waiting)).toBe(0);
  });
}, 25_000);
