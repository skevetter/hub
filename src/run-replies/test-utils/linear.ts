import { z } from "zod";
import type { Database, LinearConnectionRecord } from "../../db/types.js";
import { createLinearApiClient, LINEAR_REQUIRED_SCOPES } from "../../providers/linear/client.js";

const availableScopes = [...LINEAR_REQUIRED_SCOPES];
const requestSchema = z.object({
  query: z.string(),
  variables: z.object({
    id: z.string().optional(),
    issueId: z.string().optional(),
    body: z.string().optional(),
  }),
});

const target = { provider: "linear", linearOrganizationId: "linear-org", issueId: "issue" };
export const replyEvidence = {
  outputContext: target,
  triggerContext: {
    provider: "linear",
    target,
    event: {
      linear: {
        event_type: "comment",
        action: "create",
        connection_id: "connection",
        organization: { id: "linear-org" },
        issue: { id: "issue" },
        comment: { id: "source-comment", body: "@paseo question" },
      },
    },
  },
};

export function fakeLinearReplies(organizationId: string, database: Database) {
  const connection: LinearConnectionRecord = {
    id: "connection",
    organizationId,
    slug: "workspace",
    providerApplicationId: "app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Workspace",
    appUserId: "app-user",
    accessToken: "fake-reply-access-token",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: availableScopes,
  };
  const connectionForLinearOrganization = async (id: string) =>
    id === connection.linearOrganizationId ? { ...connection } : undefined;
  const comments = new Map([
    [
      "source-comment",
      {
        id: "source-comment",
        issue: { id: "issue" },
        body: "@paseo question",
        archivedAt: null,
        user: { id: "operator" },
      },
    ],
  ]);
  const calls: string[] = [];
  const writes: string[] = [];
  let loseResponse = false;
  const client = createLinearApiClient({
    connectionForLinearOrganization,
    withLinearConnectionRefresh: database.withLinearConnectionRefresh.bind(database),
    connectionClient: {
      async refresh() {
        throw new Error("unexpected token refresh");
      },
    },
    async fetch(_url, init) {
      if (typeof init?.body !== "string") throw new Error("expected a GraphQL request");
      const { query, variables } = requestSchema.parse(JSON.parse(init.body));
      if (query.includes("commentCreate(")) {
        const { id, issueId, body } = variables;
        if (id === undefined || issueId === undefined || body === undefined)
          throw new Error("reply mutation must use a reserved UUID");
        calls.push("create");
        writes.push(body);
        comments.set(id, {
          id,
          issue: { id: issueId },
          body,
          archivedAt: null,
          user: { id: connection.appUserId },
        });
        if (loseResponse) throw new Error("simulated response loss after Linear committed");
        return Response.json({ data: { commentCreate: { success: true, comment: { id } } } });
      }
      if (query.includes("comment(id:")) {
        calls.push("read-comment");
        const comment = comments.get(variables.id ?? "");
        return Response.json({ data: { comment: comment ?? null } });
      }
      throw new Error("unexpected Linear operation");
    },
  });
  return {
    client,
    connection,
    connectionForLinearOrganization,
    comments,
    calls,
    writes,
    loseCreateResponse() {
      loseResponse = true;
    },
  };
}
