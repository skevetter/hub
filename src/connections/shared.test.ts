import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { ConnectionAttemptRecord, StartConnectionAttemptInput } from "../db/types.js";
import { createLogger } from "../logger.js";
import {
  CONNECTIONS_RETURN_ROUTE,
  cancelledConnectionResult,
  connectionAccess,
  connectionCallbackFailure,
  manageConnectionAccess,
  stateHash,
} from "./shared.js";

function orbitConnection(returnRoute: string) {
  const request = new Request(
    `https://hub.test/start?${new URLSearchParams({ organizationSlug: "orbit", returnRoute })}`,
  );
  const auth: AuthServer = {
    resolveAccount: () =>
      Promise.resolve({
        account: { id: "alice", name: "Alice", email: "alice@example.test" },
        session: { id: "session", activeOrganizationId: "acme-id" },
        isInstanceOperator: true,
      }),
    handle: vi.fn(),
    resources: vi.fn(),
    resolveOrganizationAccess: vi.fn(),
    rejectCookieMutation: vi.fn(),
    close: vi.fn(),
  };
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "alice",
        organizationId: "acme-id",
        organizationSlug: "acme",
        organizationName: "Acme",
        membershipId: "acme-owner",
        role: "owner",
      },
      {
        userId: "alice",
        organizationId: "orbit-id",
        organizationSlug: "orbit",
        organizationName: "Orbit",
        membershipId: "orbit-owner",
        role: "owner",
      },
    ],
  });
  let stored: ConnectionAttemptRecord | undefined;
  database.startConnectionAttempt = (input) => {
    stored = storedAttempt(input);
    return Promise.resolve();
  };
  database.readConnectionAttempt = () =>
    stored === undefined ? Promise.reject(new Error("No attempt")) : Promise.resolve(stored);
  database.consumeConnectionAttempt = () => {
    stored = undefined;
    return Promise.resolve();
  };
  return { auth, request, database };
}

function storedAttempt(input: StartConnectionAttemptInput): ConnectionAttemptRecord {
  return {
    ...input,
    ...input.access,
    id: "attempt",
    phase: "github_user_authorization",
    candidateExternalId: null,
    pkceVerifier: null,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
  };
}

describe("connection return routes", () => {
  it("carries the verified Orbit Apps route from start authority through the callback", async () => {
    const { auth, request, database } = orbitConnection("/apps");
    const access = await manageConnectionAccess(auth, database, request);
    const stateVerifier = stateHash("fixture-state");
    await database.startConnectionAttempt({
      access: connectionAccess(access),
      provider: "github",
      stateVerifier,
      lifetimeMinutes: 10,
      configurationVersion: 0,
      providerApplicationId: "github-1",
      callbackOrigin: "https://hub.test",
      configurationSnapshot: null,
      expectedConfigurationVersion: null,
      activateConfiguration: false,
    });
    expect(
      await database.readConnectionAttempt({
        stateVerifier,
        phase: "github_user_authorization",
        access: { userId: "alice", sessionId: "session" },
      }),
    ).toMatchObject({
      organizationId: "orbit-id",
      returnRoute: "/o/orbit/settings/instance/apps",
    });
    const response = await cancelledConnectionResult({
      auth,
      database,
      request,
      provider: "github",
      phase: "github_user_authorization",
      state: "fixture-state",
      applicationBaseUrl: "https://hub.test",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://hub.test/o/orbit/settings/instance/apps?app=github&result=github_cancelled",
    );
  });

  it.each([
    ["/", "/"],
    ["/o/acme/settings/instance/apps", "/o/orbit/connections"],
    ["https://example.com", "/o/orbit/connections"],
  ])("maps the %s return token to %s", async (token, expected) => {
    const { auth, request, database } = orbitConnection(token);
    expect((await manageConnectionAccess(auth, database, request)).returnRoute).toBe(expected);
  });
});

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("connection callback failures", () => {
  it("logs safe operator evidence and keeps the public response generic", () => {
    const stream = new CaptureStream();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

    const response = connectionCallbackFailure({
      error: new Error(`github oauth exchange failed: 401 ${token}`),
      provider: "github",
      phase: "authorization",
      request: new Request("https://hub.test/api/integrations/github/callback?state=s&code=c", {
        headers: { cookie: "session=secret" },
      }),
      applicationBaseUrl: "https://hub.test",
      returnRoute: "/o/acme/connections",
      log: createLogger(stream),
    });

    const output = stream.text();
    assert.match(output, /connection\.callback\.authorization failed/u);
    assert.match(output, /failureKind/u);
    assert.match(output, /stack/u);
    assert.match(output, /github/u);
    assert.match(output, /authorization/u);
    assert.match(output, /"type":"Error"/u);
    assert.doesNotMatch(output, /github oauth exchange failed/u);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes("session=secret"), false);
    assert.match(output, /"host":"hub.test"/u);
    assert.match(output, /"sessionCookiePresent":true/u);
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin + location.pathname, "https://hub.test/o/acme/connections");
    assert.equal(location.searchParams.get("app"), "github");
    assert.equal(location.searchParams.get("result"), "connection_unavailable");
    const reference = location.searchParams.get("reference");
    assert.notEqual(reference, null);
    assert.match(output, new RegExp(`"requestId":"${reference}"`, "u"));
  });

  it("names a return that reached Hub without a session, with the host it reached", () => {
    const stream = new CaptureStream();

    const response = connectionCallbackFailure({
      error: new ProductRequestError(401, "unauthenticated"),
      provider: "github",
      phase: "setup",
      request: new Request("https://hub.test/api/integrations/github/setup?state=s", {
        headers: { host: "hub.fly.example" },
      }),
      applicationBaseUrl: "https://hub.test",
      returnRoute: CONNECTIONS_RETURN_ROUTE,
      log: createLogger(stream),
    });

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "https://hub.test/connections?app=github&result=connection_unauthenticated",
    );
    const output = stream.text();
    assert.match(output, /"failureKind":"authentication"/u);
    assert.match(output, /"host":"hub.fly.example"/u);
    assert.match(output, /"sessionCookiePresent":false/u);
  });
});
