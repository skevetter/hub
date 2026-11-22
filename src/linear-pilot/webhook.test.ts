import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createLinearRegistration } from "../providers/linear/index.js";
import {
  createLinearWebhookSource,
  type LinearWebhookSourceOptions,
} from "../triggers/linear/webhook.js";

import { classifyLinearPilotCompanionComment } from "./intake.js";

const now = 1_767_225_600_000;
const secret = "synthetic-pilot-webhook-secret";

function signedRequest(
  fields: Record<string, unknown> = {},
  options: { signDifferentBody?: boolean; eventName?: string } = {},
): Request {
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "pilot-workspace",
    webhookTimestamp: now,
    ...fields,
  });
  const signature = createHmac("sha256", secret)
    .update(options.signDifferentBody ? "different" : body)
    .digest("hex");
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "linear-delivery": randomUUID(),
      "linear-event": options.eventName ?? "AgentSessionEvent",
      "linear-signature": signature,
    },
    body,
  });
}

function source(offer: NonNullable<LinearWebhookSourceOptions["offerVerifiedLinearPilotEvent"]>) {
  const drops: Parameters<LinearWebhookSourceOptions["accept"]>[0][] = [];
  const endpoint = createLinearWebhookSource({
    signingSecret: secret,
    now: () => now,
    offerVerifiedLinearPilotEvent: offer,
    accept: async (input) => {
      drops.push(input);
      return { status: "dropped", receiptId: "pilot-drop", reason: "unsupported_event" };
    },
    findAppUserId: async () => assert.fail("native intake must not fetch app identity"),
    resolveIssue: async () => assert.fail("native intake must not hydrate the issue"),
  });
  return { endpoint, drops };
}

describe("registered Linear pilot handoff", () => {
  it("routes signed events through the registered pilot handler with no legacy or provider work", async () => {
    const database = createMemoryDatabase();
    const offers: unknown[] = [];
    const drops: Parameters<typeof database.acceptLinearEvent>[0][] = [];
    let pilotAccepted = false;
    database.findLinearConnection = async () => assert.fail("looked up a provider token");
    database.findMarkedLinearReceipt = async () => false;
    database.acceptLinearEvent = async (input) => {
      drops.push(input);
      return { status: "dropped", receiptId: "pilot-drop", reason: "unsupported_event" };
    };
    const registration = createLinearRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: { clientId: "test-app", clientSecret: "test-secret", webhookSecret: secret },
      fetch: async () => assert.fail("made a provider call"),
      linearPilot: {
        offer(event, app) {
          assert.equal(app.oauthClientId, "test-app");
          offers.push(event.payload);
          return pilotAccepted;
        },
      },
    });
    const endpoint = registration.requests.find(({ name }) => name === "linear.events");
    assert(endpoint);

    const signed = { webhookTimestamp: Date.now(), promptContext: "synthetic prompt" };
    assert.equal((await endpoint.handle(signedRequest(signed))).status, 200);
    assert.equal(offers.length, 1);
    assert.equal(drops.length, 1);
    assert.deepEqual(drops[0]?.payload, { type: "agent_session", action: "created" });

    pilotAccepted = true;
    assert.equal((await endpoint.handle(signedRequest(signed))).status, 200);
    assert.equal(offers.length, 2);
    assert.equal(drops.length, 1);

    const invalid = signedRequest(signed, { signDifferentBody: true });
    assert.equal((await endpoint.handle(invalid)).status, 401);
    assert.equal(offers.length, 2);
    assert.equal(drops.length, 1);
  });

  it("offers a verified native payload without waiting for provider work", async () => {
    let offered: unknown;
    const { endpoint, drops } = source((input) => {
      offered = input.payload;
      return true;
    });

    assert.equal((await endpoint.handle(signedRequest())).status, 200);
    assert.deepEqual(offered, {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "pilot-workspace",
      webhookTimestamp: now,
    });
    assert.deepEqual(drops, []);
  });

  it("keeps declined native deliveries on the metadata-only receipt path", async () => {
    let offers = 0;
    const { endpoint, drops } = source(() => {
      offers++;
      return false;
    });

    const response = await endpoint.handle(
      signedRequest({ organizationId: "excluded-workspace", promptContext: "synthetic message" }),
    );

    assert.equal(response.status, 200);
    assert.equal(offers, 1);
    assert.equal(drops.length, 1);
    assert.equal(drops[0]?.linearOrganizationId, "excluded-workspace");
    assert.equal(drops[0]?.dropReason, "unsupported_event");
    assert.deepEqual(drops[0]?.payload, { type: "agent_session", action: "created" });
  });

  it("skips an exact signed pilot companion before the legacy trigger path", async () => {
    let suppressed = 0;
    const endpoint = createLinearWebhookSource({
      signingSecret: secret,
      now: () => now,
      suppressVerifiedLinearPilotComment: (event) => {
        assert.equal(event.organizationId, "pilot-workspace");
        assert.equal(event.actor?.id, "pilot-human");
        assert.equal(event.comment.body, "@paseo check this");
        suppressed++;
        return true;
      },
      findAppUserId: async () => assert.fail("pilot companion must not resolve legacy app user"),
      accept: async () => assert.fail("pilot companion must not reach legacy trigger acceptance"),
    });
    const comment = {
      type: "Comment",
      action: "create",
      actor: { id: "pilot-human" },
      data: { id: "companion", issueId: "issue", body: "@paseo check this" },
    };

    assert.equal(
      (await endpoint.handle(signedRequest(comment, { eventName: "Comment" }))).status,
      200,
    );
    assert.equal(suppressed, 1);
    assert.equal(
      (
        await endpoint.handle(
          signedRequest(comment, {
            eventName: "Comment",
            signDifferentBody: true,
          }),
        )
      ).status,
      401,
    );
    assert.equal(suppressed, 1);
  });

  it.each([
    { workspaceId: "pilot-workspace", authorId: "pilot-human", expectedLegacy: 0 },
    { workspaceId: "other-workspace", authorId: "pilot-human", expectedLegacy: 1 },
    { workspaceId: "pilot-workspace", authorId: "other-human", expectedLegacy: 1 },
  ])(
    "limits ambiguous companion suppression to the pilot scope ($workspaceId, $authorId)",
    async ({ workspaceId, authorId, expectedLegacy }) => {
      let legacy = 0;
      let handleLookups = 0;
      const endpoint = createLinearWebhookSource({
        signingSecret: secret,
        now: () => now,
        suppressVerifiedLinearPilotComment: async (event) => {
          const classification = await classifyLinearPilotCompanionComment({
            config: {
              hubOrganizationId: "pilot-hub-org",
              linearOrganizationId: "pilot-workspace",
              allowedHumanId: "pilot-human",
              profileId: "32624952-2c32-4b06-92a4-fc6e6c9f224d",
            },
            workspaceId: event.organizationId,
            authorId: event.actor?.id,
            body: event.comment.body,
            resolveHandle: () => {
              handleLookups++;
              return "paseo";
            },
          });
          return (
            classification.suppress || ("ambiguous" in classification && classification.ambiguous)
          );
        },
        accept: async () => {
          legacy++;
          return { status: "dropped", receiptId: "legacy-drop", reason: "unsupported_event" };
        },
      });
      const response = await endpoint.handle(
        signedRequest(
          {
            type: "Comment",
            action: "create",
            organizationId: workspaceId,
            actor: { id: authorId },
            data: { id: "companion", issueId: "issue", body: "@paseo " + "x".repeat(2_050) },
          },
          { eventName: "Comment" },
        ),
      );

      assert.equal(response.status, 200);
      assert.equal(legacy, expectedLegacy);
      assert.equal(handleLookups, expectedLegacy === 0 ? 1 : 0);
    },
  );

  it("offers no pilot event for bad signatures, stale timestamps or header-only native kinds", async () => {
    const { endpoint, drops } = source(() => assert.fail("unverified native event was offered"));

    assert.equal(
      (await endpoint.handle(signedRequest({}, { signDifferentBody: true }))).status,
      401,
    );
    assert.equal(
      (await endpoint.handle(signedRequest({ webhookTimestamp: now - 60_001 }))).status,
      401,
    );
    assert.equal((await endpoint.handle(signedRequest({ type: "Issue" }))).status, 200);
    assert.equal(drops.length, 1);
  });
});
