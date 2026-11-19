import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { postgresDatabaseRuntime } from "../db/runtime/index.js";
import { markTestReceipt, waitForReceiptLock } from "../db/test-utils/receipt-expiry.js";
import type { ManualReceiptReplayBinding } from "../db/types.js";
import { githubSignerUrl } from "../webhooks/contract.js";
import { DispatchedManualRunSchema, ProblemSchema, ReceivedWebhookSchema } from "./contracts.js";
import { testSigningSettings, webhookFixture } from "./test-utils/webhook-fixture.js";

const org = "webhook-a";
type Hub = Awaited<ReturnType<typeof webhookFixture>>;
type Target = Awaited<ReturnType<Hub["save"]>>;
type Signer = Awaited<ReturnType<Hub["createSigner"]>>;
const signedBody = '{"message":"original signed message","status":"failed"}';

async function bindingFor(hub: Hub, target: Target, triggerId: string | null = null) {
  const revision = await hub.database.findActiveProjectConfiguration(target.runtimeProjectId);
  assert.ok(revision);
  return {
    projectId: target.runtimeProjectId,
    configurationRevisionId: revision.id,
    triggerName: target.name,
    triggerId,
  } satisfies ManualReceiptReplayBinding;
}

function signedRequest(hub: Hub, target: Target, signer: Signer, delivery: string) {
  const signature = createHmac("sha256", signer.signingSecret).update(signedBody).digest("hex");
  return hub.application.publicApi.handle(
    new Request(githubSignerUrl("http://hub.test", target.name, signer.summary.id), {
      method: "POST",
      body: signedBody,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + signature,
        "x-github-delivery": delivery,
      },
    }),
  );
}

async function accepted(response: Response, status: number) {
  assert.equal(response.status, status, await response.clone().text());
  const body = ReceivedWebhookSchema.parse(await response.json());
  assert.ok("triggerRunId" in body);
  return body;
}

async function requireProblem(response: Response, status: number, code: string) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(ProblemSchema.parse(await response.json()).code, code);
}

describe("native public receipt replay", () => {
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

  it("keeps the original Bearer result with conflicting bodies before and through both marker states", async () => {
    const target = await hub.save("bearer-replay");
    const binding = await bindingFor(hub, target);
    const deliveryKey = randomUUID();
    const original = await accepted(
      await hub.send(target.name, "original message", { deliveryKey }),
      202,
    );
    const conflictingBody = { message: "conflicting body", status: "passed", count: 50 };
    for (const state of ["intact", "expiring", "expired"] as const) {
      if (state !== "intact")
        await markTestReceipt(hub.runtime, original.providerEventReceiptId, state, { binding });
      const duplicate = await accepted(
        await hub.send(target.name, conflictingBody, { deliveryKey }),
        200,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.triggerRunId, original.triggerRunId);
      assert.equal(duplicate.providerEventReceiptId, original.providerEventReceiptId);
    }
    assert.equal(
      (await hub.database.findTriggerRunById(original.triggerRunId))?.prompt,
      "original message",
    );
    assert.equal((await hub.database.listTriggerRunsForProject(binding.projectId, 10)).length, 1);
  });

  it("returns the marked Bearer filter result and refuses a marked orphan without redispatch", async () => {
    const target = await hub.save("filtered-replay", { filtered: true });
    const binding = await bindingFor(hub, target);
    const deliveryKey = randomUUID();
    const deliveryId = bearerDelivery(binding, deliveryKey);
    const first = await hub.send(
      target.name,
      { message: "filter", status: "passed" },
      { deliveryKey },
    );
    assert.equal(first.status, 202, await first.clone().text());
    const receipt = await hub.database.findProviderEventReceiptByDeliveryId(deliveryId, org);
    assert.ok(receipt);
    await markTestReceipt(hub.runtime, receipt.id, "expired", { binding });
    const duplicate = await hub.send(target.name, "would pass the filter", { deliveryKey });
    assert.equal(duplicate.status, 200, await duplicate.clone().text());
    assert.deepEqual(await duplicate.json(), { status: "filtered", duplicate: true });

    await hub.runtime.query(
      "update provider_event_receipts set dropped_reason = null where id = $1",
      [receipt.id],
    );
    await requireProblem(
      await hub.send(target.name, "would create a run", { deliveryKey }),
      409,
      "dispatch_conflict",
    );
    assert.deepEqual(await hub.database.findTriggerRunsByProviderEventReceiptId(receipt.id), []);
  });

  it.each([
    { kind: "bearer", valid: true },
    { kind: "bearer", valid: false },
    { kind: "signed", valid: true },
    { kind: "signed", valid: false },
  ] as const)(
    "checks the $kind replay binding (valid: $valid) on a real receipt insert conflict",
    async ({ kind, valid }) => {
      const target = await hub.save(kind + (valid ? "-valid-conflict" : "-invalid-conflict"));
      const signer = kind === "signed" ? await hub.createSigner(target.id) : undefined;
      const binding = await bindingFor(hub, target, signer === undefined ? null : target.id);
      const deliveryKey = randomUUID();
      const deliveryId =
        signer === undefined ? bearerDelivery(binding, deliveryKey) : signedDelivery(signer);
      const receiptId = randomUUID();
      const runId = randomUUID();
      const fixtureReady = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holder = hub.runtime.transaction(async (tx) => {
        await tx.query(
          `insert into provider_event_receipts
           (id, organization_id, provider, delivery_id, source, payload)
         values ($1, $2, 'manual', $3, 'webhook.received', '{}')`,
          [receiptId, org, deliveryId],
        );
        await tx.query(
          `insert into trigger_runs
           (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
            configured_trigger_name, status, prompt, deadline_at)
         values ($1, $2, $3, $4, $5, $6, 'running', 'settled evidence', '2099-01-01')`,
          [runId, org, binding.projectId, binding.configurationRevisionId, receiptId, target.name],
        );
        await markTestReceipt(tx, receiptId, "expiring", {
          binding: valid ? binding : { ...binding, triggerName: "different-trigger" },
        });
        fixtureReady.resolve();
        await release.promise;
      });
      await Promise.race([
        fixtureReady.promise,
        holder.then(() => assert.fail("no receipt barrier")),
      ]);
      const request =
        signer === undefined
          ? hub.send(target.name, "never used", { deliveryKey })
          : signedRequest(hub, target, signer, "new unsigned header");
      try {
        await waitForReceiptLock(hub.runtime, 'insert into "provider_event_receipts"');
        release.resolve();
        const response = await request;
        if (valid) {
          const duplicate = await accepted(response, 200);
          assert.equal(duplicate.triggerRunId, runId);
          assert.equal(duplicate.providerEventReceiptId, receiptId);
          assert.equal(duplicate.duplicate, true);
        } else {
          await requireProblem(response, 404, "trigger_not_found");
        }
        assert.deepEqual(await hub.database.listWorkflowStepRunsForTriggerRun(runId), []);
      } finally {
        release.resolve();
        await Promise.allSettled([holder, request]);
      }
    },
  );

  it("keeps the signed result through rotation and unsigned header changes, then rejects revocation and replacement", async () => {
    const target = await hub.save("signed-replay");
    const signer = await hub.createSigner(target.id);
    const binding = await bindingFor(hub, target, target.id);
    const original = await accepted(await signedRequest(hub, target, signer, "first"), 202);
    await markTestReceipt(hub.runtime, original.providerEventReceiptId, "expiring", { binding });
    const rotated = await hub.runtime.transaction((tx) =>
      hub.keys.signing.rotate(tx, org, {
        id: signer.summary.id,
        expectedCurrentVersionId: signer.summary.authentication.currentVersionId!,
        overlapSeconds: 3600,
      }),
    );
    const current = { ...signer, signingSecret: rotated.signingSecret };
    const oldReplay = await accepted(await signedRequest(hub, target, signer, "overlap"), 200);
    assert.equal(oldReplay.triggerRunId, original.triggerRunId);
    await markTestReceipt(hub.runtime, original.providerEventReceiptId, "expired", { binding });
    const newReplay = await accepted(await signedRequest(hub, target, current, "changed"), 200);
    assert.equal(newReplay.triggerRunId, original.triggerRunId);
    const revoked = await hub.createSigner(target.id);
    assert.equal(await hub.keys.revoke(org, revoked.summary.id), true);
    await requireProblem(await signedRequest(hub, target, revoked, "revoked"), 401, "unauthorized");

    await hub.save("renamed-signed-replay", { triggerId: target.id });
    await hub.save(target.name);
    await requireProblem(
      await signedRequest(hub, target, current, "replacement"),
      404,
      "trigger_not_found",
    );
  });

  it("requires the retained manual revision's script authority when current configuration is an agent", async () => {
    const target = await hub.save("manual-script-replay", { script: true });
    const binding = await bindingFor(hub, target);
    const sender = await hub.createKey(["runs:dispatch"], { actor: "sender" });
    const unbound = await hub.createKey(["runs:dispatch"], { actor: null });
    const deliveryKey = randomUUID();
    const request = (secret: string, input: unknown) =>
      hub.application.publicApi.handle(
        new Request("http://hub.test/api/v1/manual-runs", {
          method: "POST",
          headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
          body: JSON.stringify({
            projectSlug: "default",
            trigger: target.name,
            deliveryKey,
            actor: "sender",
            input,
          }),
        }),
      );
    const first = await request(sender.secret, { message: "script" });
    assert.equal(first.status, 200, await first.clone().text());
    const original = DispatchedManualRunSchema.parse(await first.json());
    await markTestReceipt(hub.runtime, original.providerEventReceiptId, "expired", { binding });
    await hub.save(target.name, { triggerId: target.id });
    const duplicate = await request(sender.secret, {
      message: "different",
      status: "invalid-choice",
    });
    assert.equal(duplicate.status, 200, await duplicate.clone().text());
    assert.equal(
      DispatchedManualRunSchema.parse(await duplicate.json()).triggerRunId,
      original.triggerRunId,
    );
    await requireProblem(await request(unbound.secret, "different"), 403, "key_actor_required");
  });
});

function bearerDelivery(binding: ManualReceiptReplayBinding, deliveryKey: string) {
  return (
    "public-manual-" +
    createHash("sha256")
      .update(JSON.stringify([org, binding.projectId, binding.triggerName, deliveryKey]))
      .digest("base64url")
  );
}

function signedDelivery(signer: Signer) {
  const digest = createHash("sha256").update(signedBody).digest("hex");
  return (
    "public-signature-" +
    createHash("sha256")
      .update(JSON.stringify([org, signer.summary.id, digest]))
      .digest("hex")
  );
}
