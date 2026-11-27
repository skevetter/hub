import { describe, it, expect, vi } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import { readConnectionReturn } from "../../connections/result-contract.js";
import { createMemoryDatabase } from "../../db/memory.js";
import type { ConnectionAttemptRecord } from "../../db/types.js";
import type { LinearConnectionClient } from "./client.js";
import { createLinearRegistration } from "./index.js";

const configuration = {
  clientId: "fixture-app",
  clientSecret: "fixture-secret",
  webhookSecret: "fixture-webhook",
};
const options = {
  applicationBaseUrl: "https://hub.test",
  publicBaseUrl: "https://public.test",
  configuration,
};
const address = "https://hub.test/callback";
const attempt = {
  id: "attempt",
  provider: "linear",
  phase: "linear_authorization",
  organizationId: "organization",
  returnRoute: "/o/slug/settings/connections",
  userId: "owner",
  sessionId: "session",
  candidateExternalId: null,
  pkceVerifier: null,
  configurationVersion: 3,
  providerApplicationId: "fixture-app",
  callbackOrigin: "https://attempt.test",
  configurationSnapshot: { fixture: true },
  expectedConfigurationVersion: null,
  activateConfiguration: false,
  expiresAt: new Date(1000),
  consumedAt: null,
} satisfies ConnectionAttemptRecord;
const installation = {
  linearOrganizationId: "workspace",
  linearOrganizationName: "Workspace",
  appUserId: "app-user",
  accessToken: "fixture-token",
  refreshToken: null,
  accessTokenExpiresAt: null,
  scopes: [],
};

function authFixture(): AuthServer {
  const unexpected = (): never => {
    throw new Error("unexpected auth");
  };
  return {
    resolveAccount: async () => ({
      session: { id: "session", activeOrganizationId: null },
      account: { id: "owner", name: "Owner", email: "owner@example.test" },
      isInstanceOperator: false,
    }),
    rejectCookieMutation: () => new Response("cookie denied", { status: 403 }),
    resolveOrganizationAccess: unexpected,
    handle: unexpected,
    resources: unexpected,
    close: unexpected,
  };
}

function oauthFixture(activateConfiguration: boolean) {
  const database = createMemoryDatabase();
  const consume = vi.fn<typeof database.consumeConnectionAttempt>().mockResolvedValue(undefined);
  const bind = vi.fn<typeof database.bindLinearConnection>().mockResolvedValue(undefined);
  const exchangeCode = vi
    .fn<LinearConnectionClient["exchangeCode"]>()
    .mockResolvedValue(installation);
  const read = vi
    .fn<typeof database.readConnectionAttempt>()
    .mockResolvedValue({ ...attempt, activateConfiguration });
  database.consumeConnectionAttempt = consume;
  database.bindLinearConnection = bind;
  database.readConnectionAttempt = read;
  const connectionClient: LinearConnectionClient = {
    authorizationUrl: () => "https://linear.test/oauth",
    exchangeCode,
    refresh: async () => {
      throw new Error("unexpected refresh");
    },
    revoke: async () => {},
  };
  return { database, connectionClient, trace: { consume, bind, exchangeCode, read } };
}

function action(
  registration: ReturnType<typeof createLinearRegistration>,
  name: string,
  url: string,
) {
  const run = registration.connection.actions[name];
  if (!run) throw new Error("missing action");
  return run(new Request(url));
}

function redirect(response: Response) {
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location") ?? "");
}

describe("registered Linear connection", () => {
  it("omits database-backed features unless configured with a database", () => {
    const noDatabase = createLinearRegistration({ ...options, database: null, auth: null });
    expect(noDatabase.requests.map(({ name }) => name)).toEqual(["linear.events"]);
    expect(noDatabase.sources).toHaveLength(1);
    expect(noDatabase.progressProvider).toBeUndefined();
    expect(noDatabase.outputs).toEqual([]);
    const unconfigured = createLinearRegistration({
      ...options,
      configuration: null,
      database: null,
      auth: null,
    });
    expect(unconfigured.requests).toEqual([]);
    expect(
      unconfigured.connection.status({ github: [], discord: [], slack: [], linear: [] }),
    ).toEqual({ status: "notConfigured" });
  });

  it("consumes a cancelled attempt without exchanging a code or binding", async () => {
    const { trace, ...deps } = oauthFixture(false);
    const registration = createLinearRegistration({ ...options, ...deps, auth: authFixture() });
    const url = redirect(
      await action(registration, "callback", address + "?state=state&error=access_denied"),
    );
    expect(url.origin).toBe(attempt.callbackOrigin);
    expect(readConnectionReturn(url)?.result).toBe("linear_cancelled");
    expect(trace.consume).toHaveBeenCalledTimes(1);
    expect(trace.exchangeCode).not.toHaveBeenCalled();
    expect(trace.bind).not.toHaveBeenCalled();
  });

  it("binds an ordinary installation and sends activation to the verified handler", async () => {
    for (const activate of [false, true]) {
      const { trace, ...deps } = oauthFixture(activate);
      const verified = vi.fn().mockResolvedValue(undefined);
      const registration = createLinearRegistration({
        ...options,
        ...deps,
        auth: authFixture(),
        onVerifiedInstallation: verified,
      });
      const url = redirect(
        await action(registration, "callback", address + "?state=state&code=code"),
      );
      expect(url.origin).toBe(attempt.callbackOrigin);
      expect(readConnectionReturn(url)?.result).toBe("linear_connected");
      expect(trace.exchangeCode).toHaveBeenCalledWith("code");
      expect(trace.bind).toHaveBeenCalledTimes(activate ? 0 : 1);
      expect(verified).toHaveBeenCalledTimes(activate ? 1 : 0);
      if (activate)
        expect(verified).toHaveBeenCalledWith(
          expect.objectContaining({
            configuration: attempt.configurationSnapshot,
            expectedConfigurationVersion: undefined,
            callbackOrigin: attempt.callbackOrigin,
            userId: attempt.userId,
            installation,
          }),
        );
    }
  });

  it("does not silently bind activation when no verified handler is configured", async () => {
    const { trace, ...deps } = oauthFixture(true);
    const registration = createLinearRegistration({ ...options, ...deps, auth: authFixture() });
    const url = redirect(
      await action(registration, "callback", address + "?state=state&code=code"),
    );
    expect(url.origin).toBe(attempt.callbackOrigin);
    expect(readConnectionReturn(url)?.result).toBe("connection_unavailable");
    expect(trace.bind).not.toHaveBeenCalled();
  });

  it("keeps cookie denials unchanged on start and disconnect", async () => {
    const { trace, ...deps } = oauthFixture(false);
    const registration = createLinearRegistration({ ...options, ...deps, auth: authFixture() });
    for (const name of ["start", "disconnect"]) {
      const response = await action(registration, name, address);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("cookie denied");
    }
    expect(trace.read).not.toHaveBeenCalled();
  });
});
