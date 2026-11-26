import { describe, it, expect } from "vitest";
import type { z } from "zod";
import { readPilotPriorPage } from "./history-read.js";

const scope = {
  sessionId: "session",
  issueId: "issue",
  appUserId: "app",
  allowedHumanProviderUserId: "owner",
};
const boundary = "2026-01-01T00:00:03Z";

function row(id: string, type: "prompt" | "response", second: number) {
  const user = { id: type === "prompt" ? "owner" : "app" };
  return {
    id,
    createdAt: `2026-01-01T00:00:0${second}Z`,
    agentSession: { id: "session" },
    user,
    promptAuthor: type === "prompt" ? user : null,
    signal: null,
    content: {
      type,
      __typename: type === "prompt" ? "AgentActivityPromptContent" : "AgentActivityResponseContent",
      body: id,
    },
  };
}

function send(nodes: unknown[], previous = false) {
  return async <T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>) => {
    expect(query).toContain("createdAt: { lt: $before }");
    expect(variables).toEqual({ sessionId: "session", before: boundary });
    return schema.parse({
      agentSession: {
        id: "session",
        issue: { id: "issue" },
        appUser: { id: "app" },
        activities: { nodes, pageInfo: { hasNextPage: true, hasPreviousPage: previous } },
      },
    });
  };
}

describe("prior Linear history transport", () => {
  it("rejects invalid cutoffs before transport and rejects time, duplicate and scope errors", async () => {
    const reject = async (): Promise<never> => {
      throw new Error("unexpected fetch");
    };
    expect(await readPilotPriorPage(reject, scope, "invalid")).toBeUndefined();
    const prompt = row("prompt", "prompt", 1);
    const answer = row("answer", "response", 2);
    for (const nodes of [
      [row("late", "response", 3)],
      [prompt, answer],
      [answer, answer],
      [{ ...answer, agentSession: { id: "other" } }],
    ]) {
      expect(await readPilotPriorPage(send(nodes), scope, boundary)).toBeUndefined();
    }
    expect(await readPilotPriorPage(send([], true), scope, boundary)).toBeUndefined();
    await expect(readPilotPriorPage(reject, scope, boundary)).rejects.toThrow("unexpected fetch");
  });

  it("keeps equal-time rows in order and blanks every unapproved body", async () => {
    const prompt = row("prompt", "prompt", 1);
    const answer = row("answer", "response", 1);
    const nodes = [
      prompt,
      answer,
      { ...prompt, id: "other prompt", promptAuthor: { id: "other" } },
      { ...answer, id: "other response", user: { id: "other" } },
      { ...answer, id: "attributed response", promptAuthor: { id: "owner" } },
      { ...answer, id: "busy response", signal: "continue" },
    ];
    const page = await readPilotPriorPage(send(nodes), scope, boundary);
    expect(page?.activities.nodes.map(({ id, content }) => [id, content.body])).toEqual([
      ["prompt", "prompt"],
      ["answer", "answer"],
      ["other prompt", ""],
      ["other response", ""],
      ["attributed response", ""],
      ["busy response", ""],
    ]);
  });
});
