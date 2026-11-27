import { describe, expect, it } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import { stateHash } from "../../connections/shared.js";
import { ConnectionAttemptUnavailableError } from "../../db/errors.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { ConnectionAttemptRecord } from "../../db/types.js";
import { createSlackRegistration } from "./index.js";
import { createHmac } from "node:crypto";
import { SLACK_REQUIRED_BOT_SCOPES } from "./client.js";
const applicationBaseUrl = "https://hub.test";
const publicBaseUrl = "https://callback.test";
const configuration = {
  transport: "webhook" as const,
  appId: "900",
  clientId: "client",
  clientSecret: "fixture-client",
  signingSecret: "fixture-signing",
};
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
    provider: "slack",
    phase: "slack_authorization",
    organizationId: "org",
    userId: "user",
    sessionId: "session",
    returnRoute: "/o/org/connections",
    candidateExternalId: null,
    pkceVerifier: null,
    configurationVersion: 7,
    providerApplicationId: "900",
    callbackOrigin: publicBaseUrl,
    configurationSnapshot: { provider: "slack", ...configuration },
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
  database.bindSlackConnection = (input) => {
    calls.push(["bind", input]);
    return Promise.resolve();
  };
  return { database, calls };
}

const identity = {
  appId: "900",
  teamId: "T1",
  teamName: "Fixture",
  botUserId: "U1",
  botAccessToken: "fixture-bot",
  scopes: [...SLACK_REQUIRED_BOT_SCOPES],
};

function register(mode: Mode) {
  const { database, calls } = callbackDatabase(mode);
  const registration = createSlackRegistration({
    database,
    auth: fixtureAuth(),
    applicationBaseUrl,
    publicBaseUrl,
    configuration,
    connectionClient: {
      authorizationUrl: (state) => `${publicBaseUrl}/authorize?state=${state}`,
      exchangeCode(code) {
        calls.push(["exchange", code]);
        return Promise.resolve(mode === "unverified" ? { ...identity, scopes: [] } : identity);
      },
      verifyInstallation(value) {
        calls.push(["verify", value]);
        return Promise.resolve();
      },
      revoke: () => Promise.resolve(),
    },
  });
  return { registration, calls };
}

function expectedCalls(mode: Mode, state: string, code: string) {
  const input = {
    stateVerifier: stateHash(state),
    phase: "slack_authorization",
    access: { sessionId: "session", userId: "user" },
  };
  const calls: unknown[] = [];
  if (mode === "missing" || mode === "malformed") return calls;
  calls.push(["read", input]);
  if (mode === "expired") return calls;
  if (mode === "cancelled") return [...calls, ["consume", input]];
  calls.push(["exchange", code]);
  calls.push(["verify", mode === "unverified" ? { ...identity, scopes: [] } : identity]);
  if (mode === "unverified") return calls;
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
    return `${applicationBaseUrl}/connections?app=slack&result=connection_invalid`;
  }
  const results = {
    accepted: "slack_connected",
    cancelled: "slack_cancelled",
    unverified: "slack_bot_failed",
  };
  const result = results[mode];
  return `${publicBaseUrl}/o/org/connections?app=slack&result=${result}`;
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

function sliceDetails(registration: ReturnType<typeof createSlackRegistration>) {
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
    sources: configured ? 1 : 0,
    outputs: active ? ["slack.reply"] : [],
    requests: configured ? ["slack.events"] : [],
    attachment: active ? "slack" : undefined,
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
    const registration = createSlackRegistration({
      database: databaseAvailable ? createMemoryDatabase() : null,
      auth: null,
      applicationBaseUrl,
      ...(originAvailable ? { publicBaseUrl } : {}),
      configuration: configurationAvailable ? configuration : null,
    });
    expect(sliceDetails(registration)).toEqual(expectedSlice(configured, active));
  });
}

describe("Slack registration and authorization", () => {
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

function testWebhook(
  mode: "unsigned" | "expired" | "malformed" | "challenge",
  status: number,
  body: string,
) {
  it(`handles a ${mode} Slack webhook`, async () => {
    const registration = createSlackRegistration({
      database: null,
      auth: null,
      applicationBaseUrl,
      publicBaseUrl,
      configuration,
    });
    const webhook = registration.requests[0];
    if (webhook === undefined) throw new Error("missing webhook");
    const timestamp = String(Math.floor(Date.now() / 1000) - (mode === "expired" ? 301 : 0));
    const requestBody =
      mode === "malformed" ? "{" : '{"type":"url_verification","challenge":"fixture"}';
    const signature = createHmac("sha256", configuration.signingSecret)
      .update(`v0:${timestamp}:${requestBody}`)
      .digest("hex");
    const response = await webhook.handle(
      new Request(`${applicationBaseUrl}/webhook`, {
        method: "POST",
        body: requestBody,
        ...(mode === "unsigned"
          ? {}
          : {
              headers: {
                "x-slack-request-timestamp": timestamp,
                "x-slack-signature": `v0=${signature}`,
              },
            }),
      }),
    );
    expect([response.status, await response.text()]).toEqual([status, body]);
  });
}

describe("Slack webhook admission", () => {
  testWebhook("unsigned", 401, "Unauthorized");
  testWebhook("expired", 401, "Unauthorized");
  testWebhook("malformed", 400, '{"error":"request body must be valid JSON"}');
  testWebhook("challenge", 200, '{"challenge":"fixture"}');
});
