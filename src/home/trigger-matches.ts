import { z } from "zod";
import type { QueryHandle, QueryRow } from "../db/runtime/index.js";
import { hasTriggerEvent, triggerProviderEvent } from "../db/trigger-list.js";
import type { TriggerMatchActivity, TriggerMatchWindow } from "../db/types.js";

export const PROVIDERS = ["github", "slack", "discord", "linear", "github_notification"] as const;
export const TRIGGER_MATCH_PROVIDERS: ReadonlySet<string> = new Set(PROVIDERS);

/** Receipts the filters turned away still reached the trigger's event, so they count as matches. */
export const FILTER_DROP_CODE = "trigger_filters_rejected";

export function triggerMatchProviders(configuration: unknown) {
  const notification = triggerProviderEvent("github_notification");
  return PROVIDERS.filter((provider) => {
    const event = triggerProviderEvent(provider);
    return hasTriggerEvent(configuration, (source) =>
      event.endsWith(".") ? source.startsWith(event) && source !== notification : source === event,
    );
  });
}

type MatchCounts = Pick<TriggerMatchActivity, "previousMatches" | "recentMatches">;
interface Trigger {
  id: string;
  name: string;
  configuration: unknown;
}

export function triggerMatchActivity(
  trigger: Trigger,
  counts: MatchCounts,
  receipts: ReadonlyMap<string, number>,
): TriggerMatchActivity[] {
  const providers = triggerMatchProviders(trigger.configuration).map((provider) => ({
    provider,
    recentEvents: receipts.get(provider) ?? 0,
  }));
  return providers.length === 0
    ? []
    : [{ id: trigger.id, name: trigger.name, ...counts, providers }];
}

/**
 * Matched events in the previous week, none in the last, while an app the trigger listens to
 * still sent events. A quiet app is not the trigger's fault, so it is not flagged.
 */
export function stoppedMatching(activity: TriggerMatchActivity): boolean {
  return (
    activity.previousMatches > 0 &&
    activity.recentMatches === 0 &&
    activity.providers.some(({ recentEvents }) => recentEvents > 0)
  );
}

/** Most earlier matches first, then by name, so the figure always names the same trigger. */
export function stoppedTriggers(activity: readonly TriggerMatchActivity[]) {
  return activity
    .filter(stoppedMatching)
    .sort((a, b) => b.previousMatches - a.previousMatches || a.name.localeCompare(b.name))
    .map(({ id, name, previousMatches }) => ({ id, name, previousMatches }));
}

export interface MatchEvidence {
  provider: string;
  receivedAt: Date;
  droppedReason: string | null;
  /** Projects of the runs this receipt started. */
  runProjects: readonly string[];
  /** Projects the receipt was routed to before any filter looked at it. */
  routedProjects: readonly string[];
}

/** One receipt matches a trigger's project when it started a run there or its filters dropped it. */
export function matchedProjects(receipt: MatchEvidence): ReadonlySet<string> {
  return new Set([
    ...receipt.runProjects,
    ...(receipt.droppedReason === FILTER_DROP_CODE ? receipt.routedProjects : []),
  ]);
}

export function countMatchesByProject(
  receipts: Iterable<MatchEvidence>,
  { previousStart, recentStart, now }: TriggerMatchWindow,
): Map<string, MatchCounts> {
  const counts = new Map<string, MatchCounts>();
  for (const receipt of receipts) {
    const { provider, receivedAt } = receipt;
    if (!TRIGGER_MATCH_PROVIDERS.has(provider) || receivedAt < previousStart || receivedAt > now)
      continue;
    for (const project of matchedProjects(receipt)) {
      const entry = counts.get(project) ?? { previousMatches: 0, recentMatches: 0 };
      if (receivedAt < recentStart) entry.previousMatches += 1;
      else entry.recentMatches += 1;
      counts.set(project, entry);
    }
  }
  return counts;
}

// A trigger keeps its dedicated runtime project across revisions and renames. A receipt matches
// a project when it started a run there, or when its filters dropped it after routing it there;
// the union counts each receipt once per project; `offset 0` keeps the planner from flattening the
// run lookup into a join that scans every run. The window's provider receipt totals ride on
// every trigger row as one object, so a snapshot reads both in one statement. Routes are cleared
// when a payload expires, so a filter-dropped match older than payload retention is not counted.
export const TRIGGER_MATCHES_SQL = `with routed as (
    select receipt.id, receipt.received_at, run.project_id::text as project_id
    from provider_event_receipts receipt
    join lateral (
      select project_id from trigger_runs
      where organization_id = $1 and provider_event_receipt_id = receipt.id
      offset 0
    ) run on true
    where receipt.organization_id = $1 and receipt.received_at between $2 and $4
      and receipt.provider = any($5::text[])
    union
    select receipt.id, receipt.received_at, route.value->>'projectId'
    from provider_event_receipts receipt
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(receipt.accepted_routes) = 'array'
        then receipt.accepted_routes else '[]'::jsonb end
    ) route
    where receipt.organization_id = $1 and receipt.received_at between $2 and $4
      and receipt.provider = any($5::text[])
      and receipt.dropped_reason = '${FILTER_DROP_CODE}'
  ), matches as (
    select project_id,
      count(*) filter (where received_at < $3)::int as "previousMatches",
      count(*) filter (where received_at >= $3)::int as "recentMatches"
    from routed
    group by project_id
  ), events as (
    select provider, count(*)::int as count
    from provider_event_receipts
    where organization_id = $1 and received_at between $3 and $4 and provider = any($5::text[])
    group by provider
  )
  select trigger.id, trigger.name, revision.normalized_configuration as configuration,
    coalesce(matches."previousMatches", 0) as "previousMatches",
    coalesce(matches."recentMatches", 0) as "recentMatches",
    (select coalesce(jsonb_object_agg(provider, count), '{}'::jsonb) from events) as receipts
  from organization_triggers trigger
  join organization_trigger_revisions revision on revision.id = trigger.active_revision_id
    and revision.trigger_id = trigger.id and revision.organization_id = $1
  left join matches on matches.project_id = trigger.runtime_project_id::text
  where trigger.organization_id = $1 and trigger.enabled`;

export async function listTriggerMatchActivity(
  database: QueryHandle,
  organizationId: string,
  { previousStart, recentStart, now }: TriggerMatchWindow,
): Promise<TriggerMatchActivity[]> {
  const { rows } = await database.query<Trigger & MatchCounts & { receipts: unknown } & QueryRow>(
    TRIGGER_MATCHES_SQL,
    [organizationId, previousStart, recentStart, now, PROVIDERS],
  );
  return rows.flatMap(({ previousMatches, recentMatches, receipts, ...trigger }) =>
    triggerMatchActivity(trigger, { previousMatches, recentMatches }, receiptTotals(receipts)),
  );
}

function receiptTotals(receipts: unknown): ReadonlyMap<string, number> {
  return new Map(Object.entries(z.record(z.string(), z.number()).catch({}).parse(receipts)));
}
