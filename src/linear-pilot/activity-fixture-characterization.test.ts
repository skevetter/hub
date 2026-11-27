import { describe, it, expect } from "vitest";
import { activity, conversation } from "./test-fixtures.js";

describe("Linear history row fixture", () => {
  it("defaults actors by kind without losing an explicit actor", () => {
    expect(activity({ id: "id", second: 1, kind: "prompt", body: "" })).toEqual({
      id: "id",
      agentSession: { id: conversation.nativeSessionId },
      user: { id: conversation.ownerId },
      promptAuthor: { id: conversation.ownerId },
      createdAt: "2026-01-01T00:00:01.000Z",
      signal: null,
      content: { type: "prompt", __typename: "AgentActivityPromptContent", body: "" },
    });
    expect(activity({ id: "id", second: 61, kind: "response", body: "reply" }).user.id).toBe(
      conversation.appUserId,
    );
    expect(
      activity({ id: "id", second: -1, kind: "action", body: "text", actor: "other" }),
    ).toMatchObject({
      user: { id: "other" },
      createdAt: "2025-12-31T23:59:59.000Z",
      promptAuthor: null,
      content: { __typename: "AgentActivityActionContent" },
    });
    expect(() => activity({ id: "id", second: Number.NaN, kind: "prompt", body: "" })).toThrow(
      "Invalid time value",
    );
  });
});
