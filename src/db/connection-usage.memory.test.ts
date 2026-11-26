import { expect, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";

const organizationId = "connections-org";

it("lists each provider's connections by name then id, as Postgres does", async () => {
  const base = { organizationId, providerApplicationId: null };
  const database = createMemoryDatabase({
    organizationIds: [organizationId, "other"],
    githubConnections: [
      {
        ...base,
        id: "g3",
        slug: "g3",
        installationId: 3,
        accountId: "3",
        accountLogin: "zeta",
        accountType: "Organization",
        status: "active",
      },
      {
        ...base,
        id: "g2",
        slug: "g2",
        installationId: 2,
        accountId: "2",
        accountLogin: "alpha",
        accountType: "Organization",
        status: "active",
      },
      {
        ...base,
        id: "g1",
        slug: "g1",
        installationId: 1,
        accountId: "1",
        accountLogin: "alpha",
        accountType: "Organization",
        status: "active",
      },
      {
        ...base,
        organizationId: "other",
        id: "g0",
        slug: "g0",
        installationId: 9,
        accountId: "9",
        accountLogin: "aaa",
        accountType: "Organization",
        status: "active",
      },
    ],
    slackConnections: [
      {
        ...base,
        id: "s2",
        slug: "s2",
        teamId: "T2",
        teamName: "Team B",
        botUserId: "b",
        botAccessToken: "t",
        scopes: [],
      },
      {
        ...base,
        id: "s1",
        slug: "s1",
        teamId: "T1",
        teamName: "Team A",
        botUserId: "b",
        botAccessToken: "t",
        scopes: [],
      },
    ],
    linearConnections: [
      {
        ...base,
        id: "l2",
        slug: "l2",
        linearOrganizationId: "L2",
        linearOrganizationName: "Workspace B",
        appUserId: "a",
        accessToken: "t",
        refreshToken: null,
        accessTokenExpiresAt: null,
        scopes: [],
      },
      {
        ...base,
        id: "l1",
        slug: "l1",
        linearOrganizationId: "L1",
        linearOrganizationName: "Workspace A",
        appUserId: "a",
        accessToken: "t",
        refreshToken: null,
        accessTokenExpiresAt: null,
        scopes: [],
      },
    ],
  });
  const usage = await database.organizationConnectionUsage(organizationId);
  expect(usage.github.map(({ id }) => id)).toEqual(["g1", "g2", "g3"]);
  expect(usage.slack.map(({ teamName }) => teamName)).toEqual(["Team A", "Team B"]);
  expect(usage.linear.map(({ linearOrganizationName }) => linearOrganizationName)).toEqual([
    "Workspace A",
    "Workspace B",
  ]);
  expect(usage.discord).toEqual([]);
});
