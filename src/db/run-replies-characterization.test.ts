import { expect, it, vi } from "vitest";
import { postgresRunReplies } from "./run-replies.js";
import type { DatabaseRuntime, QueryRow, TransactionHandle } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";

const input = {
  organizationId: "org",
  runId: "run",
  length: 1,
  hash: "hash",
  bindingHash: "binding",
  perHour: 2,
};
const pending = { state: "pending", eligible: true };

function reservations(...batches: QueryRow[][]) {
  const trace: unknown[] = [];
  const transaction: TransactionHandle = {
    async query(sql, params) {
      trace.push([sql, params]);
      throw new Error("unexpected query");
    },
    drizzle() {
      throw new Error("unexpected drizzle");
    },
    rollback() {
      throw new Error("unexpected rollback");
    },
  };
  const query = vi.spyOn(transaction, "query");
  for (const rows of batches) query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  const runtime: DatabaseRuntime = {
    ...transaction,
    async transaction(operation) {
      trace.push("transaction");
      return operation(transaction);
    },
    async migrate() {
      throw new Error("unexpected migrate");
    },
    async close() {
      throw new Error("unexpected close");
    },
  };
  const lock = vi.fn<Locks["withTxLock"]>(async () => {
    trace.push("locked");
  });
  const locks: Locks = {
    async withLock() {
      throw new Error("unexpected outer lock");
    },
    withTxLock: lock,
    async tryTxLock() {
      throw new Error("unexpected try lock");
    },
  };
  const store = postgresRunReplies(runtime, locks);
  return { store, query, trace, lock };
}

it("holds the organization lock before checking eligibility and performs no writes on early returns", async () => {
  for (const [rows, status] of [
    [[], "run_unavailable"],
    [[{ state: "pending", eligible: false }], "run_unavailable"],
    [[{ state: "sending", eligible: true }], "already_handled"],
  ] as const) {
    const { store, query, trace, lock } = reservations([...rows]);
    expect(await store.reserve(input)).toBe(status);
    expect(trace).toEqual(["transaction", "locked"]);
    expect(lock.mock.calls.map(([, key]) => key)).toEqual(["run-reply:org"]);
    expect(query.mock.calls).toEqual([
      [
        `select reply.state, run.status = 'succeeded' and run.payload_expiry_state is null as eligible
           from run_reply_deliveries reply join trigger_runs run on run.id = reply.trigger_run_id
           where reply.organization_id = $1 and reply.trigger_run_id = $2
           for update of reply for share of run`,
        ["org", "run"],
      ],
    ]);
  }
});

it("counts recent attempts and preserves both reservation writes and their parameters", async () => {
  const reserved = reservations([pending], [{ count: 1 }], []);
  expect(await reserved.store.reserve(input)).toBe("reserved");
  expect(reserved.query.mock.calls.slice(1)).toEqual([
    [
      `select count(*)::integer as count from run_reply_deliveries
           where organization_id = $1 and attempted_at > clock_timestamp() - interval '1 hour'`,
      ["org"],
    ],
    [
      `update run_reply_deliveries
           set state = 'sending', length = $2, content_hash = $3, binding_hash = $4,
               attempted_at = clock_timestamp()
           where trigger_run_id = $1`,
      ["run", 1, "hash", "binding"],
    ],
  ]);
  const limited = reservations([pending], [{ count: 2 }], []);
  expect(await limited.store.reserve(input)).toBe("rate_limited");
  expect(limited.query.mock.calls.at(-1)).toEqual([
    `update run_reply_deliveries set state = 'refused', failure = 'rate_limited'
             where trigger_run_id = $1`,
    ["run"],
  ]);
});

it("throws before writing if the count result unexpectedly lacks its aggregate row", async () => {
  const { store, query } = reservations([pending], []);
  await expect(store.reserve(input)).rejects.toThrow(
    "Cannot read properties of undefined (reading 'count')",
  );
  expect(query.mock.calls.length).toBe(2);
});
