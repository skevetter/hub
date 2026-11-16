import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import type { DatabaseRuntime } from "../db/runtime/index.js";
import { isPostgresJson } from "../http/json-storage.js";
import { DispatchedManualRunSchema, ProblemSchema } from "./contracts.js";
import { webhookFixture } from "./test-utils/webhook-fixture.js";

const dispatchedSchema = DispatchedManualRunSchema.extend({ duplicate: z.boolean() }).strict();

async function receiptCount(runtime: DatabaseRuntime): Promise<number> {
  const result = await runtime.query<{ count: number }>(
    "select count(*)::integer as count from provider_event_receipts where organization_id = 'webhook-a'",
  );
  const count = result.rows[0]?.count;
  assert.ok(count !== undefined);
  return count;
}

async function invalidBody(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const body = await response.text();
  assert.equal(ProblemSchema.parse(JSON.parse(body)).code, code);
  assert.equal(body.includes("private-value"), false);
  assert.equal(body.includes("private-key"), false);
}

describe("webhook Unicode storage validation", () => {
  it("rejects escaped NUL and lone surrogates in every JSON position before reserving delivery keys", async () => {
    const hub = await webhookFixture();
    try {
      await hub.save();
      let accepted = 0;
      for (const invalid of ["\u0000", "\ud800", "\udc00"]) {
        const value = `private-value-${invalid}`;
        const key = `private-key-${invalid}`;
        for (const body of [
          { message: value },
          { message: "hello", extra: value },
          { nested: [null, { values: [value] }] },
          { [key]: "hello" },
          { nested: [{ [key]: { value: "hello" } }] },
        ]) {
          const deliveryKey = `unicode-json-${accepted}`;
          await invalidBody(
            await hub.send("build-finished", body, { deliveryKey }),
            422,
            "invalid_body",
          );
          assert.equal(await receiptCount(hub.runtime), accepted);
          const corrected = await hub.send(
            "build-finished",
            { message: "corrected" },
            { deliveryKey },
          );
          assert.equal(corrected.status, 202);
          const result = dispatchedSchema.parse(await corrected.json());
          assert.equal(result.duplicate, false);
          const duplicate = await hub.send(
            "build-finished",
            { message: "replacement" },
            { deliveryKey },
          );
          assert.equal(duplicate.status, 200);
          assert.deepEqual(dispatchedSchema.parse(await duplicate.json()), {
            ...result,
            duplicate: true,
          });
          accepted += 1;
          assert.equal(await receiptCount(hub.runtime), accepted);
        }
      }
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("rejects text NUL and invalid UTF-8 surrogate encodings without reserving delivery keys", async () => {
    const hub = await webhookFixture();
    try {
      await hub.save();
      const prefix = new TextEncoder().encode("private-value-");
      const invalidBytes = [
        new Uint8Array([0]),
        new Uint8Array([0xed, 0xa0, 0x80]),
        new Uint8Array([0xed, 0xb0, 0x80]),
        new Uint8Array([0xf0, 0x9f, 0x98]),
      ];
      for (const [index, invalid] of invalidBytes.entries()) {
        const deliveryKey = `unicode-text-${index}`;
        const bytes = new Uint8Array(prefix.byteLength + invalid.byteLength);
        bytes.set(prefix);
        bytes.set(invalid, prefix.byteLength);
        await invalidBody(
          await hub.application.publicApi.handle(
            new Request("http://hub.test/api/v1/hooks/build-finished", {
              method: "POST",
              headers: {
                authorization: `Bearer ${hub.key.secret}`,
                "content-type": "text/plain",
                "idempotency-key": deliveryKey,
              },
              body: bytes,
            }),
          ),
          400,
          "invalid_request",
        );
        assert.equal(await receiptCount(hub.runtime), index);
        const response = await hub.send("build-finished", "legal \ud83d\ude00 text", {
          deliveryKey,
        });
        assert.equal(response.status, 202);
        assert.equal(dispatchedSchema.parse(await response.json()).duplicate, false);
        assert.equal(await receiptCount(hub.runtime), index + 1);
      }
    } finally {
      await hub.close();
    }
  }, 120_000);

  it("preserves paired astral Unicode and serialized scalar byte counts when context is truncated", async () => {
    const hub = await webhookFixture();
    try {
      await hub.save();
      const scalar = "\ud83d\ude00";
      const message = scalar.repeat(16_384);
      const data = { message, count: 2, nested: { [scalar]: [scalar, "x".repeat(100_000)] } };
      assert.equal(Buffer.byteLength(message, "utf8"), 65_536);
      const response = await hub.send("build-finished", data, { deliveryKey: "paired-unicode" });
      assert.equal(response.status, 202);
      const result = dispatchedSchema.parse(await response.json());
      const run = await hub.database.findTriggerRunById(result.triggerRunId);
      assert.ok(run);
      assert.equal(run.prompt, message);
      assert.deepEqual(run.inputs, { status: "failed", count: 2 });
      assert.equal(isPostgresJson(run.triggerContext), true);
      assert.ok(Buffer.byteLength(JSON.stringify(run.triggerContext), "utf8") <= 65_536);
      const markerSchema = z.object({ truncated: z.literal(true), bytes: z.number() }).strict();
      const context = z
        .object({
          event: z
            .object({
              manual: z.object({ input: markerSchema, data: markerSchema }).passthrough(),
            })
            .passthrough(),
        })
        .parse(run.triggerContext);
      assert.ok(Buffer.byteLength(JSON.stringify(context.event, null, 2), "utf8") <= 65_536);
      assert.deepEqual(context.event.manual.input, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(message), "utf8"),
      });
      assert.deepEqual(context.event.manual.data, {
        truncated: true,
        bytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
      });
      const receipt = await hub.database.findProviderEventReceiptById(
        result.providerEventReceiptId,
      );
      assert.ok(receipt);
      assert.deepEqual(z.object({ data: z.unknown() }).parse(receipt.payload).data, data);
      const replay = await hub.send(
        "build-finished",
        { message: "replacement" },
        {
          deliveryKey: "paired-unicode",
        },
      );
      assert.equal(replay.status, 200);
      assert.deepEqual(dispatchedSchema.parse(await replay.json()), { ...result, duplicate: true });
    } finally {
      await hub.close();
    }
  }, 120_000);
});
