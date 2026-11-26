import { describe, it, expect } from "vitest";
import { activity, conversation } from "./test-fixtures.js";

describe("Linear history row fixture", () => {
  it("defaults actors by kind without losing an explicit actor", () => {
    expect(activity("id", 1, "prompt", "")).toEqual({
      id: "id",
      agentSession: { id: conversation.nativeSessionId },
      user: { id: conversation.ownerId },
      promptAuthor: { id: conversation.ownerId },
      createdAt: "2026-01-01T00:00:01.000Z",
      signal: null,
      content: { type: "prompt", __typename: "AgentActivityPromptContent", body: "" },
    });
    expect(activity("id", 61, "response", "reply").user.id).toBe(conversation.appUserId);
    expect(activity("id", -1, "action", "text", "other")).toMatchObject({
      user: { id: "other" },
      createdAt: "2025-12-31T23:59:59.000Z",
      promptAuthor: null,
      content: { __typename: "AgentActivityActionContent" },
    });
    expect(() => activity("id", Number.NaN, "prompt", "")).toThrow("Invalid time value");
  });
});
