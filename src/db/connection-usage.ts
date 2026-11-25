import { z } from "zod";
import type { QueryHandle } from "./runtime/index.js";
import type { OrganizationConnectionUsage } from "./types.js";

// One statement for the four providers. Each branch numbers its own rows in the order the
// provider's list has always had, so the ordering uses the columns' own collation and types.
export const CONNECTION_USAGE_SQL = `select provider, data from (
    select 'github' as provider, to_jsonb(connection) as data,
      row_number() over (order by connection.account_login, connection.id) as position
    from (
      select id, organization_id, slug, installation_id, account_id, account_login, account_type,
        status, provider_application_id
      from github_connections where organization_id = $1
    ) connection
    union all
    select 'discord', to_jsonb(connection),
      row_number() over (order by connection.guild_name, connection.id)
    from (
      select id, organization_id, slug, guild_id, guild_name, provider_application_id
      from discord_connections where organization_id = $1
    ) connection
    union all
    select 'slack', to_jsonb(connection),
      row_number() over (order by connection.team_name, connection.id)
    from (
      select id, organization_id, slug, team_id, team_name, bot_user_id, bot_access_token, scopes,
        provider_application_id
      from slack_connections where organization_id = $1
    ) connection
    union all
    select 'linear', to_jsonb(connection),
      row_number() over (order by connection.linear_organization_name, connection.id)
    from (
      select id, organization_id, slug, linear_organization_id, linear_organization_name,
        app_user_id, access_token, refresh_token, access_token_expires_at, scopes,
        provider_application_id
      from linear_connections where organization_id = $1
    ) connection
  ) usage
  order by provider, position`;

const scopes = z.array(z.string()).catch([]);
const applicationId = z.string().nullable();

const github = z
  .object({
    id: z.string(),
    organization_id: z.string(),
    slug: z.string(),
    installation_id: z.coerce.number(),
    account_id: z.string(),
    account_login: z.string(),
    account_type: z.string(),
    status: z.enum(["active", "suspended"]),
    provider_application_id: applicationId,
  })
  .transform((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    installationId: row.installation_id,
    accountId: row.account_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    status: row.status,
    providerApplicationId: row.provider_application_id,
  }));

const discord = z
  .object({
    id: z.string(),
    organization_id: z.string(),
    slug: z.string(),
    guild_id: z.string(),
    guild_name: z.string(),
    provider_application_id: applicationId,
  })
  .transform((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    guildId: row.guild_id,
    guildName: row.guild_name,
    providerApplicationId: row.provider_application_id,
  }));

const slack = z
  .object({
    id: z.string(),
    organization_id: z.string(),
    slug: z.string(),
    team_id: z.string(),
    team_name: z.string(),
    bot_user_id: z.string(),
    bot_access_token: z.string(),
    scopes,
    provider_application_id: applicationId,
  })
  .transform((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    teamId: row.team_id,
    teamName: row.team_name,
    botUserId: row.bot_user_id,
    botAccessToken: row.bot_access_token,
    scopes: row.scopes,
    providerApplicationId: row.provider_application_id,
  }));

const linear = z
  .object({
    id: z.string(),
    organization_id: z.string(),
    slug: z.string(),
    linear_organization_id: z.string(),
    linear_organization_name: z.string(),
    app_user_id: z.string(),
    access_token: z.string(),
    refresh_token: z.string().nullable(),
    access_token_expires_at: z.string().nullable(),
    scopes,
    provider_application_id: applicationId,
  })
  .transform((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    linearOrganizationId: row.linear_organization_id,
    linearOrganizationName: row.linear_organization_name,
    appUserId: row.app_user_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpiresAt:
      row.access_token_expires_at === null ? null : new Date(row.access_token_expires_at),
    scopes: row.scopes,
    providerApplicationId: row.provider_application_id,
  }));

const connectionRow = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("github"), data: github }),
  z.object({ provider: z.literal("discord"), data: discord }),
  z.object({ provider: z.literal("slack"), data: slack }),
  z.object({ provider: z.literal("linear"), data: linear }),
]);

export async function organizationConnectionUsage(
  database: QueryHandle,
  organizationId: string,
): Promise<OrganizationConnectionUsage> {
  const { rows } = await database.query(CONNECTION_USAGE_SQL, [organizationId]);
  const usage: OrganizationConnectionUsage = { github: [], discord: [], slack: [], linear: [] };
  for (const row of rows) {
    const parsed = connectionRow.parse(row);
    if (parsed.provider === "github") usage.github.push(parsed.data);
    else if (parsed.provider === "discord") usage.discord.push(parsed.data);
    else if (parsed.provider === "slack") usage.slack.push(parsed.data);
    else usage.linear.push(parsed.data);
  }
  return usage;
}
