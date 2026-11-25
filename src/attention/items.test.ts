import type { TriggerMatchActivity } from "../db/types.js";
import { expect, it } from "vitest";
import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import { attentionSnapshotSchema } from "./contract.js";
import { deriveAttention } from "./items.js";

const now = new Date("2026-01-08T12:00:00Z");
const empty = {
  organizationSlug: "team",
  now,
  connections: { github: [], slack: [], linear: [], discord: [{ guildName: "chat" }] },
  daemons: [],
  triggers: [],
  triggerMatches: [],
  dropped: [],
  failedRuns: { count: 0, newest: null },
  sessions: null,
} satisfies Parameters<typeof deriveAttention>[0];

it("groups authorization by provider in Home order", () => {
  const items = deriveAttention({
    ...empty,
    connections: {
      ...empty.connections,
      github: [
        { accountLogin: "Healthy", status: "active" },
        { accountLogin: "One", status: "suspended" },
        { accountLogin: "Two", status: "suspended" },
      ],
      slack: [
        { teamName: "Healthy", scopes: [...SLACK_REQUIRED_BOT_SCOPES] },
        { teamName: "Missing a scope", scopes: SLACK_REQUIRED_BOT_SCOPES.slice(1) },
      ],
      linear: [
        {
          linearOrganizationName: "Linear tenant",
          scopes: [],
          refreshToken: null,
          accessTokenExpiresAt: null,
        },
      ],
    },
  });
  expect(items.map(({ id }) => id)).toEqual([
    "connection:github",
    "connection:slack",
    "connection:linear",
  ]);
  expect(items[0]?.detail).toBe("Review authorization for One, Two in Connections.");
});

const daemon = { slug: "workstation", status: "active", presence: "offline", permissions: [] };

it("only warns about active daemons that would be used", () => {
  expect(deriveAttention({ ...empty, daemons: [daemon], triggers: [{ enabled: false }] })).toEqual(
    [],
  );
  const triggers = [{ enabled: true }];
  expect(
    deriveAttention({ ...empty, triggers, daemons: [{ ...daemon, status: "revoked" }] }),
  ).toEqual([]);
  expect(
    deriveAttention({
      ...empty,
      triggers,
      daemons: [{ ...daemon, presence: "connected", permissions: ["hub.execute"] }],
    }),
  ).toEqual([]);
  expect(deriveAttention({ ...empty, triggers, daemons: [daemon] })[0]?.title).toBe(
    "No daemon may run agents",
  );
});

it("lists actionable sources in fixed order with Home copy and tenant links", () => {
  const items = deriveAttention({
    ...empty,
    connections: { ...empty.connections, github: [{ accountLogin: "One", status: "suspended" }] },
    daemons: [{ ...daemon, permissions: ["hub.execute"] }],
    dropped: [
      { count: 1, provider: "linear", reason: "unsupported_event" },
      { count: 2499, provider: "github", reason: "routing" },
    ],
    failedRuns: {
      count: 2,
      newest: { triggerName: "Build", receivedAt: new Date("2026-01-08T11:58:00Z") },
    },
    sessions: {
      hasActiveProfile: true,
      waiting: { count: 2, sessions: [{ name: "Newest session" }] },
    },
  });
  expect(attentionSnapshotSchema.parse({ items, generatedAt: now.toISOString() }).items).toEqual(
    items,
  );
  expect(items.map(({ id }) => id)).toEqual([
    "connection:github",
    "daemons",
    "runs:failed",
    "sessions:permission",
    "dropped",
  ]);
  expect(items.every(({ action }) => action.to.startsWith("/o/team/"))).toBe(true);
  expect(items[1]?.detail).toBe(
    "workstation is not connected. Reconnect a daemon to run work configured for it.",
  );
  expect(items[2]).toMatchObject({
    title: "2 runs failed",
    detail: "Newest: Build, 2 minutes ago.",
    dismiss: { label: "Mark seen" },
  });
  expect(items[3]).toMatchObject({
    title: "2 sessions wait for permission",
    detail: "Newest session",
  });
  expect(items[4]).toEqual({
    id: "dropped",
    source: "dropped",
    quiet: true,
    title: "At least 2,500 events dropped in the last 7 days",
    detail: "2,499 missing route or trigger, 1 unsupported event.",
    action: {
      label: "View dropped events",
      to: "/o/team/activity",
      search: { view: "dropped", range: "7d" },
    },
  });
});

it("reports a single dropped event as quiet information", () => {
  const items = deriveAttention({
    ...empty,
    dropped: [{ count: 1, provider: "github", reason: "routing" }],
  });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ quiet: true, title: "1 event dropped in the last 7 days" });
});

const matching = {
  id: "deploy",
  name: "Deploy",
  previousMatches: 1,
  recentMatches: 0,
  providers: [
    { provider: "github", recentEvents: 0 },
    { provider: "slack", recentEvents: 1 },
  ],
} satisfies TriggerMatchActivity;

it("warns once for a trigger that stopped matching while one of its providers still sent events", () => {
  expect(deriveAttention({ ...empty, triggerMatches: [matching] })).toEqual([
    {
      id: "trigger:deploy",
      source: "trigger",
      title: "Deploy stopped matching events",
      detail:
        "Matched 1 event in the previous 7 days and none in the last 7 days, while 1 Slack event still arrived.",
      action: { label: "Open trigger", to: "/o/team/triggers/deploy" },
    },
  ]);
});

it("ignores triggers that never matched, still match, or stopped receiving events", () => {
  expect(
    deriveAttention({
      ...empty,
      triggerMatches: [
        { ...matching, previousMatches: 0 },
        { ...matching, recentMatches: 1 },
        { ...matching, providers: [{ provider: "github", recentEvents: 0 }] },
      ],
    }),
  ).toEqual([]);
});

it("caps stopped triggers at five, ordered by prior matches then name", () => {
  const triggerMatches = ["a", "f", "e", "d", "c", "b", "g"].map((name) => ({
    recentMatches: 0,
    providers: matching.providers,
    id: name,
    name,
    previousMatches: name === "g" ? 12 : 1,
  }));
  expect(deriveAttention({ ...empty, triggerMatches }).map(({ id }) => id)).toEqual([
    "trigger:g",
    "trigger:a",
    "trigger:b",
    "trigger:c",
    "trigger:d",
  ]);
});
