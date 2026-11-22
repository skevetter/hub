import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { RECENT_DROP_COUNT_LIMIT } from "../db/dropped-events.js";
import { createMemoryDatabase } from "../db/memory.js";
import { ProjectDashboard } from "../projects/dashboard.js";

const now = new Date("2026-11-21T12:00:00Z");
const request = new Request("https://hub.test/o/acme/connections");

const auth: AuthServer = {
  handle: () => Promise.resolve(new Response()),
  resources: () => Promise.reject(new Error("unused")),
  resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
  resolveAccount: () =>
    Promise.resolve({
      account: { id: "user-1", email: "owner@example.com", name: "Owner" },
      session: { id: "session-1", activeOrganizationId: "org-1" },
      isInstanceOperator: false,
    }),
  rejectCookieMutation: () => undefined,
  close: () => Promise.resolve(),
};

function database() {
  return createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role: "owner",
      },
    ],
  });
}

afterEach(() => vi.restoreAllMocks());

describe("organization connection snapshot", () => {
  it("counts dropped events across reasons by card provider for the last seven days", async () => {
    const db = database();
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const count = vi.spyOn(db, "countRecentDroppedEvents").mockResolvedValue([
      { provider: "slack", reason: "routing", count: 2 },
      { provider: "slack", reason: "trigger_filters_rejected", count: 3 },
      { provider: "github", reason: "routing", count: 1 },
      { provider: "manual", reason: "routing", count: 9 },
    ]);

    const snapshot = await new ProjectDashboard(db, auth).organizationSnapshot(request, {
      organizationSlug: "acme",
    });

    expect(count).toHaveBeenCalledExactlyOnceWith("org-1", new Date("2026-11-14T12:00:00Z"));
    expect(snapshot).toMatchObject({
      droppedConnectionEvents: { linear: 0, github: 1, slack: 5, discord: 0 },
      droppedConnectionEventsCapped: false,
    });
  });

  it("marks counts as lower bounds when the shared receipt limit is reached", async () => {
    const db = database();
    vi.spyOn(db, "countRecentDroppedEvents").mockResolvedValue([
      { provider: "discord", reason: "routing", count: 1 },
      { provider: "manual", reason: "routing", count: RECENT_DROP_COUNT_LIMIT - 1 },
    ]);

    const snapshot = await new ProjectDashboard(db, auth).organizationSnapshot(request, {
      organizationSlug: "acme",
    });

    expect(snapshot).toMatchObject({
      droppedConnectionEvents: { linear: 0, github: 0, slack: 0, discord: 1 },
      droppedConnectionEventsCapped: true,
    });
  });

  it("describes stored grants and omits unfamiliar scopes and credentials", async () => {
    const db = database();
    vi.spyOn(db, "organizationConnectionUsage").mockResolvedValue({
      github: [],
      discord: [],
      slack: [
        {
          id: "slack-1",
          organizationId: "org-1",
          slug: "acme-slack",
          teamId: "T-ACME",
          teamName: "Acme Slack",
          botUserId: "UBOT",
          botAccessToken: "slack-secret",
          scopes: ["chat:write", "app_mentions:read", "future:scope", "chat:write"],
          providerApplicationId: null,
        },
      ],
      linear: [
        {
          id: "linear-1",
          organizationId: "org-1",
          slug: "acme-linear",
          providerApplicationId: null,
          linearOrganizationId: "W-ACME",
          linearOrganizationName: "Acme Linear",
          appUserId: "LINEAR-BOT",
          accessToken: "linear-secret",
          refreshToken: "refresh-secret",
          accessTokenExpiresAt: null,
          scopes: ["read", "comments:create", "app:assignable", "app:mentionable", "write"],
        },
        {
          id: "linear-2",
          organizationId: "org-1",
          slug: "other-linear",
          providerApplicationId: null,
          linearOrganizationId: "W-OTHER",
          linearOrganizationName: "Other Linear",
          appUserId: "LINEAR-BOT",
          accessToken: "linear-secret",
          refreshToken: null,
          accessTokenExpiresAt: null,
          scopes: ["future:scope"],
        },
      ],
    });

    const { connections } = await new ProjectDashboard(db, auth).organizationSnapshot(request, {
      organizationSlug: "acme",
    });

    expect(connections).toMatchObject({
      slack: [{ grantedAccess: ["read app mentions", "post messages"] }],
      linear: [
        {
          grantedAccess: [
            "read workspace data",
            "post comments",
            "be assigned to issues",
            "be mentioned",
            "write workspace data",
          ],
        },
        { grantedAccess: [] },
      ],
    });
    expect(JSON.stringify(connections)).not.toMatch(/secret|future:scope|chat:write/u);
  });
});
