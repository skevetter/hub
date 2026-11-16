import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseDocument } from "yaml";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { ReceiptRetention } from "../receipt-retention/index.js";
import { webhookFixture } from "./test-utils/webhook-fixture.js";

describe("webhook receipt retention", () => {
  it.each(["replacement payload", "changed filters"])(
    "preserves a filtered delivery after eight days with %s",
    async (scenario) => {
      const hub = await webhookFixture();
      try {
        const trigger = await hub.save("retained-delivery", { filtered: true });
        const payload = { message: "original delivery", status: "passed", extra: { count: 2 } };
        const deliveryKey = "retained-delivery";
        const response = await hub.send(trigger.name, payload, { deliveryKey });
        assert.equal(response.status, 202);
        assert.deepEqual(await response.json(), { status: "filtered", duplicate: false });
        assert.deepEqual(
          await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10),
          [],
        );
        const original = await hub.runtime.query<{
          id: string;
          payload: unknown;
          dropped_reason: string;
        }>("select * from provider_event_receipts where source = 'webhook.received'");
        assert.equal(original.rowCount, 1);
        const receipt = original.rows[0]!;
        assert.equal(receipt.dropped_reason, "trigger_filters_rejected");
        await hub.runtime.query(`insert into provider_event_receipts
          (id, organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
          select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
            'webhook-a', 'manual', 'permanent-' || n, 'webhook.received', '{}',
            now() - interval '8 days', 'trigger_filters_rejected' from generate_series(1, 501) n`);
        const expirableId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        await hub.runtime.query(
          `insert into provider_event_receipts
            (id, organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
            values ($1, 'webhook-a', 'github', 'expirable', 'github.push', '{}', now(), 'no_project_route')`,
          [expirableId],
        );
        const retention = new ReceiptRetention(hub.runtime);
        const sweepTime = new Date(Date.now() + 8 * 24 * 60 * 60_000);
        assert.deepEqual(await retention.runBatch(sweepTime), {
          scanned: 500,
          deleted: 0,
          complete: false,
        });
        assert.deepEqual(await retention.runBatch(sweepTime), {
          scanned: 3,
          deleted: 1,
          complete: true,
        });
        const expired = await hub.runtime.query(
          "select id from provider_event_receipts where id = $1",
          [expirableId],
        );
        assert.equal(expired.rowCount, 0);
        const remaining = await hub.runtime.query<{ count: number }>(
          "select count(*)::int as count from provider_event_receipts where source = 'webhook.received'",
        );
        assert.equal(remaining.rows[0]!.count, 502);
        if (scenario === "changed filters") {
          const store = new OrganizationTriggerStore(
            hub.database,
            "webhook-a",
            acceptingAgentValidator(),
          );
          const document = parseDocument((await store.activeRevision(trigger)).yaml);
          document.deleteIn(["on", "manual.run", "filters", "inputs"]);
          await store.save({
            triggerId: trigger.id,
            yaml: document.toString(),
            userId: "webhook-owner",
          });
        }
        const replay = await hub.send(
          trigger.name,
          scenario === "replacement payload"
            ? { status: "failed", message: "replacement" }
            : payload,
          { deliveryKey },
        );
        assert.equal(replay.status, 200);
        assert.deepEqual(await replay.json(), { status: "filtered", duplicate: true });
        assert.deepEqual(
          await hub.database.listTriggerRunsForProject(trigger.runtimeProjectId, 10),
          [],
        );
        const retained = await hub.runtime.query(
          "select * from provider_event_receipts where id = $1",
          [receipt.id],
        );
        assert.deepEqual(retained.rows, original.rows);
      } finally {
        await hub.close();
      }
    },
    120_000,
  );
});
