import assert from "node:assert/strict";
import { it } from "vitest";
import { createMemoryDatabase } from "../memory.js";
import type { QueryHandle } from "../runtime/index.js";
import {
  createRevision,
  NOW,
  OLD,
  seedProofMatrix,
  seedProofReceipt,
} from "./receipt-proof-fixture.js";

it("preserves receipt SQL, parameter order, and result keys", async () => {
  const database = createMemoryDatabase();
  const route = await createRevision(database, "manual.run");
  const statements: unknown[] = [];
  const runtime: QueryHandle = {
    async query(sql, params) {
      statements.push([sql, params]);
      return { rows: [], rowCount: 0 };
    },
  };
  const receipt = await seedProofReceipt(database, runtime, {
    key: "test",
    provider: "github",
    source: "github.issues",
    route,
    payload: { text: "sample" },
    additionalRoutes: [route],
    references: [{}, { state: "intact", outcome: "rejected", name: "other" }],
    disposition: "eligible",
  });
  const [accepted, rejected] = receipt.runs;
  const updateRun = `update trigger_runs set status = case when outcome = 'rejected' then 'rejected' else 'succeeded' end,
            completed_at = $2, payload_expiry_state = $3, payload_expired_at = $4, payload_summary = $5 where id = $1`;
  assert.deepEqual(statements, [
    [
      `update provider_event_receipts set provider = $2, connection_id = $3, resource_id = $4, repo = $5,
        dropped_reason = $6, pre_routing_drop = $7, accepted_routes = $8 where id = $1`,
      [
        receipt.id,
        "github",
        null,
        null,
        null,
        null,
        null,
        JSON.stringify([{ ...route, fixture: "receipt-route-test-marker" }, route]),
      ],
    ],
    ["delete from workflow_wakeups where trigger_run_id = $1", [accepted]],
    [
      updateRun,
      [
        accepted,
        NOW,
        "expired",
        NOW,
        { stepCounts: {}, repository: null, links: [], completion: null },
      ],
    ],
    ["delete from workflow_wakeups where trigger_run_id = $1", [rejected]],
    [updateRun, [rejected, NOW, null, null, null]],
  ]);
  assert.deepEqual(Object.keys(receipt), [
    "id",
    "key",
    "marker",
    "routeMarker",
    "deliveryId",
    "signatureHash",
    "disposition",
    "route",
    "runs",
  ]);
  const stored = await database.findProviderEventReceiptById(receipt.id);
  assert.deepEqual(stored?.receivedAt, OLD);
  assert.equal(receipt.signatureHash, "signature-test");
});

it("seeds the complete memory matrix in provider and case order", async () => {
  const cases = await seedProofMatrix(createMemoryDatabase());
  assert.deepEqual(
    cases.map(({ key }) => key),
    [
      "github-accepted",
      "github-rejected",
      "github-wrong-outcome",
      "github-zero",
      "github-partial",
      "github-expiring-sibling",
      "github-young-sibling",
      "github-extra-branch",
      "github-missing-revision",
      "github-foreign-revision",
      "github-cutoff",
      "github-push",
      "github-unrouted",
      "github-legacy-unrouted",
      "github-legacy-binding-missing",
      "github-drop-unproven",
      "linear",
      "linear-delegate",
      "manual",
      "manual-orphan",
      "manual-synthetic",
      "bearer",
      "bearer-pending",
      "bearer-filtered",
      "signed",
      "signed-unproved",
      "slack",
      "discord",
      "schedule",
      "schedule-orphan",
      "notification",
      "notification-inconsistent",
    ],
  );
});
