import { expect, it, vi } from "vitest";
import { expireGitHubSyncPayload } from "./auxiliary-receipt-payload-retention.js";
import type { DatabaseRuntime, QueryResult, QueryRow, TransactionHandle } from "./runtime/index.js";

const old = new Date("2026-01-01");
const cutoff = new Date("2026-02-01");
const now = new Date("2026-03-01");
const receiptId = "11111111-1111-4111-8111-111111111111";
const identity = {
  providerApplicationId: "app",
  connectionId: "connection",
  deliveryId: "delivery",
  signatureHash: "signature",
  source: "github.installation",
};
const sync = {
  ...identity,
  id: "sync",
  retryAt: null,
  receivedAt: old,
  settledAt: old,
  auditLink: { kind: "receipt", receiptId, organizationId: "org" },
  payloadExpiredAt: null,
  hasAnyCopy: false,
};
const copy = {
  ...identity,
  id: receiptId,
  organizationId: "org",
  provider: "github",
  resourceId: null,
  receivedAt: old,
  droppedReason: "github_lifecycle",
  acceptedRoutes: null,
  payloadExpiryState: null,
  hasReferences: false,
};

const count = (rowCount: number): QueryResult => ({ rows: [], rowCount });
const result = (...rows: QueryRow[]): QueryResult => ({ rows, rowCount: rows.length });

function expire(...batches: QueryResult[]) {
  const trace: string[] = [];
  const client: TransactionHandle = {
    async query() {
      throw new Error("unexpected query");
    },
    drizzle() {
      throw new Error("unexpected drizzle");
    },
    rollback() {
      throw new Error("unexpected rollback");
    },
  };
  const query = vi.spyOn(client, "query");
  for (const batch of batches) query.mockResolvedValueOnce(batch);
  const db: DatabaseRuntime = {
    ...client,
    async transaction(operation) {
      trace.push("begin");
      try {
        const value = await operation(client);
        trace.push("commit");
        return value;
      } catch (error) {
        trace.push("rollback");
        throw error;
      }
    },
    async migrate() {
      throw new Error("unexpected migrate");
    },
    async close() {
      throw new Error("unexpected close");
    },
  };
  return { disposition: expireGitHubSyncPayload(db, "sync", cutoff, now), query, trace };
}

it("preserves the sync lock checks and error for an unexpectedly missing locked row", async () => {
  for (const rowCount of [0, 1]) {
    const { disposition, query, trace } = expire(count(0), count(rowCount));
    expect(JSON.stringify(await disposition)).toBe(
      JSON.stringify({
        status: "skipped",
        disposition: rowCount === 0 ? "changed_or_missing" : "locked",
      }),
    );
    expect(query.mock.calls.map(([, params]) => params)).toEqual([["sync"], ["sync"]]);
    expect(query.mock.calls[0]?.[0].endsWith("for update skip locked")).toBe(true);
    expect(trace).toEqual(["begin", "commit"]);
  }
  const missing = expire(count(1), result());
  await expect(missing.disposition).rejects.toThrow(
    "Cannot read properties of undefined (reading 'auditLink')",
  );
  expect(missing.trace).toEqual(["begin", "rollback"]);
});

it("distinguishes pending syncs, absent receipt copies, and busy copies", async () => {
  for (const [receipt, disposition] of [
    [result(copy), "locked"],
    [result(), "audit_link_unproven"],
  ] as const) {
    const fixture = expire(count(1), result(sync), count(0), receipt);
    expect(await fixture.disposition).toEqual({ status: "skipped", disposition });
    expect(fixture.query.mock.calls.map(([, params]) => params)).toEqual([
      ["sync"],
      ["sync"],
      [receiptId],
      [[receiptId]],
    ]);
  }
  const pending = expire(count(1), result({ ...sync, retryAt: old, auditLink: { kind: "none" } }));
  expect(await pending.disposition).toEqual({ status: "skipped", disposition: "sync_pending" });
  expect(pending.query.mock.calls.length).toBe(2);
});

it("expires eligible linked copies before the sync, rolling back on either lost row", async () => {
  const prefix = [count(1), result(sync), count(1), result(copy)];
  const successful = expire(...prefix, count(1), count(1));
  expect(JSON.stringify(await successful.disposition)).toBe(
    '{"status":"expired","receiptCopy":true}',
  );
  expect(successful.query.mock.calls.map(([, params]) => params)).toEqual([
    ["sync"],
    ["sync"],
    [receiptId],
    [[receiptId]],
    [receiptId, now, cutoff],
    ["sync", now, cutoff],
  ]);
  expect(successful.trace).toEqual(["begin", "commit"]);
  const lostCopy = expire(...prefix, count(0));
  await expect(lostCopy.disposition).rejects.toThrow("sync expiry lost its locked receipt");
  expect(lostCopy.query.mock.calls.length).toBe(5);
  expect(lostCopy.trace).toEqual(["begin", "rollback"]);
  const lostSync = expire(...prefix, count(1), count(0));
  await expect(lostSync.disposition).rejects.toThrow("sync expiry lost its locked sync");
  expect(lostSync.trace).toEqual(["begin", "rollback"]);
});

it("expires an unlinked sync without attempting a receipt update", async () => {
  const { disposition, query } = expire(
    count(1),
    result({
      ...sync,
      connectionId: null,
      auditLink: { kind: "none" },
    }),
    count(1),
  );
  expect(JSON.stringify(await disposition)).toBe('{"status":"expired","receiptCopy":false}');
  expect(query.mock.calls.map(([, params]) => params)).toEqual([
    ["sync"],
    ["sync"],
    ["sync", now, cutoff],
  ]);
});
