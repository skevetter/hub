import { z } from "zod";
import { reportFailure } from "../../failures/index.js";
import { DiscordSnowflakeSchema } from "../../discord/snowflake.js";

export interface DiscordGuildIdentity {
  guildId: string;
  guildName: string;
}

export type DiscordGuildMembership = "present" | "absent" | "unknown";

export interface DiscordConnectionClient {
  authorizationUrl(state: string): string;
  verifyGuild(code: string): Promise<DiscordGuildIdentity | undefined>;
  leaveGuild(guildId: string): Promise<void>;
  guildMembership(guildId: string): Promise<DiscordGuildMembership>;
}

const tokenSchema = z
  .object({
    access_token: z.string().min(1),
    guild: z.object({ id: DiscordSnowflakeSchema, name: z.string() }),
  })
  .loose();
const guildSchema = z.object({ id: DiscordSnowflakeSchema, name: z.string() }).loose();

const DISCORD_BASE_URL = "https://discord.com";

function discordAuthorizationUrl(clientId: string, callback: string, state: string): string {
  const url = new URL("/oauth2/authorize", DISCORD_BASE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "bot");
  url.searchParams.set("permissions", "309237713984");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeDiscordCode(
  request: typeof fetch,
  credentials: { clientId: string; clientSecret: string; callback: string },
  code: string,
): Promise<z.infer<typeof tokenSchema>> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: credentials.callback,
  });
  const exchanged = await request(new URL("/api/v10/oauth2/token", DISCORD_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!exchanged.ok) throw new Error(`discord oauth exchange failed: ${exchanged.status}`);
  return tokenSchema.parse(await exchanged.json());
}

export function createDiscordConnectionClient(input: {
  publicBaseUrl: string;
  clientId: string;
  clientSecret: string;
  botToken: string;
  fetch?: typeof fetch;
}): DiscordConnectionClient {
  const request = input.fetch ?? fetch;
  const baseUrl = DISCORD_BASE_URL;
  const callback = new URL("/api/integrations/discord/callback", input.publicBaseUrl).toString();
  return {
    authorizationUrl(state) {
      return discordAuthorizationUrl(input.clientId, callback, state);
    },
    async verifyGuild(code) {
      const grant = await exchangeDiscordCode(
        request,
        { clientId: input.clientId, clientSecret: input.clientSecret, callback },
        code,
      );
      const membership = await request(new URL(`/api/v10/guilds/${grant.guild.id}`, baseUrl), {
        headers: { authorization: `Bot ${input.botToken}` },
      });
      if (!membership.ok) {
        if (membership.status === 404) return undefined;
        throw new Error(`discord bot membership verification failed: ${membership.status}`);
      }
      const guild = guildSchema.parse(await membership.json());
      if (guild.id !== grant.guild.id) return undefined;
      return { guildId: guild.id, guildName: guild.name };
    },
    async leaveGuild(guildId) {
      const response = await request(new URL(`/api/v10/users/@me/guilds/${guildId}`, baseUrl), {
        method: "DELETE",
        headers: { authorization: `Bot ${input.botToken}` },
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`discord leave guild failed: ${response.status}`);
      }
    },
    async guildMembership(guildId) {
      DiscordSnowflakeSchema.parse(guildId);
      try {
        const response = await request(new URL(`/api/v10/guilds/${guildId}`, baseUrl), {
          headers: { authorization: `Bot ${input.botToken}` },
        });
        if (response.ok) return "present";
        return response.status === 404 ? "absent" : "unknown";
      } catch (error) {
        reportFailure(
          error,
          { operation: "discord.guild.membership", component: "providers", provider: "discord" },
          { scrubValues: [input.botToken], diagnostic: { guildId } },
        );
        return "unknown";
      }
    },
  };
}
