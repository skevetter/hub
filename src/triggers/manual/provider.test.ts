import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseCompiledHubConfig } from "../../config/compiler.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import {
  createManualRunProvider,
  ManualRunPayloadSchema,
  parseManualInvocation,
  type ManualRunPayload,
} from "./provider.js";

describe("manual invocation provider", () => {
  it("uses the same typed invocation evidence as message providers", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "manual-request",
          on: "manual.run",
          max_runtime: "1h",
          filters: { from_users: ["*"], inputs: { repo: "hub" } },
          inputs: {
            repo: { type: "string", choices: ["paseo", "hub"] },
            agent: { type: "string", default: "codex", choices: ["codex", "opus"] },
          },
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "10m",
              idle_timeout: "1m",
              agent: { provider: "codex" },
              prompt: [{ text: "Request: ${{ paseo.prompt }}" }],
            },
          ],
        },
      ],
    });
    const provider = createManualRunProvider(() => store);
    const match = (
      await provider.match({
        providerEventReceiptId: "11111111-1111-4111-8111-111111111122",
        organizationId: "org-1",
        projectId: project.id,
        configurationRevisionId: revision.id,
        source: "manual.run",
        deliveryId: "manual-1",
        receivedAt: new Date(),
        payload: {
          trigger: "manual-request",
          actor: "operator",
          input: "repo=hub agent=opus investigate",
        },
      })
    )[0];

    assert.ok(match && typeof match !== "string");
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: "repo=hub agent=opus investigate",
      inputs: { repo: "hub", agent: "opus" },
    });
  });

  it("returns a rejected branch before resolving an unusable launch environment", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(database, {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "manual-request",
          on: "manual.run",
          max_runtime: "1h",
          filters: { from_users: ["operator"] },
          inputs: { repo: { type: "string", choices: ["hub"] } },
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "10m",
              idle_timeout: "1m",
              agent: { provider: "codex" },
              prompt: [{ text: "Request: ${{ paseo.prompt }}" }],
            },
          ],
        },
      ],
    });
    const provider = createManualRunProvider(() => store);
    const matches = await provider.match({
      providerEventReceiptId: "11111111-1111-4111-8111-111111111123",
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      source: "manual.run",
      deliveryId: "manual-invalid-environment",
      receivedAt: new Date(),
      payload: {
        trigger: "manual-request",
        actor: "operator",
        input: "repo=unknown investigate",
      },
    });

    if (typeof matches === "string") throw new Error("expected rejected match");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.invocation.status, "rejected");
  });
});

describe("manual structured payloads", () => {
  const definitions = {
    repo: { type: "string" as const, required: true, choices: ["hub", "paseo"] },
    count: { type: "number" as const, default: 0 },
  };

  it("shares legacy object input mapping with prevalidation", () => {
    const payload = ManualRunPayloadSchema.parse({
      trigger: "manual-request",
      actor: "operator",
      input: { message: "repo=paseo investigate", repo: "hub", count: 2, extra: ["kept"] },
    });
    assert.deepEqual(parseManualInvocation(payload, definitions), {
      status: "accepted",
      prompt: "repo=paseo investigate",
      inputs: { repo: "hub", count: 2 },
    });
  });

  it("uses structured data rather than prompt headers for hooks", () => {
    assert.deepEqual(
      parseManualInvocation(
        {
          trigger: "manual-request",
          actor: "operator",
          input: "repo=paseo count=99 investigate",
          data: { repo: "hub" },
          source: "webhook.received",
        },
        definitions,
      ),
      {
        status: "accepted",
        prompt: "repo=paseo count=99 investigate",
        inputs: { repo: "hub", count: 0 },
      },
    );
  });

  it("keeps text header parsing unchanged without structured data", () => {
    const payload = {
      trigger: "manual-request",
      actor: "operator",
      input: "repo=paseo count=2 investigate",
    };
    assert.deepEqual(parseManualInvocation(payload, definitions), {
      status: "accepted",
      prompt: payload.input,
      inputs: { repo: "paseo", count: 2 },
    });
  });

  it("uses an empty prompt for an object without a message", () => {
    assert.deepEqual(
      parseManualInvocation(
        { trigger: "manual-request", actor: "operator", input: { repo: "hub" } },
        definitions,
      ),
      { status: "accepted", prompt: "", inputs: { repo: "hub", count: 0 } },
    );
  });

  it.each([null, 1, false, {}, []])("rejects a non-string legacy message", (message) => {
    const result = parseManualInvocation(
      { trigger: "manual-request", actor: "operator", input: { message, repo: "hub" } },
      definitions,
    );
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.deepEqual(result.rejection, {
        code: "invalid_type",
        inputName: "message",
        expectedType: "string",
      });
    }
  });

  it("exposes internal webhook routing without changing the configured event", async () => {
    const { provider, match } = await matchedPayload({
      trigger: "manual-request",
      actor: "operator",
      input: "request",
      data: { repo: "hub" },
      source: "webhook.received",
    });
    assert.deepEqual(provider.eventNames, ["manual.run", "webhook.received"]);
    assert.equal(parseCompiledHubConfig(match.hubConfig).triggers[0]?.on, "manual.run");
    assert.equal(match.triggerContext.event.manual.source, "webhook.received");
  });

  it("materializes a below-cap legacy event without altering its content", async () => {
    const input = { message: "repo=paseo request", repo: "hub", count: 2, extra: { a: [1, 2] } };
    const { provider, match, database, receiptId } = await matchedPayload({
      trigger: "manual-request",
      actor: "operator",
      input,
      publicDeliveryKey: "public-delivery",
    });
    assert.deepEqual(match.triggerContext.event, {
      manual: {
        actor: "operator",
        input: input.message,
        data: input,
        source: "manual.run",
        trigger: "manual-request",
        delivery_id: "public-delivery",
      },
    });
    if (provider.materializeContext === undefined) throw new Error("manual context unavailable");
    const materialized = await provider.materializeContext({
      executionId: "execution-1",
      organizationId: "org-1",
      projectId: "project-1",
      providerEventReceiptId: receiptId,
      triggerContext: match.triggerContext,
    });
    assert.equal(materialized, match.triggerContext.event);
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: input.message,
      inputs: { repo: "hub", count: 2 },
    });
    assert.deepEqual((await database.findProviderEventReceiptById(receiptId))?.payload, {
      trigger: "manual-request",
      actor: "operator",
      input,
      publicDeliveryKey: "public-delivery",
    });
  });

  it("replaces data first using serialized original bytes and retains full receipt data", async () => {
    const data = { repo: "hub", count: 3, details: "\u{1f30a}".repeat(20_000) };
    const payload = {
      trigger: "manual-request",
      actor: "operator",
      input: "full request",
      data,
      source: "webhook.received" as const,
    };
    const { match, database, receiptId } = await matchedPayload(payload);
    assert.deepEqual(match.triggerContext.event.manual.data, {
      truncated: true,
      bytes: Buffer.byteLength(JSON.stringify(data)),
    });
    assert.equal(match.triggerContext.event.manual.input, payload.input);
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: payload.input,
      inputs: { repo: "hub", count: 3 },
    });
    assert.deepEqual((await database.findProviderEventReceiptById(receiptId))?.payload, payload);
    assert.deepEqual(data.details, "\u{1f30a}".repeat(20_000));
    assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext)) <= 65_536);
    assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext.event, null, 2)) <= 65_536);
  });

  it.each([
    ["multibyte input", "\u{1f30a}".repeat(16_384)],
    ["escaped input", '"'.repeat(33_000)],
  ])(
    "replaces %s only in context while preserving the prompt and receipt",
    async (_name, input) => {
      const payload = {
        trigger: "manual-request",
        actor: "operator",
        input,
        data: { repo: "hub", count: 4 },
        source: "webhook.received" as const,
      };
      const { match, database, receiptId } = await matchedPayload(payload);
      assert.deepEqual(match.triggerContext.event.manual.input, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(input)),
      });
      assert.deepEqual(match.triggerContext.event.manual.data, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(payload.data)),
      });
      assert.deepEqual(match.invocation, {
        status: "accepted",
        prompt: input,
        inputs: { repo: "hub", count: 4 },
      });
      assert.deepEqual((await database.findProviderEventReceiptById(receiptId))?.payload, payload);
      assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext)) <= 65_536);
      assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext.event, null, 2)) <= 65_536);
    },
  );

  it("bounds legacy object context without changing its full prompt or stored payload", async () => {
    const input = { message: '"'.repeat(33_000), repo: "hub", count: 5 };
    const payload = { trigger: "manual-request", actor: "operator", input };
    const { match, database, receiptId } = await matchedPayload(payload);
    assert.deepEqual(match.triggerContext.event.manual.data, {
      truncated: true,
      bytes: Buffer.byteLength(JSON.stringify(input)),
    });
    assert.deepEqual(match.triggerContext.event.manual.input, {
      truncated: true,
      bytes: Buffer.byteLength(JSON.stringify(input.message)),
    });
    assert.deepEqual(match.invocation, {
      status: "accepted",
      prompt: input.message,
      inputs: { repo: "hub", count: 5 },
    });
    assert.deepEqual((await database.findProviderEventReceiptById(receiptId))?.payload, payload);
    assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext)) <= 65_536);
    assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext.event, null, 2)) <= 65_536);
  });

  it("bounds the full stored wrapper even when its rendered event would fit", async () => {
    const payload = {
      trigger: "manual-request",
      actor: "operator",
      input: "repo=hub " + "x".repeat(1_000),
      publicDeliveryKey: "d".repeat(32_600),
    };
    const { match } = await matchedPayload(payload);
    assert.deepEqual(match.triggerContext.event.manual.input, {
      truncated: true,
      bytes: Buffer.byteLength(JSON.stringify(payload.input)),
    });
    assert.equal(match.triggerContext.event.manual.data, undefined);
    assert.equal(match.invocation.prompt, payload.input);
    assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext)) <= 65_536);
    assert.ok(Buffer.byteLength(JSON.stringify(match.triggerContext.event, null, 2)) <= 65_536);
  });
});

async function matchedPayload(payload: ManualRunPayload) {
  const database = createMemoryDatabase();
  const { project, store } = await createActiveProjectConfiguration(database, {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "manual-request",
        on: "manual.run",
        max_runtime: "1h",
        filters: { from_users: ["operator"], inputs: { repo: "hub" } },
        inputs: {
          repo: { type: "string", required: true, choices: ["paseo", "hub"] },
          count: { type: "number", default: 0 },
        },
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "${{ paseo.context }}" }],
          },
        ],
      },
    ],
  });
  const persisted = await database.persistManualEvent({
    organizationId: project.organizationId,
    projectId: project.id,
    source: payload.source ?? "manual.run",
    deliveryId: "manual-delivery",
    receivedAt: new Date(),
    payload,
  });
  if (persisted.status !== "accepted") throw new Error("expected accepted manual event");
  const provider = createManualRunProvider(() => store);
  const matches = await provider.match(persisted.event);
  if (typeof matches === "string") throw new Error(`unexpected drop: ${matches}`);
  const match = matches[0];
  assert.ok(match);
  return {
    provider,
    match,
    database,
    receiptId: persisted.event.providerEventReceiptId,
  };
}
