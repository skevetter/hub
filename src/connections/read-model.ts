import { RECENT_DROP_COUNT_LIMIT } from "../db/dropped-events.js";
import type { Database, DroppedProviderEventCount } from "../db/types.js";

const WEEK_MS = 7 * 86_400_000;

export async function readConnectionDrops(database: Database, organizationId: string) {
  const groups = await database.countRecentDroppedEvents(
    organizationId,
    new Date(Date.now() - WEEK_MS),
  );
  const counts = new Map<DroppedProviderEventCount["provider"], number>();
  let total = 0;
  for (const { provider, count } of groups) {
    counts.set(provider, (counts.get(provider) ?? 0) + count);
    total += count;
  }
  return {
    droppedConnectionEvents: {
      linear: counts.get("linear") ?? 0,
      github: counts.get("github") ?? 0,
      slack: counts.get("slack") ?? 0,
      discord: counts.get("discord") ?? 0,
    },
    droppedConnectionEventsCapped: total >= RECENT_DROP_COUNT_LIMIT,
  };
}

const ACCESS_LABELS = {
  linear: [
    ["read", "read workspace data"],
    ["comments:create", "post comments"],
    ["app:assignable", "be assigned to issues"],
    ["app:mentionable", "be mentioned"],
    ["write", "write workspace data"],
  ],
  slack: [
    ["app_mentions:read", "read app mentions"],
    ["channels:history", "read public channel history"],
    ["chat:write", "post messages"],
    ["files:read", "read shared files"],
    ["groups:history", "read private channel history"],
    ["reactions:write", "add reactions"],
    ["users:read", "read member profiles"],
  ],
} as const;

export function grantedConnectionAccess(
  provider: keyof typeof ACCESS_LABELS,
  scopes: readonly string[],
): string[] {
  return ACCESS_LABELS[provider]
    .filter(([scope]) => scopes.includes(scope))
    .map(([, label]) => label);
}
