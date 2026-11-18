import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it, vi } from "vitest";
import { createApplicationRuntime } from "../application-runtime.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database, LinearConnectionRecord, LinearConnectionTokenUpdate } from "../db/types.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { logger } from "../logger.js";
import {
  createLinearApiClient,
  createLinearConnectionClient,
  LINEAR_REQUIRED_SCOPES,
} from "../providers/linear/client.js";
import { CredentialBackoff } from "./backoff.js";
import { createLinearProgressProvider } from "./linear.js";
import { readRunProgressSettings } from "./settings.js";
import { progressClock, type ProgressDestination } from "./types.js";
import { MessageWriter } from "./writer.js";

const scope = { id: "run", organizationId: "hub-org", projectId: "project" };
const credential = { kind: "linear-organization", linearOrganizationId: "linear-org" } as const;
const outputContext = { provider: "linear", linearOrganizationId: "linear-org", issueId: "issue" };
const destination = { credential, issueId: "issue" };
const ref = {
  credential,
  commentId: "comment",
  issueId: "issue",
  linearOrganizationId: "linear-org",
};
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
    scopes: [...LINEAR_REQUIRED_SCOPES, "write"],
  };
  const lookup = vi.fn(async () => ({ ...connection }));
  const refresh = vi.fn((_refreshToken: string, _signal?: AbortSignal) =>
    Promise.resolve({ accessToken: "refreshed-token" }),
  );
  const persist = vi.fn(async (tokens: LinearConnectionTokenUpdate) => {
    Object.assign(connection, tokens);
  });
  const database = createMemoryDatabase();
  const lock = {
    requested: vi.fn(),
    acquire: () => Promise.resolve(),
    release: () => {},
  };
  const client = createLinearApiClient({
    connectionForLinearOrganization: lookup,
    withLinearConnectionRefresh: (id, operation) => {
      lock.requested();
      return database.withAdvisoryLock(id, async () => {
        await lock.acquire();
        const result = await operation(await lookup(), persist);
        lock.release();
        return result;
      });
    },
    connectionClient: { refresh },
    fetch,
  });
  const provider = createLinearProgressProvider({
    client,
    connectionForLinearOrganization: lookup,
    readRunOutputContext: () => Promise.resolve(outputContext),
    clientSecret: "fake-client-secret",
  });
  async function authorize(target: ProgressDestination) {
    assert.equal(await provider.authorize(target.credential, scope, signal), "ok");
  }
  return { provider, connection, lookup, refresh, persist, lock, authorize, database };
}

const neverFetch = (): Promise<Response> => Promise.reject(new Error("unexpected Linear request"));

async function seedRun(database: Database) {
  const { run } = await database.createAcceptedTriggerRun({
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
  return run;
}

async function seedProgress(database: Database) {
  const run = await seedRun(database);
  const message = { organizationId: run.organizationId, triggerRunId: run.id };
  const now = new Date();
  await database.appendRunTimelineEvent({
    ...message,
    at: now,
    kind: "run_started",
    origin: "captured",
    data: {},
    maxEvents: 500,
  });
  await database.insertRunProgressMessageIfAbsent({ ...message, provider: "linear", now });
  const writer = new MessageWriter({
    database,
    clock: progressClock,
    settings: readRunProgressSettings({}),
    signal,
    backoff: new CredentialBackoff(),
    report: () => undefined,
  });
  return {
    message,
    writer,
    read: () => database.findRunProgressMessage(run.organizationId, run.id),
  };
}

describe("Linear run progress", () => {
  it.each(["create", "edit", "final"] as const)(
    "persists a missing write scope before attempting %s",
    async (operation) => {
      const fetch = vi.fn(neverFetch);
      const { provider, connection, database, refresh } = fixture(fetch);
      const { message, writer, read } = await seedProgress(database);
      if (operation !== "create") {
        const now = new Date();
        const owner = "seed";
        const lease = await database.acquireRunProgressLease({ ...message, now, owner });
        assert.ok(lease);
        await database.updateRunProgressMessage({
          ...message,
          now,
          owner,
          version: lease.version,
          patch: { state: "active", externalRef: ref },
        });
      }
      if (operation === "final") await database.succeedTriggerRun(message.triggerRunId);
      connection.scopes = [...LINEAR_REQUIRED_SCOPES];
      connection.accessTokenExpiresAt = new Date(0);
      const admit = vi.spyOn(database, "admitProgressWrite");
      await writer.write(message, provider);
      const row = await read();
      assert.equal(row?.state, "unavailable");
      assert.equal(row.failure, "scope_missing");
      assert.equal(admit.mock.calls.length, 0);
      assert.equal(refresh.mock.calls.length, 0);
      assert.equal(fetch.mock.calls.length, 0);
    },
  );

  it("warns once without provider content when Linear refuses an edit after creation", async () => {
    const providerContent = "provider details with fake-access-token";
    const fetch = vi
      .fn(neverFetch)
      .mockResolvedValueOnce(
        Response.json({ data: { commentCreate: { success: true, comment: { id: "comment" } } } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          errors: [{ message: providerContent, extensions: { code: "FORBIDDEN" } }],
        }),
      );
    const { provider, database } = fixture(fetch);
    const { message, writer, read } = await seedProgress(database);
    assert.equal((await writer.write(message, provider)).row?.state, "active");
    await database.succeedTriggerRun(message.triggerRunId);

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    let runtime: Awaited<ReturnType<typeof createApplicationRuntime>> | undefined;
    try {
      runtime = await createApplicationRuntime({
        database,
        auth: null,
        entitlements: createUnlimitedEntitlementsService(),
        billing: null,
        progressProviders: [provider],
        runProgress: readRunProgressSettings({
          PASEO_HUB_RUN_TIMELINE: "true",
          PASEO_HUB_PROGRESS_MESSAGES: "true",
        }),
        close: async () => undefined,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      assert.equal((await read())?.state, "unavailable");
      assert.equal((await read())?.failure, "scope_missing");
      assert.equal(fetch.mock.calls.length, 2);
      const warnings = warn.mock.calls.filter(
        ([, summary]) => summary === "run.progress.reporter failed",
      );
      assert.equal(warnings.length, 1);
      const record = JSON.stringify(warnings[0]);
      assert.match(record, /permissionMissing/u);
      assert.match(record, /scope_missing/u);
      assert.doesNotMatch(record, /provider details|fake-access-token|Paseo run:/u);
      assert.equal(
        error.mock.calls.filter(([, summary]) => summary === "run.progress.reporter failed").length,
        0,
      );
    } finally {
      await runtime?.stop();
      vi.useRealTimers();
      warn.mockRestore();
      error.mockRestore();
    }
  });

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
    const run = await seedRun(createMemoryDatabase());
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

  const uncertain = { status: "retry", afterMs: 0, notCreated: false, transient: true };

  it.each([
    {
      status: 404,
      message: "Forbidden",
      code: undefined,
      expected: { status: "gone" },
    },
    {
      status: 200,
      message: "Lookup failed",
      code: "ENTITY_NOT_FOUND",
      expected: { status: "gone" },
    },
    {
      status: 200,
      message: "Could not find the comment",
      code: undefined,
      expected: uncertain,
    },
    {
      status: 200,
      message: "Forbidden",
      code: undefined,
      expected: uncertain,
    },
    {
      status: 200,
      message: "Edit blocked",
      code: "FORBIDDEN",
      expected: { status: "unavailable", code: "scope_missing" },
    },
    {
      status: 403,
      message: "Edit blocked",
      code: undefined,
      expected: { status: "unavailable", code: "scope_missing" },
    },
    {
      status: 200,
      message: "Missing write scope",
      code: "BAD_USER_INPUT",
      expected: uncertain,
    },
    {
      status: 401,
      message: "Not authorized to access Linear",
      code: "FORBIDDEN",
      expected: { status: "unavailable", code: "reauthorize" },
    },
    {
      status: 200,
      message: "Not authorized to access Linear",
      code: "UNAUTHENTICATED",
      expected: { status: "unavailable", code: "reauthorize" },
    },
    {
      status: 500,
      message: "Forbidden during internal processing",
      code: "INTERNAL_SERVER_ERROR",
      expected: uncertain,
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

  it.each([
    ["INSUFFICIENT_SCOPE", "scope_missing"],
    ["INVALID_SCOPE", "scope_missing"],
    ["FORBIDDEN", "scope_missing"],
    ["PERMISSION_DENIED", "scope_missing"],
    ["ACCESS_DENIED", "scope_missing"],
    ["AUTHENTICATION_ERROR", "reauthorize"],
    ["UNAUTHENTICATED", "reauthorize"],
  ])(
    "treats structured %s as permanent on HTTP 200 for creates and edits",
    async (code, reason) => {
      const fetch = vi.fn(async () =>
        Response.json({
          errors: [
            { message: "Provider warning" },
            { message: "Mutation rejected", extensions: { code } },
          ],
        }),
      );
      const { provider, authorize } = fixture(fetch);
      const expected = { status: "unavailable", code: reason };
      await authorize(destination);
      assert.deepEqual(await provider.create(destination, "Started", signal), expected);
      await authorize(ref);
      assert.deepEqual(await provider.edit(ref, "Finished", signal), expected);
      assert.equal(fetch.mock.calls.length, 2);
    },
  );

  it.each([
    { status: 401, expected: { status: "unavailable", code: "reauthorize" } },
    { status: 403, expected: { status: "unavailable", code: "scope_missing" } },
    { status: 404, expected: { status: "gone" } },
  ])("classifies HTTP $status even with an oversized body", async ({ status, expected }) => {
    const body = "x".repeat(1024 * 1024 + 1);
    const fetch = vi.fn(async () => new Response(body, { status }));
    const { provider, authorize } = fixture(fetch);
    await authorize(destination);
    assert.deepEqual(await provider.create(destination, "Started", signal), expected);
    await authorize(ref);
    assert.deepEqual(await provider.edit(ref, "Finished", signal), expected);
    assert.equal(fetch.mock.calls.length, 2);
  });

  it("keeps a create with a GraphQL missing-target code uncertain", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        errors: [{ message: "Lookup failed", extensions: { code: "ENTITY_NOT_FOUND" } }],
      }),
    );
    const { provider, authorize } = fixture(fetch);
    await authorize(destination);
    assert.deepEqual(await provider.create(destination, "Started", signal), uncertain);
    assert.equal(fetch.mock.calls.length, 1);
  });

  it.each([400, 429])(
    "allows retry of an HTTP %i rate-limited create with no data",
    async (status) => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
          },
          { status, headers: { "retry-after": "9" } },
        ),
      );
      const { provider, authorize } = fixture(fetch);
      await authorize(destination);
      assert.deepEqual(await provider.create(destination, "Started", signal), {
        status: "retry",
        afterMs: 9_000,
        notCreated: true,
      });
      assert.equal(fetch.mock.calls.length, 1);
    },
  );

  const rateLimitError = { message: "Rate limited", extensions: { code: "RATELIMITED" } };
  const fieldError = { ...rateLimitError, path: ["commentCreate", "comment", "id"] };

  it.each([
    {
      name: "HTTP 400 with null data and an execution path",
      status: 400,
      body: JSON.stringify({ data: null, errors: [fieldError] }),
    },
    {
      name: "HTTP 429 with null data and an execution path",
      status: 429,
      body: JSON.stringify({ data: null, errors: [fieldError] }),
    },
    {
      name: "truncated HTTP 429 JSON",
      status: 429,
      body: '{"data":{"commentCreate":{"success":true',
    },
    {
      name: "HTTP 429 with null data alone",
      status: 429,
      body: JSON.stringify({ data: null, errors: [rateLimitError] }),
    },
    {
      name: "HTTP 400 with a path alone",
      status: 400,
      body: JSON.stringify({ errors: [fieldError] }),
    },
    {
      name: "HTTP 429 with no structured code",
      status: 429,
      body: JSON.stringify({ errors: [{ message: "Rate limited" }] }),
    },
    { name: "empty HTTP 429", status: 429, body: null },
  ])("keeps a create uncertain after one POST for $name", async ({ status, body }) => {
    const fetch = vi.fn(async () => new Response(body, { status }));
    const { provider, authorize } = fixture(fetch);
    await authorize(destination);
    assert.deepEqual(await provider.create(destination, "Started", signal), uncertain);
    assert.equal(fetch.mock.calls.length, 1);
  });

  it("treats an edit transport failure as transient", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("connection reset")));
    const { provider, authorize } = fixture(fetch);
    await authorize(ref);
    assert.deepEqual(await provider.edit(ref, "Finished", signal), uncertain);
    assert.equal(fetch.mock.calls.length, 1);
  });

  it("requires reauthorization when the refresh token grant is invalid", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, refresh, persist } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    const oauth = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const connectionClient = createLinearConnectionClient({
      clientId: "fake-client",
      clientSecret: "fake-secret",
      publicBaseUrl: "https://hub.test",
      fetch: oauth,
    });
    refresh.mockImplementationOnce((token, abort) => connectionClient.refresh(token, abort));
    await authorize(ref);
    assert.deepEqual(await provider.edit(ref, "Finished", signal), {
      status: "unavailable",
      code: "reauthorize",
    });
    assert.equal(oauth.mock.calls.length, 1);
    assert.equal(persist.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });

  it.each([200, 422])(
    "keeps a rate-limit code on HTTP %i uncertain even without data",
    async (status) => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }],
          },
          { status },
        ),
      );
      const { provider, authorize } = fixture(fetch);
      await authorize(destination);
      assert.deepEqual(await provider.create(destination, "Started", signal), uncertain);
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
    assert.deepEqual(await provider.create(destination, "Started", signal), uncertain);
    assert.equal(fetch.mock.calls.length, 1);
  });

  it.each([
    { ...ref, issueId: "other-issue", commentId: "other-issue-comment" },
    { ...ref, issueId: undefined },
    { ...ref, linearOrganizationId: "other-workspace", commentId: "other-workspace-comment" },
  ])("refuses a mismatched stored target for comment $commentId", async (stored) => {
    const fetch = vi.fn(neverFetch);
    const { provider, authorize } = fixture(fetch);
    await authorize(ref);
    const { issueId, ...fields } = stored;
    const target = issueId === undefined ? fields : { ...fields, issueId };
    assert.deepEqual(await provider.edit(target, "Finished", signal), {
      status: "refused",
      code: "target_mismatch",
    });
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("refuses a locator from a workspace other than the run's workspace", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, lookup } = fixture(fetch);
    assert.deepEqual(
      await provider.authorize(
        { ...credential, linearOrganizationId: "other-workspace" },
        scope,
        signal,
      ),
      { refused: "target_mismatch" },
    );
    assert.equal(lookup.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 0);
  });

  it("refuses a connection returned for a different workspace", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection } = fixture(fetch);
    connection.linearOrganizationId = "other-workspace";
    assert.deepEqual(await provider.authorize(credential, scope, signal), {
      refused: "target_mismatch",
    });
    assert.equal(fetch.mock.calls.length, 0);
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

  it("uses rotated tokens from the same binding at the final lookup", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer rotated-access-token");
      return Response.json({ data: { commentUpdate: { success: true } } });
    });
    const { provider, connection, authorize, lookup, refresh } = fixture(fetch);
    await authorize(ref);
    const selected = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    lookup.mockImplementationOnce(async () => {
      const snapshot = { ...connection };
      selected.resolve();
      await release.promise;
      return snapshot;
    });
    const edit = provider.edit(ref, "Finished", signal);
    await selected.promise;
    connection.accessToken = "rotated-access-token";
    connection.refreshToken = "rotated-refresh-token";
    connection.accessTokenExpiresAt = new Date(Date.now() + 3_600_000);
    release.resolve();
    assert.deepEqual(await edit, { status: "ok" });
    assert.equal(refresh.mock.calls.length, 0);
    assert.equal(fetch.mock.calls.length, 1);
  });

  it("refuses to create when the final lookup sees that write was removed", async () => {
    const fetch = vi.fn(neverFetch);
    const { provider, connection, authorize, lookup } = fixture(fetch);
    await authorize(destination);
    lookup.mockResolvedValueOnce({ ...connection });
    connection.scopes = [...LINEAR_REQUIRED_SCOPES];
    assert.deepEqual(await provider.create(destination, "Started", signal), {
      status: "unavailable",
      code: "scope_missing",
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
  it("lets an uncanceled follower refresh after a canceled leader", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer refreshed-token");
      return Response.json({ data: { commentUpdate: { success: true } } });
    });
    const { provider, connection, authorize, refresh, persist, lock } = fixture(fetch);
    connection.accessTokenExpiresAt = new Date(0);
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<{ accessToken: string }>();
    refresh.mockImplementationOnce(() => {
      refreshStarted.resolve();
      return releaseRefresh.promise;
    });

    const controller = new AbortController();
    await authorize(ref);
    const leader = assert.rejects(provider.edit(ref, "First edit", controller.signal), {
      name: "AbortError",
    });
    await refreshStarted.promise;
    const followerRef = { ...ref, credential: { ...credential } };
    await authorize(followerRef);
    const follower = provider.edit(followerRef, "Second edit", signal).then(
      (result) => result,
      (error: unknown) => ({ error }),
    );

    try {
      await vi.waitFor(() => assert.equal(lock.requested.mock.calls.length, 2));
      assert.equal(refresh.mock.calls.length, 1);
    } finally {
      controller.abort();
      releaseRefresh.resolve({ accessToken: "canceled-token" });
      await leader;
    }
    assert.deepEqual(await follower, { status: "ok" });
    assert.equal(refresh.mock.calls.length, 2);
    assert.deepEqual(persist.mock.calls, [[{ accessToken: "refreshed-token" }]]);
    assert.equal(fetch.mock.calls.length, 1);
  });
});
