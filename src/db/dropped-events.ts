import {
  displayedDropReason,
  dropReasonGroup,
  GITHUB_LIFECYCLE_RECEIPT,
  RECEIPT_REASON_CODES,
  ROUTING_DROP_REASONS,
} from "../triggers/drop-reason.js";
import type { ListProvider } from "../triggers/list-providers.js";
import type { QueryHandle } from "./runtime/index.js";
import type {
  DroppedEventPageRecord,
  DroppedEventPageRequest,
  DroppedProviderEventCount,
  ProviderEventReceiptRecord,
} from "./types.js";

export const RECENT_DROP_COUNT_LIMIT = 2_500;
export const UNSUPPORTED_LINEAR_RECEIPT_LIMIT = 5_000;

type Provider = ProviderEventReceiptRecord["provider"];
type ReceiptIdentity = Pick<ProviderEventReceiptRecord, "provider" | "source">;

export function droppedEventProvider({ provider, source }: ReceiptIdentity): ListProvider {
  return provider === "manual" && source === "webhook.received" ? "webhook" : provider;
}

export function routingDropPredicate(column: "dropped_reason" | "receipt.dropped_reason") {
  return `${column} in (${ROUTING_DROP_REASONS.map((reason) => `'${reason}'`).join(", ")})`;
}

export function otherDropPredicate(column: "dropped_reason" | "receipt.dropped_reason") {
  return `${column} not in (${RECEIPT_REASON_CODES.map((reason) => `'${reason}'`).join(", ")})`;
}

function receiptPageFilters(
  { provider, reason, receivedSince, source }: DroppedEventPageRequest,
  params: unknown[],
) {
  const bind = (value: unknown) => `$${params.push(value)}`;
  const filters = ["receipt.organization_id = $1", "receipt.dropped_reason is not null"];
  if (provider === "webhook") {
    filters.push("receipt.provider = 'manual' and receipt.source = 'webhook.received'");
  } else if (provider !== undefined) {
    filters.push(`receipt.provider = ${bind(provider)}`);
    if (provider === "manual") filters.push("receipt.source <> 'webhook.received'");
  }
  if (source !== undefined) filters.push(`receipt.source = ${bind(source)}`);
  if (receivedSince !== undefined) filters.push(`receipt.received_at >= ${bind(receivedSince)}`);
  if (reason === "routing") {
    filters.push(routingDropPredicate("receipt.dropped_reason"));
  } else if (reason === "other") {
    filters.push(`receipt.dropped_reason <> all(${bind(RECEIPT_REASON_CODES)}::text[])`);
  } else if (reason !== undefined) {
    filters.push(`receipt.dropped_reason = ${bind(reason)}`);
  }
  return filters.join(" and ");
}

export async function readDroppedEventPage(
  database: QueryHandle,
  organizationId: string,
  request: DroppedEventPageRequest,
): Promise<DroppedEventPageRecord> {
  const { limit, position } = request;
  const params: unknown[] = [organizationId];
  const scoped = `from provider_event_receipts receipt where ${receiptPageFilters(request, params)}`;
  const boundary = `($${params.length + 1}::timestamptz, $${params.length + 2}::uuid)`;
  const after = position?.direction === "after";
  // Both keys are non-null. Preserve the exact order with the dropped-receipt indexes.
  const order = after ? "asc nulls last" : "desc nulls first";
  const result = await database.query<{
    id: string;
    provider: Provider;
    source: string;
    reason: string;
    received_at: Date;
    cursor_time: string;
    workspace: string | null;
    trigger_id: string | null;
  }>(
    `select page.*, coalesce(page.repo, case page.provider
        when 'linear' then (select slug from linear_connections where organization_id = $1 and id = page.connection_id)
        when 'slack' then (select slug from slack_connections where organization_id = $1 and id = page.connection_id)
        when 'discord' then (select slug from discord_connections where organization_id = $1 and id = page.connection_id)
      end) as workspace, coalesce(page.bound_trigger_id, (
        select case when count(*) = 1 then min(candidate.id::text) end
        from (
          select id from organization_triggers
          where page.trigger_project_id is not null and organization_id = $1
            and format = 'single_run' and runtime_project_id::text = page.trigger_project_id
          limit 2
        ) candidate
      )) as trigger_id
      from (
        select receipt.id, receipt.provider, receipt.source, receipt.repo, receipt.connection_id,
               receipt.dropped_reason as reason, receipt.received_at, receipt.received_at::text as cursor_time,
               case when receipt.dropped_reason = 'trigger_filters_rejected' and receipt.provider = 'manual'
                 then receipt.manual_replay_binding->>'triggerId' end as bound_trigger_id,
               case when receipt.dropped_reason = 'trigger_filters_rejected' and receipt.provider = 'manual'
                    and receipt.accepted_routes->1 is null
                 then receipt.accepted_routes->0->>'projectId' end as trigger_project_id
        ${scoped}
        ${position === undefined ? "" : `and (receipt.received_at, receipt.id) ${after ? ">" : "<"} ${boundary}`}
        order by receipt.received_at ${order}, receipt.id ${order}
        limit $${params.length + (position === undefined ? 1 : 3)}
      ) page
      order by page.received_at ${order}, page.id ${order}`,
    position === undefined
      ? [...params, limit + 1]
      : [...params, position.key.createdAt, position.key.id, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  if (after) rows.reverse();
  const first = rows[0];
  const last = rows.at(-1);
  const keyOf = (row: NonNullable<typeof first>) => ({ createdAt: row.cursor_time, id: row.id });
  const adjacent = async (row: NonNullable<typeof first>, comparison: "<" | ">") =>
    (
      await database.query(
        `select 1 ${scoped} and (receipt.received_at, receipt.id) ${comparison} ${boundary}
       order by receipt.received_at ${comparison === "<" ? "desc nulls first" : "asc nulls last"},
                receipt.id ${comparison === "<" ? "desc nulls first" : "asc nulls last"} limit 1`,
        [...params, row.cursor_time, row.id],
      )
    ).rows.length > 0;

  return {
    records: rows.map((row) => ({
      id: row.id,
      provider: droppedEventProvider(row),
      source: row.source,
      reason: displayedDropReason(row.reason),
      triggerId: row.trigger_id,
      workspaceOrRepo: row.workspace,
      receivedAt: row.received_at.toISOString(),
    })),
    older: last !== undefined && (after ? await adjacent(last, "<") : hasMore) ? keyOf(last) : null,
    newer:
      first !== undefined &&
      (after ? hasMore : position !== undefined && (await adjacent(first, ">")))
        ? keyOf(first)
        : null,
  };
}

export function groupDropCounts(
  rows: Iterable<{ provider: Provider; reason: string; count: number }>,
): DroppedProviderEventCount[] {
  const groups = new Map<string, DroppedProviderEventCount>();
  for (const { provider, reason: value, count } of rows) {
    const displayed = displayedDropReason(value);
    if (displayed === GITHUB_LIFECYCLE_RECEIPT) continue;
    const reason = dropReasonGroup(displayed);
    const key = `${reason}:${provider}`;
    const current = groups.get(key);
    if (current === undefined) groups.set(key, { provider, reason, count });
    else current.count += count;
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.reason.localeCompare(b.reason) || b.count - a.count || a.provider.localeCompare(b.provider),
  );
}

export async function countRecentDroppedEvents(
  database: QueryHandle,
  organizationId: string,
  since: Date,
): Promise<DroppedProviderEventCount[]> {
  const { rows } = await database.query<{ provider: Provider; reason: string; count: number }>(
    `select provider, dropped_reason as reason, count(*)::int as count
     from (
       select provider, dropped_reason from provider_event_receipts
       where organization_id = $1 and received_at >= $2 and dropped_reason is not null and dropped_reason <> $4
       order by received_at desc nulls first, id desc nulls first limit $3
     ) recent
     group by provider, dropped_reason`,
    [organizationId, since, RECENT_DROP_COUNT_LIMIT, GITHUB_LIFECYCLE_RECEIPT],
  );
  return groupDropCounts(rows);
}
