import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type {
  Database,
  LinearConnectionRecord,
  LinearConnectionTokenUpdate,
  UpdateLinearConnectionTokensInput,
} from "../../db/types.js";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  createLinearApiClient,
  createLinearConnectionClient,
  hasRequiredLinearScopes,
  LinearApiError,
  LinearTransportError,
  LINEAR_REQUIRED_SCOPES,
  type LinearApiClient,
  linearConnectionRequiresReauthorization,
} from "./client.js";

describe("Linear connection client", () => {
  it("uses an OAuth callback URL and records the installed workspace identity", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test/base",
      now: () => new Date(1_700_000_000_000),
      fetch: async (url, init) => {
        const requestUrl = readableUrl(url);
        requests.push({ url: requestUrl, body: readableBody(init?.body) });
        if (requestUrl.endsWith("/oauth/token")) {
          return json({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: "read,comments:create",
          });
        }
        return json({
          data: { viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } } },
        });
      },
    });

    const authorization = new URL(client.authorizationUrl("state-value"));
    assert.equal(authorization.origin, "https://linear.app");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      "https://hub.test/api/integrations/linear/callback",
    );
    assert.equal(
      authorization.searchParams.get("scope"),
      "read,comments:create,app:assignable,app:mentionable",
    );
    assert.equal(authorization.searchParams.get("actor"), "app");
    assert.equal(authorization.searchParams.get("state"), "state-value");
    assert.equal(authorization.searchParams.get("prompt"), "consent");

    assert.deepEqual(await client.exchangeCode("code-value"), {
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_003_600_000),
      scopes: ["comments:create", "read"],
    });
    assert.match(requests[0]?.body ?? "", /code=code-value/u);
  });

  it("keeps requested scopes when Linear omits them during authorization", async () => {
    const client = createLinearConnectionClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      publicBaseUrl: "https://hub.test",
      fetch: async (url) => {
        if (readableUrl(url).endsWith("/oauth/token")) {
          return json({ access_token: "access-token", refresh_token: "refresh-token" });
        }
        return json({
          data: { viewer: { id: "app-user", organization: { id: "linear-org", name: "Acme" } } },
        });
      },
    });

    const installation = await client.exchangeCode("code-value");

    assert.deepEqual(installation.scopes, [
      "read",
      "comments:create",
      "app:assignable",
      "app:mentionable",
    ]);
  });

  it("reads a bounded, chronological history before the triggering comment", async () => {
    const requests: Array<{ authorization: string | null; body: string }> = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: null,
      scopes: ["comments:create", "read"],
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      withLinearConnectionRefresh: withinLinearRefresh(connection, async () => {}),
      connectionClient: { refresh: async () => ({ accessToken: "unused" }) },
      fetch: async (_url, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: readableBody(init?.body),
        });
        return json({
          data: {
            comments: {
              nodes: [
                {
                  id: "comment-2",
                  body: "second",
                  createdAt: "2023-11-14T22:13:19.002Z",
                  user: { id: "user-2", name: "Paseo" },
                },
                {
                  id: "comment-1",
                  body: "first",
                  createdAt: "2023-11-14T22:13:19.001Z",
                  user: null,
                },
              ],
              pageInfo: { hasPreviousPage: true },
            },
          },
        });
      },
    });

    const history = await api.readIssueComments({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      beforeCreatedAt: "2023-11-14T22:13:19.003Z",
    });

    assert.deepEqual(history, {
      complete: false,
      comments: [
        {
          id: "comment-1",
          body: "first",
          createdAt: "2023-11-14T22:13:19.001Z",
          author: null,
        },
        {
          id: "comment-2",
          body: "second",
          createdAt: "2023-11-14T22:13:19.002Z",
          author: { id: "user-2", name: "Paseo" },
        },
      ],
    });
    assert.equal(requests[0]?.authorization, "Bearer access-token");
    const request = graphqlRequest(requests[0]?.body ?? "{}");
    assert.match(request.query, /last: 49/u);
    assert.match(request.query, /orderBy: createdAt/u);
    assert.match(request.query, /createdAt: \{ lt: \$before \}/u);
    assert.deepEqual(request.variables, {
      issueId: "issue-1",
      before: "2023-11-14T22:13:19.003Z",
    });
  });

  it("refreshes an expired token before calling the Linear GraphQL API", async () => {
    const updates: unknown[] = [];
    const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const updateTokens = async (update: UpdateLinearConnectionTokensInput) => {
      updates.push(update);
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      withLinearConnectionRefresh: withinLinearRefresh(connection, updateTokens),
      connectionClient: {
        refresh: async () => ({
          accessToken: "fresh-token",
          refreshToken: "next-refresh-token",
          accessTokenExpiresAt: new Date(1_700_003_600_000),
          scopes: ["comments:create", "read"],
        }),
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (url, init) => {
        requests.push({
          url: readableUrl(url),
          authorization: new Headers(init?.headers).get("authorization"),
          body: readableBody(init?.body),
        });
        return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
      },
    });

    const commentId = await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Done",
    });
    assert.equal(commentId, "comment-1");
    assert.match(graphqlRequest(requests[0]!.body).query, /comment\s*\{\s*id\s*\}/u);
    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-refresh-token",
        accessTokenExpiresAt: new Date(1_700_003_600_000),
        scopes: ["comments:create", "read"],
      },
    ]);
    assert.equal(requests[0]?.authorization, "Bearer fresh-token");
    assert.match(requests[0]?.body ?? "", /commentCreate/u);
  });

  it("clears a stale expiry when Linear omits it from a refresh response", async () => {
    const updates: unknown[] = [];
    let tokenRequests = 0;
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const request: typeof fetch = async (url) => {
      if (readableUrl(url).endsWith("/oauth/token")) {
        tokenRequests += 1;
        return json({ access_token: "fresh-token" });
      }
      return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
    };
    const updateTokens = async (update: UpdateLinearConnectionTokensInput) => {
      updates.push(update);
      connection.accessToken = update.accessToken;
      if (update.refreshToken !== undefined) connection.refreshToken = update.refreshToken;
      if (update.accessTokenExpiresAt !== undefined)
        connection.accessTokenExpiresAt = update.accessTokenExpiresAt;
      if (update.scopes !== undefined) connection.scopes = update.scopes;
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => connection,
      withLinearConnectionRefresh: withinLinearRefresh(connection, updateTokens),
      connectionClient: createLinearConnectionClient({
        clientId: "client-id",
        clientSecret: "client-secret",
        publicBaseUrl: "https://hub.test",
        fetch: request,
        now: () => new Date(1_700_000_010_000),
      }),
      fetch: request,
      now: () => new Date(1_700_000_010_000),
    });

    await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Done",
    });
    await api.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "Still done",
    });

    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        accessTokenExpiresAt: null,
      },
    ]);
    assert.equal(tokenRequests, 1);
  });

  it("coalesces concurrent refreshes for one Linear connection", async () => {
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const updates: unknown[] = [];
    const requests: string[] = [];
    let connectionReads = 0;
    let releaseConnections!: () => void;
    let markBothConnectionsRead!: () => void;
    let releaseRefresh!: (value: { accessToken: string; refreshToken: string }) => void;
    let markRefreshStarted!: () => void;
    const connectionsReleased = new Promise<void>((resolve) => {
      releaseConnections = resolve;
    });
    const bothConnectionsRead = new Promise<void>((resolve) => {
      markBothConnectionsRead = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshed = new Promise<{ accessToken: string; refreshToken: string }>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const updateTokens = async (update: UpdateLinearConnectionTokensInput) => {
      updates.push(update);
    };
    const api = createLinearApiClient({
      connectionForLinearOrganization: async () => {
        connectionReads += 1;
        if (connectionReads === 2) markBothConnectionsRead();
        await connectionsReleased;
        return connection;
      },
      withLinearConnectionRefresh: withinLinearRefresh(connection, updateTokens),
      connectionClient: {
        refresh: async () => {
          refreshCalls += 1;
          markRefreshStarted();
          return refreshed;
        },
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (_url, init) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
      },
    });

    const operations = [
      api.createComment({ linearOrganizationId: "linear-org", issueId: "issue-1", body: "One" }),
      api.createComment({ linearOrganizationId: "linear-org", issueId: "issue-2", body: "Two" }),
    ];
    await bothConnectionsRead;
    releaseConnections();
    await refreshStarted;

    assert.equal(refreshCalls, 1);
    releaseRefresh({ accessToken: "fresh-token", refreshToken: "next-refresh-token" });
    await Promise.all(operations);

    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-refresh-token",
      },
    ]);
    assert.deepEqual(requests, ["Bearer fresh-token", "Bearer fresh-token"]);
  });

  it("serializes rotating-token refreshes across Linear API clients", async () => {
    const locks = createMemoryDatabase();
    const lockKeys: string[] = [];
    const connection: LinearConnectionRecord = {
      id: "connection-1",
      organizationId: "hub-org",
      slug: "acme-linear",
      providerApplicationId: "linear-app",
      linearOrganizationId: "linear-org",
      linearOrganizationName: "Acme",
      appUserId: "app-user",
      accessToken: "expired-token",
      refreshToken: "rotating-refresh-token",
      accessTokenExpiresAt: new Date(1_700_000_000_000),
      scopes: ["comments:create", "read"],
    };
    const updates: unknown[] = [];
    const requests: string[] = [];
    let connectionReads = 0;
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    let markSecondInitialRead!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const secondInitialRead = new Promise<void>((resolve) => {
      markSecondInitialRead = resolve;
    });
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const connectionForLinearOrganization = async () => {
      connectionReads += 1;
      if (connectionReads === 2) markSecondInitialRead();
      return connection;
    };
    const updateTokens = async (update: {
      connectionId: string;
      accessToken: string;
      refreshToken?: string | null;
      accessTokenExpiresAt?: Date | null;
      scopes?: string[];
    }) => {
      updates.push(update);
      connection.accessToken = update.accessToken;
      if (update.refreshToken !== undefined) connection.refreshToken = update.refreshToken;
      if (update.accessTokenExpiresAt !== undefined)
        connection.accessTokenExpiresAt = update.accessTokenExpiresAt;
      if (update.scopes !== undefined) connection.scopes = update.scopes;
    };
    const withLinearConnectionRefresh: Database["withLinearConnectionRefresh"] = async (
      linearOrganizationId,
      operation,
    ) => {
      const key = JSON.stringify(["paseo-connection", "linear", "external", linearOrganizationId]);
      lockKeys.push(key);
      const updateWithinRefresh = (input: LinearConnectionTokenUpdate) =>
        updateTokens({ connectionId: connection.id, ...input });
      return locks.withAdvisoryLock(key, () => operation(connection, updateWithinRefresh));
    };
    const sharedOptions = {
      connectionForLinearOrganization,
      withLinearConnectionRefresh,
      connectionClient: {
        refresh: async () => {
          refreshCalls += 1;
          markRefreshStarted();
          await refreshReleased;
          return {
            accessToken: "fresh-token",
            refreshToken: "next-rotating-refresh-token",
            accessTokenExpiresAt: new Date(1_700_003_600_000),
          };
        },
      },
      now: () => new Date(1_700_000_010_000),
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? "");
        return json({ data: { commentCreate: { success: true, comment: { id: "comment-1" } } } });
      },
    };
    const firstProcess = createLinearApiClient(sharedOptions);
    const secondProcess = createLinearApiClient(sharedOptions);

    const first = firstProcess.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-1",
      body: "One",
    });
    await refreshStarted;
    const second = secondProcess.createComment({
      linearOrganizationId: "linear-org",
      issueId: "issue-2",
      body: "Two",
    });
    await secondInitialRead;
    releaseRefresh();
    await Promise.all([first, second]);

    assert.equal(refreshCalls, 1);
    assert.equal(connectionReads, 2);
    assert.deepEqual(lockKeys, [
      '["paseo-connection","linear","external","linear-org"]',
      '["paseo-connection","linear","external","linear-org"]',
    ]);
    assert.deepEqual(updates, [
      {
        connectionId: "connection-1",
        accessToken: "fresh-token",
        refreshToken: "next-rotating-refresh-token",
        accessTokenExpiresAt: new Date(1_700_003_600_000),
      },
    ]);
    assert.deepEqual(requests, ["Bearer fresh-token", "Bearer fresh-token"]);
  });

  it("requires each agent scope while preserving the recorded grants", () => {
    const scopes = ["read", "comments:create", "app:assignable", "app:mentionable"];
    assert.equal(hasRequiredLinearScopes([...scopes, "write"]), true);
    for (const missing of scopes) {
      const granted = scopes.filter((scope) => scope !== missing);
      const connection = {
        scopes: granted,
        refreshToken: "refresh-token",
        accessTokenExpiresAt: null,
      };
      assert.equal(hasRequiredLinearScopes(granted), false, missing);
      assert.equal(linearConnectionRequiresReauthorization(connection), true, missing);
      assert.deepEqual(connection.scopes, granted);
    }
    assert.equal(
      linearConnectionRequiresReauthorization({
        scopes,
        refreshToken: "refresh-token",
        accessTokenExpiresAt: null,
      }),
      false,
    );
  });
});

const progressWrite = {
  binding: {
    id: "connection",
    organizationId: "hub-org",
    linearOrganizationId: "linear-org",
    providerApplicationId: "linear-app",
    appUserId: "app-user",
  },
  signal: new AbortController().signal,
};
const commentInput = { linearOrganizationId: "linear-org", issueId: "issue", body: "Run" };

describe("Linear comment mutations", () => {
  it("updates the comment using the stored id and the new body", async () => {
    const api = commentApi(async (_url, init) => {
      const { query, variables } = graphqlRequest(readableBody(init?.body));
      assert.match(query, /commentUpdate\(id: \$id, input: \{ body: \$body \}\)/u);
      assert.deepEqual(variables, { id: "stored-comment", body: "Finished" });
      return json({ data: { commentUpdate: { success: true } } });
    });
    await api.updateComment({
      linearOrganizationId: "linear-org",
      commentId: "stored-comment",
      body: "Finished",
    });
  });

  it.each<{ status: number; headers: HeadersInit; delay: number }>([
    {
      status: 400,
      headers: {
        "x-ratelimit-requests-remaining": "1",
        "x-ratelimit-requests-reset": "1700000090000",
        "x-ratelimit-endpoint-requests-remaining": "0",
        "x-ratelimit-endpoint-requests-reset": "1700000004500",
      },
      delay: 4500,
    },
    {
      status: 429,
      headers: { "retry-after": "12", "x-ratelimit-requests-reset": "1700000090000" },
      delay: 12000,
    },
  ])(
    "reports Linear rate limits on HTTP $status without retrying",
    async ({ status, headers, delay }) => {
      let requests = 0;
      const api = commentApi(async () => {
        requests += 1;
        return Response.json(
          { errors: [{ message: "Too many requests", extensions: { code: "RATELIMITED" } }] },
          { status, headers },
        );
      });
      await assert.rejects(
        api.createComment(commentInput, progressWrite),
        (error) =>
          error instanceof LinearApiError &&
          error.status === status &&
          error.code === "RATELIMITED" &&
          error.retryAfterMs === delay,
      );
      assert.equal(requests, 1);
    },
  );

  it.each([undefined, progressWrite])(
    "fails on 503 headers without reading an open body",
    async (write) => {
      const stream = openBody();
      const api = commentApi(async () => new Response(stream.body, { status: 503 }));
      await assert.rejects(
        api.createComment(commentInput, write),
        (error) => error instanceof LinearApiError && error.status === 503,
      );
      assert.equal(stream.pull.mock.calls.length, 0);
      assert.equal(stream.cancel.mock.calls.length, 1);
    },
  );

  it.each([200, 429])("limits the size of an HTTP %i response body", async (status) => {
    const api = commentApi(async () => new Response("x".repeat(1024 * 1024 + 1), { status }));
    await assert.rejects(
      api.createComment(commentInput, progressWrite),
      (error) =>
        error instanceof LinearTransportError &&
        error.cause instanceof Error &&
        /exceeds 1 MiB/u.test(error.cause.message),
    );
  });

  it.each([200, 429])("cancels an open HTTP %i body at the read deadline", async (status) => {
    vi.useFakeTimers();
    try {
      const stream = openBody();
      const api = commentApi(async () => new Response(stream.body, { status }));
      const failed = assert.rejects(
        api.createComment(commentInput, progressWrite),
        (error) =>
          error instanceof LinearTransportError &&
          error.cause instanceof Error &&
          /timed out/u.test(error.cause.message),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      assert.equal(stream.pull.mock.calls.length, 1);
      assert.equal(stream.cancel.mock.calls.length, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports GraphQL errors even when Linear returns HTTP 200 and data", async () => {
    const api = commentApi(async () =>
      json({
        data: { commentUpdate: { success: true } },
        errors: [{ message: "Permission denied", extensions: { code: "FORBIDDEN" } }],
      }),
    );
    await assert.rejects(
      api.updateComment({ linearOrganizationId: "linear-org", commentId: "comment", body: "Run" }),
      (error) =>
        error instanceof LinearApiError &&
        error.status === 200 &&
        error.code === "FORBIDDEN" &&
        error.retryAfterMs === undefined,
    );
  });
});

function openBody() {
  const pull = vi.fn(() => new Promise<void>(() => {}));
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { body, pull, cancel };
}

function commentApi(fetch: typeof globalThis.fetch): LinearApiClient {
  const connection: LinearConnectionRecord = {
    id: "connection",
    organizationId: "hub-org",
    slug: "acme-linear",
    providerApplicationId: "linear-app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Acme",
    appUserId: "app-user",
    accessToken: "access-token",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: [...LINEAR_REQUIRED_SCOPES, "write"],
  };
  return createLinearApiClient({
    connectionForLinearOrganization: async () => connection,
    withLinearConnectionRefresh: withinLinearRefresh(connection, async () => {}),
    connectionClient: {
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
    },
    now: () => new Date(1_700_000_000_000),
    fetch,
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function withinLinearRefresh(
  connection: LinearConnectionRecord,
  updateTokens: (input: UpdateLinearConnectionTokensInput) => Promise<void>,
): Database["withLinearConnectionRefresh"] {
  return async (_linearOrganizationId, operation) =>
    operation(connection, (input) => updateTokens({ connectionId: connection.id, ...input }));
}

function readableUrl(value: RequestInfo | URL): string {
  if (typeof value === "string") return value;
  return value instanceof URL ? value.toString() : value.url;
}

function readableBody(value: BodyInit | null | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof URLSearchParams) return value.toString();
  return "";
}

function graphqlRequest(value: string): { query: string; variables: unknown } {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("query" in parsed) ||
    typeof parsed.query !== "string"
  ) {
    throw new Error("expected GraphQL request");
  }
  return { query: parsed.query, variables: "variables" in parsed ? parsed.variables : undefined };
}
