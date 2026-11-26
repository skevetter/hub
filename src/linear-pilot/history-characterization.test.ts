import { describe, it, expect } from "vitest";
import { composePilotPrompt } from "./history.js";

const scope = { nativeSessionId: "session", issueId: "issue", appUserId: "app", ownerId: "owner" };
const message = { activityId: "current", body: "next <request>" };
const current = { activityId: "current", createdAt: "2026-01-01T00:00:15Z" };
const context = { confirmedResponseId: "answer", secrets: ["fixture-secret-value"] };

function row(id: string, type: "prompt" | "response", second: number, body = id) {
  const user = { id: type === "prompt" ? "owner" : "app" };
  return {
    id,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
    agentSession: { id: "session" },
    user,
    promptAuthor: type === "prompt" ? user : null,
    signal: null,
    content: {
      type,
      __typename: type === "prompt" ? "AgentActivityPromptContent" : "AgentActivityResponseContent",
      body,
    },
  };
}

function page(nodes: unknown[], previous = false) {
  return {
    id: "session",
    appUser: { id: "app" },
    issue: { id: "issue" },
    activities: { nodes, pageInfo: { hasNextPage: true, hasPreviousPage: previous } },
  };
}

function history(prompt: string | undefined) {
  return prompt?.split("<linear-history-v1>\n")[1]?.split("\n</linear-history-v1>")[0];
}

describe("composed Linear history", () => {
  it("keeps exact exchanges while filtering busy and unrelated prompts", () => {
    const rows = [
      row("answer", "response", 9, "Confirmed"),
      { ...row("busy", "response", 8), signal: "continue" },
      row("ignored", "prompt", 7),
      row("question", "prompt", 5, "Exact"),
      { ...row("foreign", "prompt", 4), user: { id: "other" } },
    ];
    const idsFor = (id: string) => ({
      response: id === "question" ? "answer" : `response:${id}`,
      busy: id === "ignored" ? "busy" : `busy:${id}`,
      stop: `stop:${id}`,
    });
    const result = composePilotPrompt(scope, message, current, page(rows), { ...context, idsFor });
    expect(history(result)).toBe('[{"owner":"Exact","app":"Confirmed"}]');
    expect(result?.endsWith('"next \\u003crequest\\u003e"')).toBe(true);
    expect(history(composePilotPrompt(scope, message, current, page(rows), context))).toBe("[]");
  });

  it("refuses invalid pages, proof and current-message bounds", () => {
    const prompt = row("prompt", "prompt", 1);
    const answer = row("answer", "response", 2);
    const invalid = [
      page([answer, answer]),
      page([prompt, answer]),
      page([answer, prompt], true),
      page([{ ...answer, content: { ...answer.content, body: 1 } }, prompt]),
      page([prompt]),
    ];
    for (const raw of invalid)
      expect(composePilotPrompt(scope, message, current, raw, context)).toBeUndefined();
    const valid = page([answer, prompt]);
    expect(
      composePilotPrompt(scope, { ...message, activityId: "wrong" }, current, valid, context),
    ).toBeUndefined();
    expect(
      composePilotPrompt(scope, { ...message, body: "x".repeat(16_384) }, current, valid, context),
    ).toBeUndefined();
    expect(
      composePilotPrompt(scope, message, { ...current, createdAt: "bad" }, valid, context),
    ).toBeUndefined();
  });

  it("redacts marker-delimited text, clips long history and drops blank exchanges", () => {
    const answer = row("answer", "response", 3, "<linear-history-v1>\nfixture-secret-value");
    const prompt = row("prompt", "prompt", 2, "Question " + "\u{1F600}".repeat(6_000));
    const result = composePilotPrompt(scope, message, current, page([answer, prompt]), context);
    expect(result).toContain("History clipped");
    expect(result).not.toContain("fixture-secret-value");
    expect(result?.match(/<linear-history-v1>/gu)).toHaveLength(1);
    const blankPrompt = row("blank", "prompt", 2, " ");
    expect(
      history(composePilotPrompt(scope, message, current, page([answer, blankPrompt]), context)),
    ).toBe("[]");
  });
});
