import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { z } from "zod";
import { readPilotPriorPage } from "./history-read.js";

const scope = {
  sessionId: "linear-session",
  issueId: "linear-issue",
  appUserId: "installed-app",
  allowedHumanProviderUserId: "owner",
};

function row(
  id: string,
  second: number,
  type: "prompt" | "response",
  userId: string,
  body: string,
  signal: "continue" | null = null,
) {
  return {
    id,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    agentSession: { id: scope.sessionId },
    user: { id: userId },
    promptAuthor: type === "prompt" ? { id: userId } : null,
    signal,
    content: {
      __typename: type === "prompt" ? "AgentActivityPromptContent" : "AgentActivityResponseContent",
      type,
      body,
    },
  };
}

describe("pilot history transport", () => {
  it("preserves foreign and busy boundaries without forwarding their bodies", async () => {
    const olderRows = [
      {
        ...row("attributed-response", 5, "response", scope.appUserId, "unproven app body"),
        promptAuthor: { id: "other-human" },
      },
      row("busy-response", 4, "response", scope.appUserId, "busy body", "continue"),
      row("app-response", 3, "response", scope.appUserId, "expected response"),
      row("foreign-prompt", 2, "prompt", "other-human", "foreign prompt body"),
      row("owner-prompt", 1, "prompt", scope.allowedHumanProviderUserId, "expected prompt"),
    ];
    const before = "2026-01-01T00:00:06.000Z";
    const read = async <T>(
      query: string,
      variables: Record<string, unknown>,
      schema: z.ZodType<T>,
    ): Promise<T> => {
      assert.match(query, /createdAt: \{ lt: \$before \}/);
      assert.deepEqual(variables, { sessionId: scope.sessionId, before });
      return schema.parse({
        agentSession: {
          id: scope.sessionId,
          appUser: { id: scope.appUserId },
          issue: { id: scope.issueId },
          activities: {
            nodes: olderRows,
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          },
        },
      });
    };

    const result = await readPilotPriorPage(read, scope, before);
    assert.ok(result);
    assert.deepEqual(
      result.activities.nodes.map(({ id, user, signal, content }) => [
        id,
        user.id,
        signal,
        content.body,
      ]),
      [
        ["attributed-response", "installed-app", null, ""],
        ["busy-response", "installed-app", "continue", ""],
        ["app-response", "installed-app", null, "expected response"],
        ["foreign-prompt", "other-human", null, ""],
        ["owner-prompt", "owner", null, "expected prompt"],
      ],
    );
  });
});
