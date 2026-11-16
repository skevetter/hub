import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import { DispatchedManualRunSchema, ProblemSchema } from "./contracts.js";
import { webhookFixture } from "./test-utils/webhook-fixture.js";

const wideMetadata = Object.fromEntries(
  Array.from({ length: 1001 }, (_, index) => [`field-${index}`, index]),
);
let deepMetadata: unknown = "leaf";
for (let depth = 0; depth < 21; depth += 1) deepMetadata = { child: deepMetadata };

const cases = [
  ["1001 metadata fields", wideMetadata],
  ["21 nested metadata objects", deepMetadata],
] as const;

describe("legacy manual JSON metadata", () => {
  it.each(cases)(
    "accepts %s on manual runs while preserving webhook-only limits",
    async (_name, metadata) => {
      const hub = await webhookFixture();
      try {
        const trigger = await hub.save("legacy-metadata");
        const legacy = await hub.createKey(["runs:dispatch"], { actor: null });
        const input = { message: "Preserve legacy metadata", status: "failed", count: 2, metadata };
        const response = await hub.application.publicApi.handle(
          new Request("http://hub.test/api/v1/manual-runs", {
            method: "POST",
            headers: {
              authorization: `Bearer ${legacy.secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              projectSlug: "default",
              trigger: trigger.name,
              actor: "sender",
              deliveryKey: randomUUID(),
              input,
            }),
          }),
        );
        assert.equal(response.status, 200);
        const result = DispatchedManualRunSchema.parse(await response.json());
        const run = await hub.database.findTriggerRunById(result.triggerRunId);
        assert.ok(run);
        assert.equal(run.prompt, input.message);
        assert.deepEqual(run.inputs, { status: "failed", count: 2 });
        const context = z
          .object({ event: z.object({ manual: z.object({ data: z.unknown() }) }) })
          .parse(run.triggerContext);
        assert.deepEqual(context.event.manual.data, input);
        const receipt = await hub.database.findProviderEventReceiptById(
          result.providerEventReceiptId,
        );
        assert.deepEqual(z.object({ input: z.unknown() }).parse(receipt?.payload).input, input);
        const webhook = await hub.send(trigger.name, input, { deliveryKey: randomUUID() });
        assert.equal(webhook.status, 422);
        assert.equal(ProblemSchema.parse(await webhook.json()).code, "invalid_body");
        const webhookReceipts = await hub.runtime.query<{ count: number }>(
          "select count(*)::integer as count from provider_event_receipts where source = 'webhook.received'",
        );
        assert.equal(webhookReceipts.rows[0]?.count, 0);
      } finally {
        await hub.close();
      }
    },
    120_000,
  );
});
