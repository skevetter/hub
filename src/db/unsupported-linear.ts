import type { QueryHandle, QueryRow } from "./runtime/index.js";

export const DEFAULT_UNSUPPORTED_LINEAR_RECEIPTS_PER_HOUR = 600;
export const UNSUPPORTED_LINEAR_RECEIPT_LIMIT = 5_000;
export const UNSUPPORTED_LINEAR_RATE_LIMITED = "unsupported_event_rate_limited";

const RATE_SETTING = "PASEO_HUB_LINEAR_UNSUPPORTED_RECEIPTS_PER_HOUR";
const HOUR_MS = 3_600_000;
export const UNSUPPORTED_LINEAR_RECEIPT_PREDICATE =
  "provider = 'linear' and dropped_reason = 'unsupported_event'";

export function readUnsupportedLinearReceiptRate(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const raw = environment[RATE_SETTING]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_UNSUPPORTED_LINEAR_RECEIPTS_PER_HOUR;
  const limit = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > DEFAULT_UNSUPPORTED_LINEAR_RECEIPTS_PER_HOUR
  ) {
    throw new Error(`${RATE_SETTING} must be a whole number from 1 to 600.`);
  }
  return limit;
}

export interface UnsupportedLinearWindow {
  hour: number;
  written: number;
}

interface UnsupportedLinearBudget extends UnsupportedLinearWindow, QueryRow {
  retained_upper_bound: number;
}

export function unsupportedLinearWindow(
  receivedAt: Date,
  previous: UnsupportedLinearWindow | undefined,
): UnsupportedLinearWindow {
  const hour = Math.floor(receivedAt.getTime() / HOUR_MS);
  return previous !== undefined && previous.hour >= hour ? previous : { hour, written: 0 };
}

export async function readUnsupportedLinearBudget(database: QueryHandle, organizationId: string) {
  const { rows } = await database.query<UnsupportedLinearBudget>(
    `select hour, written, retained_upper_bound from unsupported_linear_receipt_budgets
     where organization_id = $1`,
    [organizationId],
  );
  return rows[0];
}

// The organization lock serializes admissions. Independent retention deletes can only lower the
// actual count, so below the upper bound a receipt lookup is unnecessary.
export async function recordUnsupportedLinearAdmission(
  database: QueryHandle,
  organizationId: string,
  window: UnsupportedLinearWindow,
  previous: UnsupportedLinearBudget | undefined,
) {
  let retained = (previous?.retained_upper_bound ?? UNSUPPORTED_LINEAR_RECEIPT_LIMIT) + 1;
  if (retained > UNSUPPORTED_LINEAR_RECEIPT_LIMIT) {
    const { rows } = await database.query<{ count: number }>(
      `select count(*)::int as count from (
         select 1 from provider_event_receipts
         where organization_id = $1 and ${UNSUPPORTED_LINEAR_RECEIPT_PREDICATE}
         limit $2
       ) retained`,
      [organizationId, UNSUPPORTED_LINEAR_RECEIPT_LIMIT + 1],
    );
    retained = rows[0]!.count;
    if (retained > UNSUPPORTED_LINEAR_RECEIPT_LIMIT) {
      await database.query(
        `delete from provider_event_receipts where id = (
           select id from provider_event_receipts
           where organization_id = $1 and ${UNSUPPORTED_LINEAR_RECEIPT_PREDICATE}
           order by received_at asc nulls last, id asc nulls last limit 1
         )`,
        [organizationId],
      );
      retained = UNSUPPORTED_LINEAR_RECEIPT_LIMIT;
    }
  }
  await database.query(
    `insert into unsupported_linear_receipt_budgets (organization_id, hour, written, retained_upper_bound)
     values ($1, $2, $3, $4)
     on conflict (organization_id) do update set hour = excluded.hour, written = excluded.written,
       retained_upper_bound = excluded.retained_upper_bound`,
    [organizationId, window.hour, window.written + 1, retained],
  );
}
