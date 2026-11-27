import { describe, expect, it, vi } from "vitest";
import type { ExternalTrigger } from "../index.js";
import type { NormalizedLinearCommentEvent, NormalizedLinearIssueEvent } from "./events.js";
import {
  matchLinearTriggers,
  matchesIssueScope,
  readLinearCommentInvocationParserMessage,
} from "./match.js";
import { createLinearTriggerProvider } from "./provider.js";

const issue = {
  id: "issue",
  title: "",
  description: null,
  projectId: "project",
  stateId: "ready",
  assigneeId: "operator",
  labelIds: ["ready"],
};
const base = { id: "event", organizationId: "org", actor: { id: "operator" }, issue };
const external: ExternalTrigger = {
  providerEventReceiptId: "receipt",
  organizationId: "org",
  projectId: "project",
  configurationRevisionId: "revision",
  source: "linear.comment",
  deliveryId: "delivery",
  receivedAt: new Date(0),
  payload: null,
};

function comment(body: string): NormalizedLinearCommentEvent {
  return {
    ...base,
    type: "comment",
    action: "create",
    comment: { body, id: "comment", issueId: issue.id },
  };
}

describe("Linear ingest behavior", () => {
  it.each([
    ["", { pattern: "", contains: "" }, ""],
    ["/runaway /go", { pattern: "/run", contains: "/go" }, "/runaway /go"],
    [
      "/run repo=hub\u2003\u2603",
      { pattern: "/run", contains: "repo=hub" },
      "repo=hub\u2003\u2603",
    ],
    ["/run now\u2003\u2603", { pattern: "/run now", contains: "now" }, "\u2603"],
    [
      "/run now repo=hub\u2003\u2603",
      { pattern: "/run now", contains: "now repo=hub" },
      "repo=hub\u2003\u2603",
    ],
    ["repo=hub /go\u2003\u2603", { pattern: "repo=hub", contains: "/go" }, "repo=hub \u2603"],
    ["skip/not /go " + "x".repeat(200_000), { contains: "/go" }, "x".repeat(200_000)],
  ] as const)("preserves marker parsing case %#", (body, filter, expected) => {
    expect(readLinearCommentInvocationParserMessage(comment(body), filter)).toBe(expected);
  });

  it("distinguishes scope entry from in-scope edits and filters unattached comments", () => {
    const event: NormalizedLinearIssueEvent = {
      ...base,
      type: "issue",
      action: "update",
      updatedFrom: { projectId: undefined, labelIds: undefined },
    };
    const filters = {
      connectionId: "route",
      project: "project",
      states: ["ready"],
      labels: ["ready"],
    };
    const config = { triggers: [{ name: "enter", on: "linear.issue_entered_scope", filters }] };
    expect(matchLinearTriggers(config, event, "route").map(({ trigger }) => trigger.name)).toEqual([
      "enter",
    ]);
    expect(matchLinearTriggers(config, { ...event, updatedFrom: {} }, "route")).toEqual([]);
    expect(matchesIssueScope({ ...issue, stateId: null }, filters, "route")).toBe(false);
    expect(matchesIssueScope(issue, filters, null)).toBe(false);
    expect(
      matchLinearTriggers(
        {
          triggers: [
            {
              name: "comment",
              on: "linear.comment_created",
              filters: { from_users: ["operator"] },
            },
          ],
        },
        { ...comment(""), issue: null },
      ),
    ).toEqual([]);
  });

  it("rejects invalid bodies before accessing configuration", async () => {
    const configurationStoreForProject = vi.fn(() => {
      throw new Error("unexpected store read");
    });
    const provider = createLinearTriggerProvider({ configurationStoreForProject });
    const payload = { ...comment(""), comment: { id: "comment", issueId: issue.id, body: null } };
    const matching = provider.match({ ...external, payload });
    await expect(matching).rejects.toHaveProperty("name", "ZodError");
    await expect(matching).rejects.toThrow("Invalid input: expected string, received null");
    expect(configurationStoreForProject).not.toHaveBeenCalled();
  });

  it("propagates configuration lookup exceptions unchanged", async () => {
    const fault = new Error("configuration lookup failed");
    const provider = createLinearTriggerProvider({
      configurationStoreForProject: () => {
        throw fault;
      },
    });
    await expect(provider.match({ ...external, payload: comment("") })).rejects.toBe(fault);
  });
});
