import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as org,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";

let pg: TimelinePostgresHarness;
const other = "usage-other";
const expiresAt = new Date("2026-12-01T10:20:30.123Z");

beforeAll(async () => {
  pg = await createTimelinePostgresHarness();
  await pg.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [other]);
  await seedConnections();
}, 60_000);

afterAll(async () => pg?.close());

async function seedConnections() {
  const { runtime } = pg;
  for (const [organizationId, login, installation, slug] of [
    [org, "zeta", 3, "gh-zeta"],
    [org, "alpha", 1, "gh-alpha"],
    [other, "elsewhere", 2, "gh-elsewhere"],
  ] as const) {
    await runtime.query(
      `insert into github_connections
         (organization_id, installation_id, account_id, account_login, account_type, status, slug)
       values ($1, $2, $3, $4, 'Organization', 'suspended', $5)`,
      [organizationId, installation, `account-${login}`, login, slug],
    );
  }
  for (const [organizationId, guild, slug] of [
    [org, "Guild B", "dc-b"],
    [org, "Guild A", "dc-a"],
    [other, "Guild X", "dc-x"],
  ] as const) {
    await runtime.query(
      `insert into discord_connections (organization_id, guild_id, guild_name, slug)
       values ($1, $2, $3, $4)`,
      [organizationId, `guild-${slug}`, guild, slug],
    );
  }
  for (const [organizationId, team, slug] of [
    [org, "Team B", "sl-b"],
    [org, "Team A", "sl-a"],
    [other, "Team X", "sl-x"],
  ] as const) {
    await runtime.query(
      `insert into slack_connections
         (organization_id, team_id, team_name, bot_user_id, bot_access_token, slug, scopes)
       values ($1, $2, $3, 'bot', 'xoxb-token', $4, '["chat:write","app_mentions:read"]'::jsonb)`,
      [organizationId, `team-${slug}`, team, slug],
    );
  }
  for (const [organizationId, name, slug, expiry] of [
    [org, "Workspace B", "ln-b", null],
    [org, "Workspace A", "ln-a", expiresAt],
    [other, "Workspace X", "ln-x", null],
  ] as const) {
    await runtime.query(
      `insert into linear_connections
         (organization_id, linear_organization_id, slug, linear_organization_name, app_user_id,
          access_token, refresh_token, access_token_expires_at, scopes)
       values ($1, $2, $3, $4, 'app-user', 'lin-token', $5, $6, '["read"]'::jsonb)`,
      [organizationId, `linear-${slug}`, slug, name, expiry === null ? null : "refresh", expiry],
    );
  }
}

describe("organization connection usage", () => {
  it("lists each provider's connections for the organization in the provider's order", async () => {
    const usage = await pg.database.organizationConnectionUsage(org);
    expect(usage.github.map(({ accountLogin }) => accountLogin)).toEqual(["alpha", "zeta"]);
    expect(usage.discord.map(({ guildName }) => guildName)).toEqual(["Guild A", "Guild B"]);
    expect(usage.slack.map(({ teamName }) => teamName)).toEqual(["Team A", "Team B"]);
    expect(usage.linear.map(({ linearOrganizationName }) => linearOrganizationName)).toEqual([
      "Workspace A",
      "Workspace B",
    ]);
  });

  it("maps every column to the record the reads have always returned", async () => {
    const usage = await pg.database.organizationConnectionUsage(org);
    const { id, ...github } = usage.github[0] ?? {};
    expect(typeof id).toBe("string");
    expect(github).toEqual({
      organizationId: org,
      slug: "gh-alpha",
      installationId: 1,
      accountId: "account-alpha",
      accountLogin: "alpha",
      accountType: "Organization",
      status: "suspended",
      providerApplicationId: null,
    });
    expect(usage.discord[0]).toMatchObject({ slug: "dc-a", guildId: "guild-dc-a" });
    expect(usage.slack[0]).toMatchObject({
      slug: "sl-a",
      teamId: "team-sl-a",
      botUserId: "bot",
      botAccessToken: "xoxb-token",
      scopes: ["chat:write", "app_mentions:read"],
    });
    expect(usage.linear[0]).toMatchObject({
      slug: "ln-a",
      appUserId: "app-user",
      accessToken: "lin-token",
      refreshToken: "refresh",
      accessTokenExpiresAt: expiresAt,
      scopes: ["read"],
    });
    expect(usage.linear[1]).toMatchObject({ refreshToken: null, accessTokenExpiresAt: null });
  });

  it("keeps organizations apart and returns nothing for an unknown one", async () => {
    const usage = await pg.database.organizationConnectionUsage(other);
    expect(usage.github.map(({ slug }) => slug)).toEqual(["gh-elsewhere"]);
    expect(usage.slack.map(({ slug }) => slug)).toEqual(["sl-x"]);
    expect(await pg.database.organizationConnectionUsage("absent")).toEqual({
      github: [],
      discord: [],
      slack: [],
      linear: [],
    });
  });
});
