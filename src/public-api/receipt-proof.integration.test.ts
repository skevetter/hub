import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { postgresDatabaseRuntime } from "../db/runtime/index.js";
import { CUTOFF, NOW, OLD } from "../db/test-utils/receipt-proof-fixture.js";
import { githubSignerUrl } from "../webhooks/contract.js";
import { ReceivedWebhookSchema } from "./contracts.js";
import { testSigningSettings, webhookFixture } from "./test-utils/webhook-fixture.js";

type Hub = Awaited<ReturnType<typeof webhookFixture>>;

async function workflowResult(response: Response, status: number) {
  assert.equal(response.status, status, await response.clone().text());
  const result = ReceivedWebhookSchema.parse(await response.json());
  assert.ok("triggerRunId" in result);
  return result;
}

async function expireOriginal(hub: Hub, receiptId: string, runId: string) {
  await hub.runtime.transaction(async (tx) => {
    await tx.query("update provider_event_receipts set received_at = $2 where id = $1", [
      receiptId,
      OLD,
    ]);
    await tx.query("delete from workflow_wakeups where trigger_run_id = $1", [runId]);
    await tx.query(
      `update trigger_runs set status = 'succeeded', completed_at = $2,
            payload_expiry_state = 'expired', payload_expired_at = $2, payload_summary = '{"stepCounts":{}}',
            terminal_notification_pending_at = null, terminal_notification_lease_expires_at = null
         where id = $1`,
      [runId, NOW],
    );
  });
  assert.deepEqual(await hub.database.expireReceiptPayload(receiptId, CUTOFF, NOW), {
    status: "expired",
  });
}

describe("public webhook replay after production receipt expiry", () => {
  let postgres: StartedPostgreSqlContainer;
  let hub: Hub;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    hub = await webhookFixture(
      {},
      {
        bundle: await postgresDatabaseRuntime(postgres.getConnectionUri()),
        signing: testSigningSettings(),
      },
    );
  }, 120_000);
  afterAll(async () => {
    await hub?.close();
    await postgres?.stop();
  }, 120_000);

  it("returns the original Bearer run before and after applying expiry despite conflicting input", async () => {
    const target = await hub.save("bearer-production");
    const deliveryKey = randomUUID();
    const original = await workflowResult(
      await hub.send(target.name, "private original", { deliveryKey }),
      202,
    );
    const conflicting = { message: "replacement message", status: "passed", count: 7 };
    const before = await workflowResult(
      await hub.send(target.name, conflicting, { deliveryKey }),
      200,
    );
    assert.equal(before.triggerRunId, original.triggerRunId);
    await expireOriginal(hub, original.providerEventReceiptId, original.triggerRunId);
    const after = await workflowResult(
      await hub.send(target.name, conflicting, { deliveryKey }),
      200,
    );
    assert.equal(after.triggerRunId, original.triggerRunId);
    assert.equal(after.providerEventReceiptId, original.providerEventReceiptId);
    const receipt = await hub.database.findProviderEventReceiptById(
      original.providerEventReceiptId,
    );
    assert.equal(receipt?.payload, null);
    assert.equal(receipt?.manualReplayBinding?.projectId, target.runtimeProjectId);
    assert.equal(receipt?.manualReplayBinding?.triggerId, null);
    assert.equal(
      (await hub.database.listTriggerRunsForProject(target.runtimeProjectId, 10)).length,
      1,
    );
  });

  it("derives the signed binding at expiry and keeps exact-body replay through key rotation", async () => {
    const target = await hub.save("signed-production");
    const signer = await hub.createSigner(target.id);
    const body = '{"message":"signed private original","status":"failed"}';
    const send = (secret: string, deliveryId: string) =>
      hub.application.publicApi.handle(
        new Request(githubSignerUrl("http://hub.test", target.name, signer.summary.id), {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-github-delivery": deliveryId,
            "x-hub-signature-256":
              "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
          },
        }),
      );
    const original = await workflowResult(await send(signer.signingSecret, "first"), 202);
    const originalRun = await hub.database.findTriggerRunById(original.triggerRunId);
    assert.ok(originalRun);
    await hub.save(target.name, { triggerId: target.id, filtered: true });
    const current = await hub.database.findActiveProjectConfiguration(target.runtimeProjectId);
    assert.notEqual(current?.id, originalRun.configurationRevisionId);
    await expireOriginal(hub, original.providerEventReceiptId, original.triggerRunId);
    const receipt = await hub.database.findProviderEventReceiptById(
      original.providerEventReceiptId,
    );
    assert.equal(
      receipt?.manualReplayBinding?.configurationRevisionId,
      originalRun.configurationRevisionId,
    );
    assert.equal(receipt?.manualReplayBinding?.triggerId, target.id);
    const rotated = await hub.runtime.transaction((tx) =>
      hub.keys.signing.rotate(tx, "webhook-a", {
        id: signer.summary.id,
        expectedCurrentVersionId: signer.summary.authentication.currentVersionId!,
        overlapSeconds: 3600,
      }),
    );
    for (const [secret, header] of [
      [signer.signingSecret, "overlap"],
      [rotated.signingSecret, "current"],
    ] as const) {
      const duplicate = await workflowResult(await send(secret, header), 200);
      assert.equal(duplicate.triggerRunId, original.triggerRunId);
      assert.equal(duplicate.providerEventReceiptId, original.providerEventReceiptId);
    }
  });

  it("redacts a proved no-run Bearer filter result and keeps it settled on changed input", async () => {
    const target = await hub.save("filtered-production", { filtered: true });
    const deliveryKey = randomUUID();
    const first = await hub.send(
      target.name,
      { message: "first", status: "passed" },
      { deliveryKey },
    );
    assert.equal(first.status, 202);
    const [receipt] = (
      await hub.runtime.query<{ id: string }>(
        `select id from provider_event_receipts where source = 'webhook.received' and dropped_reason = 'trigger_filters_rejected'`,
      )
    ).rows;
    assert.ok(receipt);
    await hub.runtime.query("update provider_event_receipts set received_at = $2 where id = $1", [
      receipt.id,
      OLD,
    ]);
    assert.deepEqual(await hub.database.expireReceiptPayload(receipt.id, CUTOFF, NOW), {
      status: "expired",
    });
    const duplicate = await hub.send(
      target.name,
      { message: "retry", status: "failed" },
      { deliveryKey },
    );
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { status: "filtered", duplicate: true });
    assert.deepEqual(await hub.database.findTriggerRunsByProviderEventReceiptId(receipt.id), []);
  });
});
