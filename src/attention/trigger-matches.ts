import type { QueryHandle, QueryRow } from "../db/runtime/index.js";
import { hasTriggerEvent, triggerProviderEvent } from "../db/trigger-list.js";
import type {
  TriggerMatchActivity,
  TriggerMatchProvider,
  TriggerMatchWindow,
} from "../db/types.js";

export const PROVIDERS = ["github", "slack", "discord", "linear", "github_notification"] as const;
export const TRIGGER_MATCH_PROVIDERS: ReadonlySet<string> = new Set(PROVIDERS);

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

// A trigger keeps its dedicated runtime project across revisions and renames.
export const TRIGGER_MATCHES_SQL = `with matches as (
    select run.project_id,
      count(*) filter (where receipt.received_at < $3)::int as "previousMatches",
      count(*) filter (where receipt.received_at >= $3)::int as "recentMatches"
    from provider_event_receipts receipt
    join lateral (
      select project_id from trigger_runs
      where organization_id = $1 and provider_event_receipt_id = receipt.id
      offset 0
    ) run on true
    where receipt.organization_id = $1 and receipt.received_at between $2 and $4
      and receipt.provider = any($5::text[])
    group by run.project_id
  )
  select trigger.id, trigger.name, revision.normalized_configuration as configuration,
    coalesce(matches."previousMatches", 0) as "previousMatches",
    coalesce(matches."recentMatches", 0) as "recentMatches"
  from organization_triggers trigger
  join organization_trigger_revisions revision on revision.id = trigger.active_revision_id
    and revision.trigger_id = trigger.id and revision.organization_id = $1
  left join matches on matches.project_id = trigger.runtime_project_id
  where trigger.organization_id = $1 and trigger.enabled`;

export const RECENT_PROVIDER_EVENTS_SQL = `select provider, count(*)::int as count
  from provider_event_receipts
  where organization_id = $1 and received_at between $2 and $3 and provider = any($4::text[])
  group by provider`;

export async function listTriggerMatchActivity(
  database: QueryHandle,
  organizationId: string,
  { previousStart, recentStart, now }: TriggerMatchWindow,
): Promise<TriggerMatchActivity[]> {
  const [triggers, events] = await Promise.all([
    database.query<Trigger & MatchCounts & QueryRow>(TRIGGER_MATCHES_SQL, [
      organizationId,
      previousStart,
      recentStart,
      now,
      PROVIDERS,
    ]),
    database.query<{ provider: TriggerMatchProvider; count: number }>(RECENT_PROVIDER_EVENTS_SQL, [
      organizationId,
      recentStart,
      now,
      PROVIDERS,
    ]),
  ]);
  const receipts = new Map(events.rows.map(({ provider, count }) => [provider, count]));
  return triggers.rows.flatMap(({ previousMatches, recentMatches, ...trigger }) =>
    triggerMatchActivity(trigger, { previousMatches, recentMatches }, receipts),
  );
}
