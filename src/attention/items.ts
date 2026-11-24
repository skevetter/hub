import { RECENT_DROP_COUNT_LIMIT } from "../db/dropped-events.js";
import type {
  DroppedProviderEventCount,
  FailedRunSummary,
  OrganizationConnectionUsage,
  TriggerMatchActivity,
  WaitingSessionSummary,
} from "../db/types.js";
import { linearConnectionRequiresReauthorization } from "../providers/linear/client.js";
import { hasRequiredSlackScopes } from "../providers/slack/client.js";
import { DROP_REASON_GROUPS, type DropReasonGroup } from "../triggers/drop-reason.js";
import { LIST_PROVIDER_LABELS } from "../triggers/list-providers.js";
import { FAILED_RUN_FILTER } from "../triggers/run-status.js";
import type { AttentionItem } from "./contract.js";

interface Connections {
  github: readonly Pick<OrganizationConnectionUsage["github"][number], "accountLogin" | "status">[];
  slack: readonly Pick<OrganizationConnectionUsage["slack"][number], "teamName" | "scopes">[];
  linear: readonly Pick<
    OrganizationConnectionUsage["linear"][number],
    "linearOrganizationName" | "scopes" | "refreshToken" | "accessTokenExpiresAt"
  >[];
  discord: readonly { guildName: string }[];
}

interface AttentionInputs {
  organizationSlug: string;
  now: Date;
  connections: Connections;
  daemons: readonly {
    slug: string;
    status: string;
    presence: string;
    permissions: readonly string[];
  }[];
  triggers: readonly { enabled: boolean }[];
  triggerMatches: readonly TriggerMatchActivity[];
  dropped: readonly DroppedProviderEventCount[];
  failedRuns: FailedRunSummary;
  sessions: { hasActiveProfile: boolean; waiting: WaitingSessionSummary } | null;
}

export const ATTENTION_WINDOW_DAYS = 7;
const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function deriveAttention(input: AttentionInputs): AttentionItem[] {
  const base = `/o/${input.organizationSlug}`;
  return [
    ...connectionItems(input, base),
    ...daemonItems(input, base),
    ...droppedItems(input.dropped, base),
    ...runItems(input, base),
    ...stoppedTriggerItems(input.triggerMatches, base),
    ...sessionItems(input.sessions, base),
  ];
}

function connectionItems({ connections, now }: AttentionInputs, base: string): AttentionItem[] {
  const labels = {
    github: connections.github
      .filter(({ status }) => status === "suspended")
      .map(({ accountLogin }) => accountLogin),
    slack: connections.slack
      .filter(({ scopes }) => !hasRequiredSlackScopes(scopes))
      .map(({ teamName }) => teamName),
    linear: connections.linear
      .filter((connection) => linearConnectionRequiresReauthorization(connection, now))
      .map(({ linearOrganizationName }) => linearOrganizationName),
  };
  return (["github", "slack", "linear"] as const).flatMap((provider): AttentionItem[] =>
    labels[provider].length === 0
      ? []
      : [
          {
            id: `connection:${provider}`,
            source: "connection",
            title: `${LIST_PROVIDER_LABELS[provider]} needs authorization`,
            detail: `Review authorization for ${labels[provider].join(", ")} in Connections.`,
            action: { label: "Open connections", to: `${base}/connections` },
          },
        ],
  );
}

function daemonItems(
  { daemons, triggers, sessions }: AttentionInputs,
  base: string,
): AttentionItem[] {
  const waiting = triggers.some(({ enabled }) => enabled) || sessions?.hasActiveProfile === true;
  const active = daemons.filter(({ status }) => status === "active");
  if (!waiting || active.length === 0) return [];
  const able = active.filter(({ permissions }) => permissions.includes("hub.execute"));
  if (able.some(({ presence }) => presence === "connected")) return [];
  return [
    {
      id: "daemons",
      source: "daemons",
      title:
        able.length === 0
          ? "No daemon may run agents"
          : "No daemon that may run agents is connected.",
      detail:
        able.length === 0
          ? "No enrolled daemon may run agents yet. Triggers and sessions cannot start an agent until one is allowed to run Hub automations."
          : `${able.map(({ slug }) => slug).join(", ")} ${able.length === 1 ? "is" : "are"} not connected. Reconnect a daemon to run work configured for it.`,
      action: { label: "View daemons", to: `${base}/daemons` },
    },
  ];
}

const DROP_NOTICE_TITLES: Record<DropReasonGroup, string> = {
  routing: "Events arrived without a route or matching trigger",
  trigger_filters_rejected: "Trigger filters rejected events",
  configuration_unavailable: "Events arrived while configuration was unavailable",
  unsupported_event: "Linear sent unsupported events",
  other: "Hub dropped events for other reasons",
};

function droppedItems(dropped: AttentionInputs["dropped"], base: string): AttentionItem[] {
  const capped = dropped.reduce((total, { count }) => total + count, 0) >= RECENT_DROP_COUNT_LIMIT;
  return DROP_REASON_GROUPS.flatMap((reason): AttentionItem[] => {
    const group = dropped.filter((entry) => entry.reason === reason);
    if (group.length === 0) return [];
    const total = group.reduce((sum, { count }) => sum + count, 0);
    const sources = group
      .map(({ provider, count }) => `${String(count)} from ${LIST_PROVIDER_LABELS[provider]}`)
      .join(", ");
    return [
      {
        id: `dropped:${reason}`,
        source: "dropped",
        title: DROP_NOTICE_TITLES[reason],
        detail: `${capped ? "At least " : ""}${String(total)} ${total === 1 ? "event" : "events"} in the last ${String(ATTENTION_WINDOW_DAYS)} days (${sources}).`,
        action: {
          label: "View dropped events",
          to: `${base}/activity`,
          search: { view: "dropped", reason, range: "7d" },
        },
      },
    ];
  });
}

function stoppedTriggerItems(triggers: AttentionInputs["triggerMatches"], base: string) {
  const items = triggers
    .filter(({ previousMatches, recentMatches }) => previousMatches > 0 && recentMatches === 0)
    .sort((a, b) => b.previousMatches - a.previousMatches || a.name.localeCompare(b.name))
    .flatMap((trigger) => stoppedTriggerItem(trigger, base) ?? []);
  // Limit the menu to the five strongest signals.
  return items.slice(0, 5);
}

function stoppedTriggerItem(
  { id, name, previousMatches, providers }: TriggerMatchActivity,
  base: string,
): AttentionItem | undefined {
  const source = providers.find(({ recentEvents }) => recentEvents > 0);
  if (source === undefined) return undefined;
  const { provider, recentEvents } = source;
  return {
    id: `trigger:${id}`,
    source: "trigger",
    title: `${name} stopped matching events`,
    detail: `Matched ${eventCount(previousMatches)} in the previous 7 days and none in the last 7 days, while ${recentEvents.toLocaleString("en")} ${LIST_PROVIDER_LABELS[provider]} ${recentEvents === 1 ? "event" : "events"} still arrived.`,
    action: { label: "Open trigger", to: `${base}/triggers/${id}` },
  };
}

function eventCount(count: number): string {
  return `${count.toLocaleString("en")} ${count === 1 ? "event" : "events"}`;
}

function relativeLabel(time: Date, now: Date): string {
  const seconds = (time.getTime() - now.getTime()) / 1000;
  const units = [
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ] as const;
  if (Math.abs(seconds) < 45) return "just now";
  const [unit, size] = units.find(([, threshold]) => Math.abs(seconds) >= threshold) ?? [
    "minute",
    60,
  ];
  return RELATIVE_TIME.format(Math.round(seconds / size), unit);
}

function runItems(
  { failedRuns: { count, newest }, now }: AttentionInputs,
  base: string,
): AttentionItem[] {
  if (newest === null || count === 0) return [];
  return [
    {
      id: "runs:failed",
      source: "runs",
      title: `${String(count)} ${count === 1 ? "run" : "runs"} failed`,
      detail: `Newest: ${newest.triggerName}, ${relativeLabel(newest.receivedAt, now)}.`,
      action: {
        label: "Review runs",
        to: `${base}/activity`,
        search: { status: FAILED_RUN_FILTER, range: "7d" },
      },
      dismiss: { label: "Mark seen" },
    },
  ];
}

function sessionItems(sessions: AttentionInputs["sessions"], base: string): AttentionItem[] {
  const newest = sessions?.waiting.sessions[0];
  if (sessions === null || newest === undefined) return [];
  const { count } = sessions.waiting;
  return [
    {
      id: "sessions:permission",
      source: "sessions",
      title: `${String(count)} ${count === 1 ? "session waits" : "sessions wait"} for permission`,
      detail: newest.name,
      action: { label: "Open sessions", to: `${base}/sessions` },
    },
  ];
}
