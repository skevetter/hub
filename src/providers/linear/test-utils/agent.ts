import assert from "node:assert/strict";
import { z } from "zod";
import { createMemoryDatabase } from "../../../db/memory.js";
import type {
  Database,
  LinearConnectionRecord,
  LinearConnectionRefreshOperation,
} from "../../../db/types.js";
import { createLinearConnectionClient, LINEAR_REQUIRED_SCOPES } from "../client.js";

export const sessionId = "agent-session-a";
export const activityId = "b8bcd579-cad0-454e-9d1f-39a854e4914c";
export const hubUrl = "https://hub.example.test/o/example/sessions/hub-session-a";
export const completePage = { hasNextPage: false, hasPreviousPage: false };
export const pilotScopes = [...LINEAR_REQUIRED_SCOPES, "write"];

export function linearAgentConnection(suffix: string): LinearConnectionRecord {
  return {
    id: `connection-${suffix}`,
    organizationId: `hub-org-${suffix}`,
    slug: `connection-${suffix}`,
    providerApplicationId: "fake-shared-app",
    linearOrganizationId: `linear-org-${suffix}`,
    linearOrganizationName: `Synthetic workspace ${suffix}`,
    appUserId: `app-user-${suffix}`,
    accessToken: `fake-access-${suffix}`,
    refreshToken: `fake-refresh-${suffix}`,
    accessTokenExpiresAt: null,
    scopes: [...pilotScopes],
  };
}

export function linearAgentBinding(connection: LinearConnectionRecord) {
  const { id, organizationId, providerApplicationId, linearOrganizationId, appUserId } = connection;
  return { id, organizationId, providerApplicationId, linearOrganizationId, appUserId };
}

export function appViewer(connection: LinearConnectionRecord) {
  return {
    id: connection.appUserId,
    organization: { id: connection.linearOrganizationId },
    active: true,
    app: true,
    name: "Example Integration",
    displayName: "Example Agent",
  };
}

interface GraphqlCall {
  query: string;
  variables: Record<string, unknown>;
  bearer: string | null;
  redirect: RequestRedirect | undefined;
}

export function linearAgentFixture(
  respond: (operation: string, call: GraphqlCall) => unknown = () => {
    throw new Error("Unexpected GraphQL operation");
  },
) {
  const a = linearAgentConnection("a");
  const b = linearAgentConnection("b");
  const connections = new Map([a, b].map((row) => [row.linearOrganizationId, row]));
  const calls: GraphqlCall[] = [];
  const lookups: string[] = [];
  const refreshTokens: string[] = [];
  const approved = new Set([a.id, b.id]);
  const locks = createMemoryDatabase();
  const options = {
    hubBaseUrl: "https://hub.example.test",
    authorize: async ({ id }: { id: string }) => approved.has(id),
    connectionForLinearOrganization: async (id: string) => {
      lookups.push(id);
      return connections.get(id);
    },
    withLinearConnectionRefresh: function <T>(
      id: string,
      operation: LinearConnectionRefreshOperation<T>,
    ) {
      return locks.withLinearConnectionRefresh(id, () =>
        operation(connections.get(id), async (tokens) => {
          const current = connections.get(id);
          assert.ok(current);
          connections.set(id, { ...current, ...tokens });
        }),
      );
    } satisfies Database["withLinearConnectionRefresh"],
    fetch: async (url, init) => {
      assert.equal(url, "https://api.linear.app/graphql");
      assert.equal(init?.method, "POST");
      assert.ok(typeof init?.body === "string");
      const payload = z
        .object({
          query: z.string(),
          variables: z.record(z.string(), z.unknown()),
        })
        .parse(JSON.parse(init.body));
      const call = {
        ...payload,
        bearer: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      };
      calls.push(call);
      const operation = /^(?:query|mutation) (\w+)/u.exec(call.query)?.[1];
      assert.ok(operation);
      if (operation === "PaseoAgentViewer") {
        const override = viewerOverride;
        const connection = [...connections.values()].find(
          ({ accessToken }) => call.bearer === `Bearer ${accessToken}`,
        );
        assert.ok(connection);
        return Response.json({ data: { viewer: override ?? appViewer(connection) } });
      }
      return Response.json(respond(operation, call));
    },
  } satisfies { fetch: typeof fetch; [key: string]: unknown };
  let viewerOverride: ReturnType<typeof appViewer> | undefined;
  let refreshScopes = pilotScopes;
  const connectionClient = createLinearConnectionClient({
    clientId: "fake-shared-app",
    clientSecret: "fake-app-secret",
    publicBaseUrl: options.hubBaseUrl,
    fetch: async (url, init) => {
      assert.equal(url, "https://api.linear.app/oauth/token");
      assert.ok(init?.body instanceof URLSearchParams);
      const token = init.body.get("refresh_token");
      assert.ok(token);
      refreshTokens.push(token);
      return Response.json({
        access_token: "fake-rotated-access",
        refresh_token: "fake-rotated-refresh",
        expires_in: 3600,
        scope: refreshScopes.join(","),
      });
    },
  });
  return {
    a,
    b,
    calls,
    approved,
    connections,
    lookups,
    refreshTokens,
    options: { ...options, connectionClient },
    setViewer: (viewer: ReturnType<typeof appViewer>) => {
      viewerOverride = viewer;
    },
    setRefreshScopes: (scopes: string[]) => {
      refreshScopes = scopes;
    },
  };
}
