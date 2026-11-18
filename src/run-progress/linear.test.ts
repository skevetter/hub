import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { LinearConnectionRecord, LinearConnectionTokenUpdate } from "../db/types.js";
import { createLinearApiClient, LINEAR_REQUIRED_SCOPES } from "../providers/linear/client.js";
import { createLinearProgressProvider } from "./linear.js";
import type { ProgressDestination } from "./types.js";

const scope = { id: "run", organizationId: "hub-org", projectId: "project" };
const credential = { kind: "linear-organization", linearOrganizationId: "linear-org" } as const;
const outputContext = { provider: "linear", linearOrganizationId: "linear-org", issueId: "issue" };
const destination = { credential, issueId: "issue" };
const ref = { credential, commentId: "comment" };
const signal = new AbortController().signal;

function fixture(fetch: typeof globalThis.fetch) {
  const connection: LinearConnectionRecord = {
    id: "connection",
    organizationId: scope.organizationId,
    slug: "workspace",
    providerApplicationId: "app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Workspace",
    appUserId: "app-user",
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    accessTokenExpiresAt: null,
    scopes: [...LINEAR_REQUIRED_SCOPES],
  };
  const lookup = vi.fn(async () => ({ ...connection }));
  const refresh = vi.fn(async () => ({ accessToken: "refreshed-token" }));
  const persist = vi.fn(async (tokens: LinearConnectionTokenUpdate) => {
    Object.assign(connection, tokens);
  });
  const lock = {
    acquire: () => Promise.resolve(),
    release: () => {},
  };
  const client = createLinearApiClient({
    connectionForLinearOrganization: lookup,
    withLinearConnectionRefresh: async (_id, operation) => {
      await lock.acquire();
      const result = await operation(await lookup(), persist);
      lock.release();
      return result;
    },
    connectionClient: { refresh },
    fetch,
  });
  const provider = createLinearProgressProvider({
    client,
    connectionForLinearOrganization: lookup,
    clientSecret: "fake-client-secret",
  });
  async function authorize(target: ProgressDestination) {
    assert.equal(await provider.authorize(target.credential, scope, signal), "ok");
  }
  return { provider, connection, lookup, refresh, persist, lock, authorize };
}

const neverFetch = () => Promise.reject(new Error("unexpected Linear request"));

describe("Linear run progress", () => {
  it("uses the stored issue destination and edits the same comment through completion", async () => {
    const replies = [
      { commentCreate: { success: true, comment: { id: "comment" } } },
      { commentUpdate: { success: true } },
      { commentUpdate: { success: true } },
    ];
    const bodies: unknown[] = [];
    const { provider, authorize } = fixture(async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-access-token");
      assert.equal(init?.signal, signal);
      const body = init?.body;
      assert.ok(typeof body === "string");
      const payload: unknown = JSON.parse(body);
      assert.ok(typeof payload === "object" && payload !== null && "variables" in payload);
      bodies.push(payload.variables);
      return Response.json({ data: replies.shift() });
    });
    const { run } = await createMemoryDatabase().createAcceptedTriggerRun({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      configurationRevisionId: "revision",
      providerEventReceiptId: "receipt",
      configuredTriggerName: "test",
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext,
      stepIds: [],
      deadlineAt: new Date(Date.now() + 60_000),
    });
    const target = provider.destination(run);
    assert.deepEqual(target, destination);
    assert.equal(
      provider.destination({ ...run, outputContext: { ...outputContext, provider: "slack" } }),
      undefined,
    );
    assert.equal(
      provider.destination({ ...run, outputContext: { ...outputContext, issueId: "" } }),
      undefined,
    );
    assert.equal(provider.maxBodyChars, 4_000);

    await authorize(target);
    assert.deepEqual(await provider.secrets(target.credential, signal), [
      "fake-client-secret",
      "fake-access-token",
      "fake-refresh-token",
    ]);
    const created = await provider.create(target, "Paseo run: Running", signal);
    assert.deepEqual(created, { status: "ok", ref });
    if (created.status !== "ok" || created.ref === undefined) throw new Error("missing comment");
    await authorize(created.ref);
    assert.deepEqual(await provider.edit(created.ref, "Step `2` of `2`", signal), { status: "ok" });
    await authorize(created.ref);
    assert.deepEqual(await provider.edit(created.ref, "Paseo run: Succeeded in `3s`", signal), {
      status: "ok",
    });
    assert.deepEqual(bodies, [
      { issueId: "issue", body: "Paseo run: Running" },
      { id: "comment", body: "Step `2` of `2`" },
      { id: "comment", body: "Paseo run: Succeeded in `3s`" },
    ]);
  });

  it.each([
    {
      status: 400,
      message: "Comment not found",
      code: "INVALID_INPUT",
      expected: { status: "gone" },
    },
    {
      status: 200,
      message: "Could not find the comment",
      code: undefined,
      expected: { status: "gone" },
    },
    {
      status: 200,
      message: "Forbidden",
      code: undefined,
      expected: { status: "unavailable", code: "scope_missing" },
    },
    {
      status: 403,
      message: "Forbidden",
      code: "FORBIDDEN",
      expected: { status: "unavailable", code: "scope_missing" },
    },
    {
      status: 200,
      message: "Missing write scope",
      code: "BAD_USER_INPUT",
      expected: { status: "unavailable", code: "scope_missing" },
    },
    {
      status: 401,
      message: "Credential expired",
      code: "UNAUTHENTICATED",
      expected: { status: "unavailable", code: "reauthorize" },
    },
    {
      status: 400,
      message: "Too many requests",
      code: "RATELIMITED",
      expected: { status: "retry", afterMs: 7000, notCreated: true },
    },
  ])(
    "maps an edit response with $status and $code",
    async ({ status, message, code, expected }) => {
      const fetch = vi.fn(async () =>
        Response.json(
          { errors: [{ message, extensions: { code } }] },
          { status, headers: { "retry-after": "7" } },
        ),
      );
      const { provider, authorize } = fixture(fetch);
      await authorize(ref);
      assert.deepEqual(await provider.edit(ref, "Finished", signal), expected);
      assert.equal(fetch.mock.calls.length, 1);
    },
  );

  it.each([200, 400, 429])(
    "keeps a partial HTTP %i rate-limited create uncertain after one POST",
    async (status) => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            data: { commentCreate: { success: true, comment: null } },
            errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
          },
          { status },
        ),
      );
      const { provider, authorize } = fixture(fetch);
      await authorize(destination);
      assert.deepEqual(await provider.create(destination, "Started", signal), {
        status: "retry",
        afterMs: 0,
        notCreated: false,
        transient: true,
      });
      assert.equal(fetch.mock.calls.length, 1);
    },
  );

  it("keeps a successful create with a null comment uncertain after one POST", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: { commentCreate: { success: true, comment: null } } }),
    );
    const { provider, authorize } = fixture(fetch);
    await authorize(destination);
    await assert.rejects(provider.create(destination, "Started", signal));
    assert.equal(fetch.mock.calls.length, 1);
  });

  it("keeps a redirected create uncertain without replaying the POST", async () => {
    const requests: Array<{ method: string | undefined; path: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, path: request.url });
      if (request.url === "/graphql") response.writeHead(307, { location: "/redirected" });
      response.end();
    });
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address !== null && typeof address !== "string");
      const { provider, authorize } = fixture((_url, init) =>
        fetch(`http://127.0.0.1:${address.port}/graphql`, init),
      );
      await authorize(destination);
      assert.deepEqual(await provider.create(destination, "Started", signal), {
        status: "retry",
        afterMs: 0,
        notCreated: false,
        transient: true,
      });
      assert.deepEqual(requests, [{ method: "POST", path: "/graphql" }]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  });

  it("keeps a server error uncertain and sends a create only once", async () => {
    const fetch = vi.fn(async () => new Response("error", { status: 503 }));
    const { provider, authorize } = fixture(fetch);
    await authorize(destination);
    await assert.rejects(provider.create(destination, "Started", signal), /HTTP 503/u);
    assert.equal(fetch.mock.calls.length, 1);
  });

  it("requires reauthorization before using an expired connection without a refresh token", async () => {
    const { provider, connection } = fixture(neverFetch);
    connection.accessTokenExpiresAt = new Date(0);
    connection.refreshToken = null;
    assert.deepEqual(await provider.authorize(credential, scope, signal), {
      unavailable: "reauthorize",
    });
  });

  it("refuses a connection owned by another Hub organization before create or edit", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection } = fixture(fetch);
    connection.organizationId = "other-org";
    assert.deepEqual(await provider.authorize(credential, scope, signal), {
      refused: "connection_not_owned",
    });
    assert.deepEqual(await provider.create(destination, "Started", signal), {
      status: "refused",
      code: "connection_not_owned",
    });
    assert.deepEqual(await provider.edit(ref, "Finished", signal), {
      status: "refused",
      code: "connection_not_owned",
    });
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("refuses a rebound connection when acquiring the write token", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize } = fixture(fetch);
    await authorize(ref);
    connection.organizationId = "other-org";
    assert.deepEqual(await provider.edit(ref, "Finished", signal), {
      status: "refused",
      code: "connection_not_owned",
    });
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("refuses to send the refreshed access token in a progress body", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, refresh } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    await authorize(ref);
    assert.deepEqual(await provider.edit(ref, "Run details: refreshed-token", signal), {
      status: "refused",
      code: "body_contains_secret",
    });
    assert.equal(refresh.mock.calls.length, 1);
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("skips token refresh and the mutation after cancellation during connection lookup", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, lookup, refresh } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    await authorize(ref);
    const controller = new AbortController();
    lookup.mockImplementationOnce(async () => {
      controller.abort();
      return { ...connection };
    });
    await assert.rejects(provider.edit(ref, "Finished", controller.signal), { name: "AbortError" });
    assert.equal(refresh.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("refuses a rebound connection while waiting for the refresh lock", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, lookup, refresh } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    await authorize(ref);
    lookup.mockResolvedValueOnce({ ...connection });
    connection.organizationId = "other-org";
    assert.deepEqual(await provider.edit(ref, "Finished", signal), {
      status: "refused",
      code: "connection_not_owned",
    });
    assert.equal(refresh.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });
  it.each([
    { organizationId: "other-org", id: "rebound" },
    { organizationId: scope.organizationId, id: "reconnected" },
  ])("refuses the earlier token after the refresh lock releases to $id", async (binding) => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, refresh, persist, lock } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    await authorize(ref);
    lock.release = () => {
      Object.assign(connection, binding);
    };
    assert.deepEqual(await provider.edit(ref, "Finished", signal), {
      status: "refused",
      code: "connection_not_owned",
    });
    assert.equal(refresh.mock.calls.length, 1);
    assert.equal(persist.mock.calls.length, 1);
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("skips refresh and persistence when canceled while waiting for the lock", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, refresh, persist, lock } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    await authorize(ref);
    const started = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<void>();
    lock.acquire = () => {
      started.resolve();
      return acquired.promise;
    };
    const controller = new AbortController();
    const pending = provider.edit(ref, "Finished", controller.signal);
    await started.promise;
    controller.abort();
    acquired.resolve();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(refresh.mock.calls.length, 0);
    assert.equal(persist.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("skips persistence if cancellation arrives during the refresh request", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, refresh, persist } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    const controller = new AbortController();
    await authorize(ref);
    refresh.mockImplementationOnce(async () => {
      controller.abort();
      return { accessToken: "late-token" };
    });
    await assert.rejects(provider.edit(ref, "Finished", controller.signal), { name: "AbortError" });
    assert.equal(persist.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });
});
