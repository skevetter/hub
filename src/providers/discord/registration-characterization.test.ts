import { describe, expect, it } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import { stateHash } from "../../connections/shared.js";
import { ConnectionAttemptUnavailableError } from "../../db/errors.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { ConnectionAttemptRecord } from "../../db/types.js";
import { createDiscordRegistration } from "./index.js";

const applicationBaseUrl = "https://hub.test";
const publicBaseUrl = "https://callback.test";
const configuration = { clientId: "900", clientSecret: "fixture-client", botToken: "fixture-bot" };
const connections = { github: [], slack: [], discord: [], linear: [] };

type Mode = "accepted" | "unverified" | "expired" | "cancelled" | "missing" | "malformed";

function fixtureAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session", activeOrganizationId: null },
        account: { id: "user", name: "Fixture", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    rejectCookieMutation: (request) =>
      request.headers.has("x-fixture-csrf") ? new Response("rejected", { status: 403 }) : undefined,
    close: () => Promise.resolve(),
  };
}

function callbackDatabase(mode: Mode) {
  const database = createMemoryDatabase();
  const calls: unknown[] = [];
  const attempt: ConnectionAttemptRecord = {
    id: "attempt",
    provider: "discord",
    phase: "discord_authorization",
    organizationId: "org",
    userId: "user",
    sessionId: "session",
    returnRoute: "/o/org/connections",
    candidateExternalId: null,
    pkceVerifier: null,
    configurationVersion: 7,
    providerApplicationId: "900",
    callbackOrigin: publicBaseUrl,
    configurationSnapshot: { provider: "discord", ...configuration },
    expectedConfigurationVersion: null,
    activateConfiguration: false,
    expiresAt: new Date("2030-01-01"),
    consumedAt: null,
  };
  database.readConnectionAttempt = (input) => {
    calls.push(["read", input]);
    return mode === "expired"
      ? Promise.reject(new ConnectionAttemptUnavailableError())
      : Promise.resolve(attempt);
  };
  database.consumeConnectionAttempt = (input) => {
    calls.push(["consume", input]);
    return Promise.resolve();
  };
  database.bindDiscordConnection = (input) => {
    calls.push(["bind", input]);
    return Promise.resolve();
  };
  return { database, calls };
}

const identity = { guildId: "901", guildName: "Fixture" };

function register(mode: Mode) {
  const { database, calls } = callbackDatabase(mode);
  const registration = createDiscordRegistration({
    database,
    auth: fixtureAuth(),
    applicationBaseUrl,
    publicBaseUrl,
    configuration,
    connectionClient: {
      authorizationUrl: (state) => `${publicBaseUrl}/authorize?state=${state}`,
      verifyGuild(code) {
        calls.push(["exchange", code]);
        return Promise.resolve(mode === "unverified" ? undefined : identity);
      },
      leaveGuild: () => Promise.resolve(),
      guildMembership: () => Promise.resolve("present"),
    },
  });
  return { registration, calls };
}

function expectedCalls(mode: Mode, state: string, code: string) {
  const input = {
    stateVerifier: stateHash(state),
    phase: "discord_authorization",
    access: { sessionId: "session", userId: "user" },
  };
  const calls: unknown[] = [];
  if (mode === "missing" || mode === "malformed") return calls;
  calls.push(["read", input]);
  if (mode === "expired") return calls;
  if (mode === "cancelled") return [...calls, ["consume", input]];
  calls.push(["exchange", code]);
  if (mode === "unverified") return [...calls, ["consume", input]];
  return [...calls, ["bind", { providerApplicationId: "900", ...input, ...identity }]];
}

function callbackQuery(mode: Mode, state: string, code: string) {
  if (mode === "missing") return "";
  if (mode === "malformed") return "?state=%ZZ&error=malformed";
  const query = new URLSearchParams({ state });
  if (mode === "cancelled") query.set("error", "access_denied");
  else query.set("code", code);
  return `?${query}`;
}

function expectedLocation(mode: Mode) {
  if (mode === "missing" || mode === "malformed" || mode === "expired") {
    return `${applicationBaseUrl}/connections?app=discord&result=connection_invalid`;
  }
  const results = {
    accepted: "discord_connected",
    cancelled: "discord_cancelled",
    unverified: "connection_invalid",
  };
  const result = results[mode];
  return `${publicBaseUrl}/o/org/connections?app=discord&result=${result}`;
}

function testCallback(mode: Mode, state: string, code: string) {
  it(`handles ${mode} callback with state ${state} and code ${code}`, async () => {
    const { registration, calls } = register(mode);
    const callback = registration.connection.actions["callback"];
    if (callback === undefined) throw new Error("callback unavailable");
    const result = await callback(
      new Request(`${applicationBaseUrl}/callback${callbackQuery(mode, state, code)}`),
    );
    expect({ status: result.status, location: result.headers.get("location") }).toEqual({
      status: 303,
      location: expectedLocation(mode),
    });
    expect(calls).toEqual(expectedCalls(mode, state, code));
  });
}

function sliceDetails(registration: ReturnType<typeof createDiscordRegistration>) {
  return {
    status: registration.connection.status(connections),
    actions: Object.keys(registration.connection.actions),
    snapshot: registration.configurationSnapshot,
    sources: registration.sources.length,
    outputs: registration.outputs.map((output) => output.type),
    requests: registration.requests.map((request) => request.name),
    attachment: registration.attachment?.provider,
  };
}

function expectedSlice(configured: boolean, active: boolean) {
  return {
    status: { status: configured ? "disconnected" : "notConfigured" },
    actions: [],
    snapshot: active ? { version: 0, callbackOrigin: publicBaseUrl } : undefined,
    sources: active ? 1 : 0,
    outputs: active ? ["discord.reply"] : [],
    requests: [],
    attachment: active ? "discord" : undefined,
  };
}

function testSlice(
  configurationAvailable: boolean,
  databaseAvailable: boolean,
  originAvailable: boolean,
) {
  it(`registers config ${configurationAvailable}, storage ${databaseAvailable}, and origin ${originAvailable}`, () => {
    const configured = configurationAvailable && originAvailable;
    const active = configured && databaseAvailable;
    const registration = createDiscordRegistration({
      database: databaseAvailable ? createMemoryDatabase() : null,
      auth: null,
      applicationBaseUrl,
      ...(originAvailable ? { publicBaseUrl } : {}),
      configuration: configurationAvailable ? configuration : null,
    });
    expect(sliceDetails(registration)).toEqual(expectedSlice(configured, active));
  });
}

describe("Discord registration and authorization", () => {
  for (const mode of [
    "accepted",
    "unverified",
    "expired",
    "cancelled",
    "missing",
    "malformed",
  ] as const) {
    for (const state of ["", "state-1", "state +/=%"]) {
      for (const code of ["", "accepted", "code +/%"]) testCallback(mode, state, code);
    }
  }

  for (const configured of [false, true]) {
    for (const database of [false, true]) {
      for (const origin of [false, true]) testSlice(configured, database, origin);
    }
  }

  for (const name of ["start", "disconnect"]) {
    it(`rejects ${name} before reading access when cookie mutation is rejected`, async () => {
      const { registration, calls } = register("accepted");
      const action = registration.connection.actions[name];
      if (action === undefined) throw new Error(`${name} unavailable`);
      const response = await action(
        new Request(`${applicationBaseUrl}/${name}`, {
          method: "POST",
          headers: { "x-fixture-csrf": "1" },
        }),
      );
      expect([response.status, await response.text(), calls]).toEqual([403, "rejected", []]);
    });
  }
});
