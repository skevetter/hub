import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createDiscordConnectionClient } from "./client.js";

describe("Discord connection client", () => {
  it("distinguishes present, confirmed absent, and uncertain membership", async () => {
    const discord = new DiscordProviderPort();
    const provider = createDiscordConnectionClient(discord.options());

    assert.equal(await provider.guildMembership("100"), "present");
    discord.guildStatus = 404;
    assert.equal(await provider.guildMembership("100"), "absent");
    for (const status of [401, 403, 429, 500, 503]) {
      discord.guildStatus = status;
      assert.equal(await provider.guildMembership("100"), "unknown");
    }
    discord.guildFailure = new Error("network unavailable");
    assert.equal(await provider.guildMembership("100"), "unknown");
  });

  it("accepts positive decimal guild identities and rejects invalid OAuth guild ids", async () => {
    const discord = new DiscordProviderPort();
    const provider = createDiscordConnectionClient(discord.options());

    assert.deepEqual(await provider.verifyGuild("code"), {
      guildId: "100",
      guildName: "Acme",
    });
    discord.oauthGuildId = "0";
    await assert.rejects(provider.verifyGuild("code"));
    discord.oauthGuildId = "guild";
    await assert.rejects(provider.verifyGuild("code"));
  });

  it("keeps the token-grant guild authoritative", async () => {
    const discord = new DiscordProviderPort();
    discord.membershipGuildId = "200";
    const provider = createDiscordConnectionClient(discord.options());

    assert.equal(await provider.verifyGuild("code"), undefined);
    assert.deepEqual(discord.membershipRequests, ["100"]);
  });

  it("sends the configured client credentials and callback with the token grant", async () => {
    const discord = new DiscordProviderPort();
    const provider = createDiscordConnectionClient(new InheritedCredentials(discord.options()));

    await provider.verifyGuild("the-code");

    assert.equal(discord.tokenBodies.length, 1);
    const body = new URLSearchParams(discord.tokenBodies[0]);
    assert.equal(body.get("client_id"), "200");
    assert.equal(body.get("client_secret"), "secret");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "the-code");
    assert.equal(
      body.get("redirect_uri"),
      "https://hub.example.test/api/integrations/discord/callback",
    );
  });
});

class InheritedCredentials {
  readonly publicBaseUrl: string;
  readonly botToken: string;
  readonly fetch: typeof fetch;

  constructor(base: ReturnType<DiscordProviderPort["options"]>) {
    this.publicBaseUrl = base.publicBaseUrl;
    this.botToken = base.botToken;
    this.fetch = base.fetch;
  }

  get clientId() {
    return "200";
  }

  get clientSecret() {
    return "secret";
  }
}

class DiscordProviderPort {
  guildStatus = 200;
  guildFailure: Error | undefined;
  oauthGuildId = "100";
  membershipGuildId = "100";
  readonly membershipRequests: string[] = [];
  readonly tokenBodies: string[] = [];

  options() {
    return {
      publicBaseUrl: "https://hub.example.test",
      clientId: "200",
      clientSecret: "secret",
      botToken: "bot-token",
      fetch: this.request,
    };
  }

  private readonly request: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/v10/oauth2/token") {
      this.tokenBodies.push(init?.body instanceof URLSearchParams ? init.body.toString() : "");
      return Promise.resolve(
        Response.json({
          access_token: "oauth-token",
          guild: { id: this.oauthGuildId, name: "Acme" },
        }),
      );
    }
    this.membershipRequests.push(url.pathname.split("/").at(-1)!);
    if (this.guildFailure !== undefined) return Promise.reject(this.guildFailure);
    return Promise.resolve(
      this.guildStatus === 200
        ? Response.json({ id: this.membershipGuildId, name: "Acme" })
        : new Response(null, { status: this.guildStatus }),
    );
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(input instanceof Request ? input.url : input);
}
