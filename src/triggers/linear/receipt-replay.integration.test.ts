import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { it, vi } from "vitest";
import { ProjectConfigurationStore } from "../../configuration/store.js";
import { ageReceiptAndSettleRuns, drainReceiptSweep } from "../../db/test-utils/receipt-expiry.js";
import { NOW, OLD, compiledFixture } from "../../db/test-utils/receipt-proof-fixture.js";
import {
  TIMELINE_ORGANIZATION as organizationId,
  createTimelinePostgresHarness,
} from "../../db/test-utils/run-timeline-postgres.js";
import type { DurableProviderEvent } from "../../db/types.js";
import { DurableWorkflowEngine } from "../../workflows/engine.js";
import { createLinearTriggerProvider } from "./provider.js";
import { createLinearWebhookSource } from "./webhook.js";

const secret = "linear-fixture-secret";
const linearOrganizationId = "linear-fixture";
const deliveryId = "linear-retry";

function request() {
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: linearOrganizationId,
    webhookTimestamp: NOW.getTime(),
    actor: { id: "sender", name: "Sender" },
    data: { id: "comment", issueId: "issue", body: "Please investigate" },
  });
  return new Request("http://hub.test/linear", {
    method: "POST",
    body,
    headers: {
      "linear-delivery": deliveryId,
      "linear-event": "Comment",
      "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
    },
  });
}

it("acknowledges a Linear retry and skips a cached match when expiry commits after their first reads", async () => {
  const harness = await createTimelinePostgresHarness();
  const release = Promise.withResolvers<void>();
  try {
    const reader = await harness.connect();
    const { database } = reader;
    const connectionId = randomUUID();
    await harness.runtime.query(
      `insert into linear_connections
        (id, organization_id, linear_organization_id, provider_application_id, slug,
         linear_organization_name, app_user_id, access_token, refresh_token, scopes)
       values ($1, $2, $3, 'app', 'linear', 'Fixture', 'bot', 'access', 'refresh',
        '["read","comments:create","app:assignable","app:mentionable"]')`,
      [connectionId, organizationId, linearOrganizationId],
    );
    const project = await database.createProject({
      organizationId,
      name: "Linear receipt replay",
      slug: "linear-replay",
      createdByUserId: null,
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: {},
      normalizedConfiguration: compiledFixture("linear.comment_created", {
        from_users: ["sender"],
      }),
      contentHash: "linear-replay",
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id, [
      { provider: "linear", connectionId, resourceId: null, triggerName: "target" },
    ]);
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: (id) => new ProjectConfigurationStore(database, id),
    });
    // Spy on the real matcher and pause each caller only after its first committed read.
    const match = vi.spyOn(provider, "match");
    const engine = new DurableWorkflowEngine({
      database,
      entitlements: null,
      providers: [provider],
    });
    const retryRead = Promise.withResolvers<void>();
    const engineRead = Promise.withResolvers<void>();
    const getMarked = database.findMarkedLinearReceipt.bind(database);
    const resolveIssue = vi
      .fn()
      .mockResolvedValueOnce({
        id: "issue",
        identifier: "ENG-1",
        title: "Issue",
        description: null,
        projectId: "linear-project",
        stateId: "ready",
        assigneeId: null,
        labelIds: [],
      })
      .mockRejectedValue(new Error("issue lookup unavailable"));
    let firstRetryRead = false;
    const findMarkedReceipt = vi.fn(async (...args: Parameters<typeof getMarked>) => {
      const marked = await getMarked(...args);
      if (firstRetryRead) {
        firstRetryRead = false;
        assert.equal(marked, false);
        retryRead.resolve();
        await release.promise;
      }
      return marked;
    });
    const source = createLinearWebhookSource({
      signingSecret: secret,
      now: () => NOW.getTime(),
      accept: (input) => database.acceptLinearEvent(input),
      findMarkedReceipt,
      resolveIssue,
    });
    const handoffs: DurableProviderEvent[] = [];
    await source.start(async (event) => {
      handoffs.push(event);
      await engine.enqueue(event);
    });
    assert.equal((await source.handle(request())).status, 200);
    assert.equal(handoffs.length, 1);
    assert.equal(match.mock.calls.length, 1);
    const event = handoffs[0]!;
    const [run] = await database.findTriggerRunsByProviderEventReceiptId(
      event.providerEventReceiptId,
    );
    assert.ok(run);
    await ageReceiptAndSettleRuns(harness.runtime, event.providerEventReceiptId, OLD, NOW);
    const readMetadata = database.findProviderEventReplayMetadata.bind(database);
    let firstEngineRead = true;
    vi.spyOn(database, "findProviderEventReplayMetadata").mockImplementation(async (...args) => {
      const result = await readMetadata(...args);
      if (firstEngineRead) {
        firstEngineRead = false;
        assert.equal(result?.payloadExpiryState, null);
        engineRead.resolve();
        await release.promise;
      }
      return result;
    });
    firstRetryRead = true;
    const retry = source.handle(request());
    const replay = engine.enqueue(event);
    try {
      await Promise.all([
        Promise.race([retryRead.promise, retry.then(() => assert.fail("retry missed barrier"))]),
        Promise.race([engineRead.promise, replay.then(() => assert.fail("engine missed barrier"))]),
      ]);
      const report = await drainReceiptSweep(harness.database, NOW);
      assert.equal(report.receiptApply.receipt.applied, 1);
      assert.equal(
        (await harness.database.findProviderEventReceiptById(event.providerEventReceiptId))
          ?.payloadExpiryState,
        "expired",
      );
    } finally {
      release.resolve();
      await Promise.allSettled([retry, replay]);
      await source.stop();
    }
    assert.equal((await retry).status, 200);
    assert.equal(resolveIssue.mock.calls.length, 2);
    assert.equal(findMarkedReceipt.mock.calls.length, 3);
    assert.deepEqual(await replay, {
      providerEventReceiptId: event.providerEventReceiptId,
      replayed: true,
    });
    assert.equal(match.mock.calls.length, 1);
    assert.equal(handoffs.length, 1);
    assert.deepEqual(
      (await database.findTriggerRunsByProviderEventReceiptId(event.providerEventReceiptId)).map(
        ({ id }) => id,
      ),
      [run.id],
    );
  } finally {
    release.resolve();
    await harness.close();
  }
}, 120_000);
