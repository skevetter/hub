import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createLinearAgentClient } from "../providers/linear/agent.js";
import type { LinearPilotRegistration } from "../providers/linear/index.js";
import { linearAgentFixture } from "../providers/linear/test-utils/agent.js";
import { createNonOwnerOrigin } from "./origin-non-owner.js";
import {
  createdPayload,
  INSTALLATION,
  objectAt,
  PILOT_CONFIG,
  promptedPayload,
  type JsonObject,
} from "./test-utils/intake-fixtures.js";

type Provider = Parameters<LinearPilotRegistration["offer"]>[1];
type AgentFixture = ReturnType<typeof linearAgentFixture>;

function payload(actorId: string, base = createdPayload()) {
  const session = objectAt(base, "agentSession");
  session["id"] = randomUUID();
  session["creatorId"] = actorId;
  objectAt(session, "comment")["userId"] = actorId;
  objectAt(session, "creator")["id"] = actorId;
  return base;
}

function responseData(body: JsonObject, kind: string) {
  const session = objectAt(body, "agentSession");
  const id = session["id"];
  const actor = session["creatorId"];
  const creator = { id: actor, active: true, app: kind === "app", guest: true };
  const comment = { id: session["commentId"], user: { id: actor }, botActor: null };
  if (kind === "missing") return { id, creator: { id: actor }, comment };
  if (kind === "bot") return { id, creator, comment: { ...comment, botActor: { id: "bot" } } };
  if (kind === "mismatch") return { id, creator, comment: { ...comment, user: { id: "other" } } };
  return { id, creator, comment };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "hub-origin-non-owner-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(dir);
  try {
    await runtime.migrate();
    const config = PILOT_CONFIG;
    const id = randomUUID();
    await runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
      config.hubOrganizationId,
    ]);
    await runtime.query(
      `insert into linear_connections
       (id, organization_id, linear_organization_id, provider_application_id, slug,
        linear_organization_name, app_user_id, access_token, scopes)
       values ($1, $2, $3, $4, 'pilot', 'pilot', $5, 'test-token', '[]'::jsonb)`,
      [
        id,
        config.hubOrganizationId,
        config.linearOrganizationId,
        INSTALLATION.oauthClientId,
        INSTALLATION.appUserId,
      ],
    );
    return {
      runtime,
      id,
      restart: () =>
        createNonOwnerOrigin({ database: runtime, locks, config, accepting: () => true }),
      async close() {
        await runtime.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function providerWith(fixture: AgentFixture, connectionId: string): Provider {
  Object.assign(fixture.a, {
    id: connectionId,
    organizationId: PILOT_CONFIG.hubOrganizationId,
    linearOrganizationId: PILOT_CONFIG.linearOrganizationId,
    appUserId: INSTALLATION.appUserId,
    providerApplicationId: INSTALLATION.oauthClientId,
  });
  fixture.connections.set(fixture.a.linearOrganizationId, fixture.a);
  fixture.approved.add(connectionId);
  return {
    oauthClientId: INSTALLATION.oauthClientId,
    activityClient: (authority) =>
      createLinearAgentClient({
        ...fixture.options,
        ...authority,
        pilotOperations: true,
      }),
  };
}

function trace(body: JsonObject, kind: string) {
  return linearAgentFixture((operation, { query, variables }) => {
    if (operation === "PaseoPilotNonOwnerOrigin") {
      assert.match(
        query.replace(/\s+/gu, " "),
        /agentSession\(id: \$sessionId\) \{ id creator \{ id app active guest \} comment \{ id user \{ id \} botActor \{ id \} \} \}/u,
      );
      if (kind === "error") return { data: null, errors: [{ message: "synthetic read error" }] };
      return { data: { agentSession: responseData(body, kind) } };
    }
    assert.equal(operation, "PaseoAgentActivityCreate");
    const input: unknown = variables["input"];
    assert(typeof input === "object" && input !== null && "id" in input);
    return {
      data: {
        agentActivityCreate: {
          success: true,
          agentActivity: {
            id: input.id,
            agentSession: { id: objectAt(body, "agentSession")["id"] },
            user: { id: INSTALLATION.appUserId },
          },
        },
      },
    };
  });
}

async function deliver(
  origin: ReturnType<typeof createNonOwnerOrigin>,
  body: JsonObject,
  options: {
    id: string;
    kind?: string;
  },
) {
  const fixture = trace(body, options.kind ?? "human");
  const attempt = await origin.qualify(
    {
      payload: body,
      deliveryId: randomUUID(),
      eventName: null,
      signatureHash: "verified",
      receivedAt: new Date(),
    },
    providerWith(fixture, options.id),
  );
  if (attempt) await origin.reply(attempt);
  return fixture.calls.filter(({ query }) => !query.includes("PaseoAgentViewer"));
}

it("replies once to a non-owner created mention across replays and restart using a deterministic public body", async () => {
  const test = await setup();
  try {
    const body = payload("non-owner");
    objectAt(body, "agentSession")["id"] = "2138c045-6eb6-4cde-a191-84d4bdee87cd";
    const options = { id: test.id };
    const origin = test.restart();
    const calls = await deliver(origin, body, options);
    expect(calls.map(({ query }) => query.match(/(?:query|mutation) (\w+)/u)?.[1])).toEqual([
      "PaseoPilotNonOwnerOrigin",
      "PaseoAgentActivityCreate",
    ]);
    expect(calls.at(-1)?.variables).toEqual({
      input: {
        id: "40e39121-bc57-4882-b6f6-65bf35c870d6",
        agentSessionId: "2138c045-6eb6-4cde-a191-84d4bdee87cd",
        content: {
          type: "response",
          body: "Paseo only works for the workspace owner in this pilot.",
        },
      },
    });
    expect(await deliver(origin, body, options)).toEqual([]);
    expect(await deliver(test.restart(), body, options)).toEqual([]);
    const receipts = await test.runtime.query<{ payload: unknown }>(
      "select payload from provider_event_receipts where dropped_reason = 'linear_pilot_not_owner_reply'",
    );
    assert.equal(receipts.rows.length, 1);
    const receipt = receipts.rows[0]?.payload;
    assert(typeof receipt === "object" && receipt !== null && "actorHash" in receipt);
    assert(typeof receipt.actorHash === "string");
    assert.match(receipt.actorHash, /^[a-f0-9]{64}$/u);
  } finally {
    await test.close();
  }
});

it("stays silent for the owner, app user, another workspace, a prompted event, and signed comment mismatch", async () => {
  const test = await setup();
  try {
    const mismatched = payload("non-owner");
    objectAt(objectAt(mismatched, "agentSession"), "comment")["userId"] = "other";
    const prompted = payload("non-owner", promptedPayload());
    objectAt(prompted, "agentActivity")["userId"] = "non-owner";
    const bodies = [
      payload(PILOT_CONFIG.allowedHumanId),
      payload(INSTALLATION.appUserId),
      { ...payload("non-owner"), organizationId: "another-workspace" },
      prompted,
      mismatched,
    ];
    for (const body of bodies) expect(await deliver(test.restart(), body, test)).toEqual([]);
  } finally {
    await test.close();
  }
});

it("refuses app creators, bot comments, mismatched users, missing fields and read failure", async () => {
  const test = await setup();
  try {
    for (const kind of ["app", "bot", "mismatch", "missing", "error"])
      expect(
        await deliver(test.restart(), payload(`actor-${kind}`), { id: test.id, kind }),
      ).toHaveLength(1);
  } finally {
    await test.close();
  }
});

it("limits reads to three attempts per actor and twenty per workspace even after restarts", async () => {
  const test = await setup();
  try {
    const origin = test.restart();
    const failed = { id: test.id, kind: "error" };
    for (let index = 0; index < 3; index += 1)
      expect(await deliver(origin, payload("same-actor"), failed)).toHaveLength(1);
    expect(await deliver(origin, payload("same-actor"), failed)).toEqual([]);
    expect(await deliver(test.restart(), payload("same-actor"), failed)).toEqual([]);
    for (let index = 3; index < 20; index += 1)
      expect(await deliver(origin, payload(`actor-${index}`), failed)).toHaveLength(1);
    expect(await deliver(origin, payload("workspace-overflow"), failed)).toEqual([]);
    expect(await deliver(test.restart(), payload("workspace-overflow"), failed)).toEqual([]);
  } finally {
    await test.close();
  }
});
