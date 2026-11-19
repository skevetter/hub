import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { QueryHandle } from "../runtime/index.js";
import type { ManualReceiptReplayBinding, ReceiptPayloadExpiryState } from "../types.js";

export async function markTestReceipt(
  runtime: QueryHandle,
  id: string,
  state: ReceiptPayloadExpiryState,
  options: { binding?: ManualReceiptReplayBinding; retainContent?: boolean } = {},
) {
  const result = await runtime.query(
    `update provider_event_receipts set payload_expiry_state = $2,
       payload_expired_at = coalesce(payload_expired_at, clock_timestamp()),
       payload = case when $3 then payload else '{}'::jsonb end,
       accepted_routes = case when $3 then accepted_routes end,
       manual_replay_binding = $4, pre_routing_drop = null
     where id = $1`,
    [id, state, options.retainContent ?? false, options.binding ?? null],
  );
  assert.equal(result.rowCount, 1);
}

export async function waitForReceiptLock(runtime: QueryHandle, queryFragment: string) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const result = await runtime.query<{ blocked: boolean }>(
      `select exists (
         select 1 from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid()
           and strpos(lower(query), $1) > 0 and cardinality(pg_blocking_pids(pid)) > 0
       ) as blocked`,
      [queryFragment.toLowerCase()],
    );
    if (result.rows[0]?.blocked === true) return;
    await delay(10);
  }
  throw new Error(`PostgreSQL did not block the expected query: ${queryFragment}`);
}
