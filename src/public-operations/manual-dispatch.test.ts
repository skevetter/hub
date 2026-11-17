import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import { ProblemSchema } from "../public-api/contracts.js";
import { createHubApplication } from "../app.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { createActiveProjectConfiguration } from "../test-utils/project-configuration.js";
import type { PublicAuthorization } from "./types.js";

const authorization: PublicAuthorization = {
  kind: "apiKey",
  credentialId: "manual-key",
  organizationId: "org_1",
  scopes: ["runs:dispatch"],
};

const contextSchema = z
  .object({
    event: z
      .object({
        manual: z
          .object({ input: z.unknown(), data: z.unknown(), source: z.string() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

async function harness(access = authorization) {
  const database = createMemoryDatabase();
  const fixture = await createActiveProjectConfiguration(
    database,
    {
      environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "deploy",
          on: "manual.run",
          max_runtime: "1h",
          filters: { from_users: ["sender"], inputs: { status: "failed" } },
          inputs: {
            status: { type: "string", required: true, choices: ["passed", "failed"] },
            count: { type: "number" },
          },
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "10m",
              idle_timeout: "1m",
              agent: { provider: "codex" },
              prompt: [{ text: "${{ paseo.prompt }} ${{ paseo.context }}" }],
            },
          ],
        },
      ],
    },
    { projectSlug: "manual-project" },
  );
  const application = createHubApplication({
    database,
    entitlements: createUnlimitedEntitlementsService(),
    publicApi: {
      status: "enabled",
      authenticator: {
        reauthorize: async () => false,
        async authorize() {
          return { status: "authorized", access };
        },
      },
    },
  });
  await application.hub.start();
  return {
    ...fixture,
    database,
    stop: () => application.hub.stop(),
    async send(overrides: Record<string, unknown> = {}, rawBody?: string) {
      return application.publicApi.handle(
        new Request("http://hub.test/api/v1/manual-runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body:
            rawBody ??
            JSON.stringify({
              projectSlug: fixture.project.slug,
              trigger: "deploy",
              actor: "sender",
              deliveryKey: "delivery",
              input: { message: "Investigate", status: "failed", count: 2 },
              ...overrides,
            }),
        }),
      );
    },
    receipt(deliveryKey = "delivery") {
      const deliveryId = `public-manual-${createHash("sha256")
        .update(
          [access.organizationId, fixture.project.id, deliveryKey]
            .map((part) => JSON.stringify(part))
            .join(":"),
        )
        .digest("base64url")}`;
      return database.findProviderEventReceiptByDeliveryId(deliveryId, access.organizationId);
    },
  };
}

describe("manual dispatch validation", () => {
  it("maps JSON inputs and preserves the complete prompt and body while bounding stored context", async () => {
    const hub = await harness();
    try {
      const message = "\u00e9".repeat(32_768);
      const data = { message, status: "failed", count: 2, metadata: "x".repeat(100_000) };
      const response = await hub.send({ input: data });
      assert.equal(response.status, 200);
      const receipt = await hub.receipt();
      assert.ok(receipt);
      const runs = await hub.database.findTriggerRunsByProviderEventReceiptId(receipt.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.prompt, message);
      assert.deepEqual(runs[0]?.inputs, { status: "failed", count: 2 });
      const payload = z.object({ input: z.unknown() }).parse(receipt.payload);
      assert.deepEqual(payload.input, data);
      const context = contextSchema.parse(runs[0]?.triggerContext);
      assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 65_536);
      assert.deepEqual(context.event.manual.input, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(message)),
      });
      assert.deepEqual(context.event.manual.data, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(data)),
      });
    } finally {
      await hub.stop();
    }
  });

  it("leaves a below-cap context unchanged", async () => {
    const hub = await harness();
    try {
      assert.equal((await hub.send()).status, 200);
      const receipt = await hub.receipt();
      assert.ok(receipt);
      const [run] = await hub.database.findTriggerRunsByProviderEventReceiptId(receipt.id);
      const context = contextSchema.parse(run?.triggerContext);
      assert.equal(context.event.manual.input, "Investigate");
      assert.deepEqual(context.event.manual.data, {
        message: "Investigate",
        status: "failed",
        count: 2,
      });
      assert.equal(context.event.manual.source, "manual.run");
    } finally {
      await hub.stop();
    }
  });

  it("validates before persisting and leaves the delivery key free for a corrected request", async () => {
    const hub = await harness();
    try {
      const bad = await hub.send({ input: { status: "failed", count: "2" } });
      assert.equal(bad.status, 400);
      const problem = ProblemSchema.parse(await bad.json());
      assert.equal(problem.code, "invalid_input");
      assert.deepEqual(problem.issues?.[0]?.path, ["input", "count"]);
      assert.equal(await hub.receipt(), undefined);
      assert.equal((await hub.send()).status, 200);
    } finally {
      await hub.stop();
    }
  });

  it("returns 404 for an unknown trigger and for a project without active configuration", async () => {
    const hub = await harness();
    try {
      const unknown = await hub.send({ trigger: "missing" });
      assert.equal(unknown.status, 404);
      assert.equal(ProblemSchema.parse(await unknown.json()).code, "trigger_not_found");
      const empty = await hub.database.createProject({
        organizationId: "org_1",
        name: "Empty",
        slug: "empty",
        createdByUserId: null,
      });
      const missing = await hub.send({ projectSlug: empty.slug });
      assert.equal(missing.status, 404);
      assert.equal(ProblemSchema.parse(await missing.json()).code, "configuration_not_found");
    } finally {
      await hub.stop();
    }
  });

  it("preserves legacy text headers, required delivery keys, and filtered conflicts", async () => {
    const hub = await harness();
    try {
      assert.equal((await hub.send({ input: "status=failed count=2 Investigate" })).status, 200);
      const missing = await hub.send({ deliveryKey: undefined });
      assert.equal(missing.status, 400);
      const filtered = await hub.send({ deliveryKey: randomUUID(), input: { status: "passed" } });
      assert.equal(filtered.status, 409);
      assert.equal(ProblemSchema.parse(await filtered.json()).code, "dispatch_conflict");
    } finally {
      await hub.stop();
    }
  });

  it("binds the manual actor and rejects an attempted identity override", async () => {
    const hub = await harness({ ...authorization, actor: "sender" });
    try {
      assert.equal((await hub.send({ actor: "other" })).status, 403);
      assert.equal(await hub.receipt(), undefined);
      assert.equal((await hub.send({ actor: undefined })).status, 200);
    } finally {
      await hub.stop();
    }
  });

  it("rejects a legacy credential without its actor and enforces the raw body cap", async () => {
    const hub = await harness();
    try {
      const noActor = await hub.send({ actor: undefined });
      assert.equal(noActor.status, 400);
      const large = await hub.send({}, JSON.stringify({ input: "x".repeat(262_145) }));
      assert.equal(large.status, 413);
      assert.equal(ProblemSchema.parse(await large.json()).code, "payload_too_large");
      assert.equal(await hub.receipt(), undefined);
    } finally {
      await hub.stop();
    }
  });

  it("rejects unsupported text and JSON strings before reserving a manual delivery key", async () => {
    const hub = await harness();
    try {
      const inputs = [
        "status=failed hello\u0000",
        { status: "failed", message: "hello", extra: "\u0000" },
        { status: "failed", message: "hello", ["bad\u0000key"]: "value" },
        { status: "failed", message: "\ud800" },
        { status: "failed", message: "hello", nested: ["\udc00"] },
      ];
      for (const input of inputs) {
        const response = await hub.send({ input });
        assert.equal(response.status, 400);
        assert.equal(ProblemSchema.parse(await response.json()).code, "invalid_input");
        assert.equal(await hub.receipt(), undefined);
      }
      assert.equal((await hub.send()).status, 200);
    } finally {
      await hub.stop();
    }
  });
});
