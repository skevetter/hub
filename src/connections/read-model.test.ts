import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
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
  it("reads the last seven days for each provider in the resolved organization", async () => {
    const db = database();
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const read = vi.spyOn(db, "readDroppedEventPresence");

    await new ProjectDashboard(db, auth).organizationSnapshot(request, {
      organizationSlug: "acme",
    });

    expect(read).toHaveBeenCalledTimes(4);
    for (const provider of ["linear", "github", "slack", "discord"]) {
      expect(read).toHaveBeenCalledWith("org-1", provider, new Date("2026-11-14T12:00:00Z"));
    }
  });

  it("preserves each provider's presence or uncertainty in the snapshot", async () => {
    const db = database();
    vi.spyOn(db, "readDroppedEventPresence").mockImplementation(
      async (_organizationId, provider) => {
        switch (provider) {
          case "github":
            return "some";
          case "slack":
            return "unknown";
          default:
            return "none";
        }
      },
    );

    const snapshot = await new ProjectDashboard(db, auth).organizationSnapshot(request, {
      organizationSlug: "acme",
    });

    expect(snapshot.droppedConnectionEvents).toEqual({
      linear: "none",
      github: "some",
      slack: "unknown",
      discord: "none",
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
