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
    "dropped:routing",
    "dropped:unsupported_event",
    "runs:failed",
    "sessions:permission",
  ]);
  expect(items.every(({ action }) => action.to.startsWith("/o/team/"))).toBe(true);
  expect(items[1]?.detail).toBe(
    "workstation is not connected. Reconnect a daemon to run work configured for it.",
  );
  expect(items[3]?.detail).toBe("At least 1 event in the last 7 days (1 from Linear).");
  expect(items[4]).toMatchObject({
    title: "2 runs failed",
    detail: "Newest: Build, 2 minutes ago.",
    dismiss: { label: "Mark seen" },
  });
  expect(items[5]).toMatchObject({
    title: "2 sessions wait for permission",
    detail: "Newest session",
  });
});
