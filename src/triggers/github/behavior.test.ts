import { describe, expect, it } from "vitest";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { classifyGitHubEvent } from "./classification.js";
import { matchTriggers } from "./match.js";

function envelope(type: string, payload: Record<string, unknown>): NormalizedGitHubEvent {
  return {
    type,
    payload,
    id: "delivery",
    repo: "owner/repo",
    repositoryId: 7,
    installationId: 1,
    createdAt: "",
  };
}

describe("GitHub ingest behavior", () => {
  it("classifies malformed optional pull request fields without filling absent content", () => {
    expect(
      classifyGitHubEvent(
        envelope("pull_request", {
          action: "labeled",
          sender: null,
          label: { name: 3 },
          pull_request: {
            number: "12",
            draft: "false",
            head: null,
            labels: [null],
            user: { login: [] },
            title: "",
          },
        }),
      ),
    ).toEqual({
      semanticEvent: "github.pull_request_label_added",
      pullRequest: { draft: null, headSha: null },
      actor: "",
      text: "",
      labels: [],
      changedLabel: undefined,
      item: { type: "pull_request", number: null, title: "", body: null, url: null, author: null },
    });
  });

  it("keeps an explicit empty sender ahead of the comment author and preserves text", () => {
    const body = "\u2603" + "x".repeat(200_000);
    const input = envelope("issue_comment", {
      action: "created",
      sender: { login: "" },
      issue: { pull_request: {} },
      comment: { body, user: { login: "fallback" } },
    });
    expect(classifyGitHubEvent(input)).toMatchObject({
      semanticEvent: "github.pull_request_comment_created",
      actor: "",
      text: body,
      item: { type: "pull_request", author: null },
    });
  });

  it("preserves null payload validation errors", () => {
    const input = envelope("issue_comment", {});
    Reflect.set(input, "payload", null);
    expect(() => classifyGitHubEvent(input)).toThrow(
      "Invalid input: expected object, received null",
    );
  });

  it("combines route, actor, text and accent-sensitive label filters in trigger order", () => {
    const event = envelope("pull_request", {
      action: "labeled",
      sender: { login: "somebody" },
      label: { name: "Caf\u00e9" },
      pull_request: { title: "\u2603 investigate", labels: [{ name: "Caf\u00e9" }, {}] },
    });
    const filters = {
      from_users: ["*"],
      repo: "owner/repo",
      resourceId: "7",
      connectionId: "route",
      pattern: "\u2603",
      contains: "investigate",
      exclude_contains: "stop",
      label: "CAF\u00c9",
      labels: ["caf\u00e9"],
    };
    const on = "github.pull_request_label_added";
    const triggers = [
      { name: "missing", on },
      { name: "first", on, filters },
      { name: "accent", on, filters: { ...filters, label: "cafe" } },
      { name: "empty", on, filters: { ...filters, from_users: [] } },
      { name: "id", on, filters: { ...filters, resourceId: "8" } },
      { name: "exclusion", on, filters: { ...filters, exclude_contains: "investigate" } },
      { name: "second", on, filters: { ...filters, labels: [] } },
    ];
    expect(matchTriggers({ triggers }, event, "route").map(({ trigger }) => trigger.name)).toEqual([
      "first",
      "second",
    ]);
    expect(matchTriggers({ triggers }, event, null)).toEqual([]);
  });
});
