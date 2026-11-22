import type { Database } from "../db/types.js";

// Leave time to open Activity before a reported drop can age out of its seven-day view.
const CONNECTION_DROP_WINDOW_MS = 7 * 86_400_000 - 10 * 60_000;

export async function readConnectionDrops(database: Database, organizationId: string) {
  const since = new Date(Date.now() - CONNECTION_DROP_WINDOW_MS);
  const [linear, github, slack, discord] = await Promise.all([
    database.readDroppedEventPresence(organizationId, "linear", since),
    database.readDroppedEventPresence(organizationId, "github", since),
    database.readDroppedEventPresence(organizationId, "slack", since),
    database.readDroppedEventPresence(organizationId, "discord", since),
  ]);
  return { droppedConnectionEvents: { linear, github, slack, discord } };
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
