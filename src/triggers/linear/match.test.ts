import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedLinearCommentEvent, NormalizedLinearIssueEvent } from "./events.js";
import { matchLinearTriggers, readLinearCommentInvocationParserMessage } from "./match.js";

describe("Linear trigger matching", () => {
  it("ignores the installed app's reply with or without a named audience", () => {
    const event = {
      ...commentEvent(),
      actor: { id: "installed-app" },
    };
    const triggers = [
      { name: "named", on: "linear.comment_created", filters: { from_users: ["installed-app"] } },
      { name: "unrestricted", on: "linear.comment_created" },
    ];
    assert.deepEqual(matchLinearTriggers({ triggers }, event, undefined, "installed-app"), []);
  });

  it("starts a project scout exactly when an issue enters its eligible scope", () => {
    const config = configuration();
    const entered = issue({ action: "update", updatedFrom: { stateId: "backlog" } });
    assert.deepEqual(
      matchLinearTriggers(config, entered).map((match) => match.trigger.name),
      ["scout"],
    );

    const alreadyEligible = issue({ action: "update", updatedFrom: { stateId: "ready" } });
    assert.equal(matchLinearTriggers(config, alreadyEligible).length, 0);

    const irrelevantEdit = issue({ action: "update", updatedFrom: {} });
    assert.equal(matchLinearTriggers(config, irrelevantEdit).length, 0);

    const excluded = issue({ action: "create", labelIds: ["no-paseo"] });
    assert.equal(matchLinearTriggers(config, excluded).length, 0);
  });

  it("keeps assignment and comment triggers actor-allowlisted", () => {
    const config = configuration();
    const assigned = issue({ action: "update", updatedFrom: { assigneeId: null } });
    assert.deepEqual(
      matchLinearTriggers(config, assigned).map((match) => match.trigger.name),
      ["assignment"],
    );
    assert.equal(
      matchLinearTriggers(config, { ...assigned, actor: { id: "untrusted" } }).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(config, {
        ...assigned,
        actor: { id: "untrusted", name: "operator" },
      }).length,
      0,
    );
    assert.equal(
      matchLinearTriggers(config, {
        ...assigned,
        issue: { ...assigned.issue, assigneeId: null },
      }).length,
      0,
    );

    const comment = commentEvent();
    assert.deepEqual(
      matchLinearTriggers(config, comment).map((match) => match.trigger.name),
      ["comment"],
    );
    assert.equal(
      matchLinearTriggers(config, { ...comment, comment: { ...comment.comment, body: "hello" } })
        .length,
      0,
    );
  });

  it("starts the assigned trigger only on delegation to the installed app", () => {
    const config = {
      triggers: configuration().triggers.filter(
        (trigger) => trigger.on === "linear.issue_assigned",
      ),
    };
    const delegated = issue({
      action: "update",
      updatedFrom: { delegateId: null },
    });
    delegated.issue.delegateId = "installed-app";
    assert.deepEqual(
      matchLinearTriggers(config, delegated, undefined, "installed-app").map(
        (match) => match.trigger.name,
      ),
      ["assignment"],
    );
    for (const rejected of [
      { ...delegated, action: "create" as const },
      { ...delegated, action: "remove" as const },
      { ...delegated, updatedFrom: {} },
      { ...delegated, updatedFrom: { delegateId: "installed-app" } },
      { ...delegated, issue: { ...delegated.issue, delegateId: null } },
      { ...delegated, issue: { ...delegated.issue, delegateId: "another-app" } },
      { ...delegated, actor: { id: "untrusted" } },
      { ...delegated, issue: { ...delegated.issue, projectId: "another-project" } },
    ]) {
      assert.deepEqual(matchLinearTriggers(config, rejected, undefined, "installed-app"), []);
    }
    assert.deepEqual(matchLinearTriggers(config, delegated), []);
    const reassigned = { ...delegated, updatedFrom: { assigneeId: "previous-user" } };
    assert.deepEqual(
      matchLinearTriggers(config, reassigned, undefined, "another-app").map(
        (match) => match.trigger.name,
      ),
      ["assignment"],
    );
  });

  it("applies scope and actor filters to delegation without replacing the human assignee", () => {
    const config = {
      triggers: [
        {
          name: "assignment",
          on: "linear.issue_assigned",
          filters: {
            connectionId: "connection",
            project: "project-1",
            states: ["ready"],
            assignees: ["user-1"],
            labels: ["eligible"],
            exclude_labels: ["excluded"],
            from_users: ["operator"],
          },
        },
      ],
    };
    const delegated = issue({
      action: "update",
      updatedFrom: { delegateId: "previous-app" },
      labelIds: ["eligible"],
    });
    delegated.issue.delegateId = "installed-app";
    assert.deepEqual(
      matchLinearTriggers(config, delegated, "connection", "installed-app").map(
        (match) => match.trigger.name,
      ),
      ["assignment"],
    );
    assert.deepEqual(matchLinearTriggers(config, delegated, "another", "installed-app"), []);
    for (const changes of [
      { stateId: "backlog" },
      { assigneeId: null },
      { labelIds: [] },
      { labelIds: ["eligible", "excluded"] },
    ]) {
      assert.deepEqual(
        matchLinearTriggers(
          config,
          { ...delegated, issue: { ...delegated.issue, ...changes } },
          "connection",
          "installed-app",
        ),
        [],
      );
    }
  });

  it("keeps triggers isolated to their configured Linear connection", () => {
    const connectionId = "11111111-1111-4111-8111-111111111111";
    const config = configuration();
    const scopedConfig = Object.assign({}, config, {
      triggers: config.triggers.map((trigger) =>
        Object.assign({}, trigger, {
          filters: Object.assign({}, trigger.filters, { connectionId }),
        }),
      ),
    });

    const events = [
      {
        event: issue({ action: "update", updatedFrom: { stateId: "backlog" } }),
        expected: "scout",
      },
      {
        event: issue({ action: "update", updatedFrom: { assigneeId: null } }),
        expected: "assignment",
      },
      { event: commentEvent(), expected: "comment" },
    ];

    for (const { event, expected } of events) {
      assert.deepEqual(
        matchLinearTriggers(scopedConfig, event, connectionId).map((match) => match.trigger.name),
        [expected],
      );
      assert.equal(
        matchLinearTriggers(scopedConfig, event, "22222222-2222-4222-8222-222222222222").length,
        0,
      );
    }
  });
});

describe("Linear comment invocation parser handoff", () => {
  it.each([
    {
      name: "uses a later contains marker after a consumed pattern",
      filters: { pattern: "@paseo", contains: "/run" },
      body: "@paseo please /run priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "treats equal markers as one consumed marker",
      filters: { pattern: "@paseo", contains: "@paseo" },
      body: "@paseo priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "uses an overlapping contains marker that extends the pattern",
      filters: { pattern: "@paseo", contains: "@paseo /run" },
      body: "@paseo /run priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "keeps an input-shaped suffix of an overlapping contains marker",
      filters: { pattern: "@paseo", contains: "@paseo repo=hub" },
      body: "@paseo repo=hub priority=high investigate",
      expected: "repo=hub priority=high investigate",
    },
    {
      name: "uses the longer pattern when contains is inside it",
      filters: { pattern: "@paseo /run", contains: "/run" },
      body: "@paseo /run priority=high investigate",
      expected: "priority=high investigate",
    },
    {
      name: "uses the first boundary-valid repeated contains marker",
      filters: { pattern: "@paseo", contains: "/run" },
      body: "@paseo /run prose /run priority=high investigate",
      expected: "prose /run priority=high investigate",
    },
    {
      name: "does not treat an inside-word contains match as a marker",
      filters: { pattern: "@paseo", contains: "run" },
      body: "@paseo prerun priority=high investigate",
      expected: "prerun priority=high investigate",
    },
    {
      name: "does not bypass a non-boundary pattern prefix with contains",
      filters: { pattern: "@paseo", contains: "/run" },
      body: "@paseoX /run priority=high investigate",
      expected: "@paseoX /run priority=high investigate",
    },
    {
      name: "preserves a leading input-shaped pattern before a later command",
      filters: { pattern: "repo=hub", contains: "/run" },
      body: "repo=hub /run priority=high investigate",
      expected: "repo=hub priority=high investigate",
    },
  ])("$name", ({ filters, body, expected }) => {
    assert.equal(readLinearCommentInvocationParserMessage(commentEvent(body), filters), expected);
  });
});

function configuration() {
  const base = {
    id: "work",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "codex" },
    prompt: [{ text: "Work from ${{ paseo.context }}" }],
  };
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "scout",
        on: "linear.issue_entered_scope",
        max_runtime: "2h",
        filters: {
          project: "project-1",
          states: ["ready"],
          exclude_labels: ["no-paseo"],
        },
        steps: [base],
      },
      {
        name: "assignment",
        on: "linear.issue_assigned",
        max_runtime: "2h",
        filters: { project: "project-1", from_users: ["operator"] },
        steps: [base],
      },
      {
        name: "comment",
        on: "linear.comment_created",
        max_runtime: "2h",
        filters: { project: "project-1", from_users: ["operator"], contains: "@paseo" },
        steps: [base],
      },
    ],
  });
}

function issue(
  overrides: Partial<NormalizedLinearIssueEvent> & {
    labelIds?: string[];
  } = {},
): NormalizedLinearIssueEvent {
  const { labelIds, ...event } = overrides;
  return {
    type: "issue",
    action: "create",
    id: "issue-1",
    organizationId: "linear-org",
    actor: { id: "operator" },
    issue: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      projectId: "project-1",
      stateId: "ready",
      assigneeId: "user-1",
      labelIds: labelIds ?? [],
    },
    updatedFrom: {},
    ...event,
  };
}

function commentEvent(body = "@paseo please investigate"): NormalizedLinearCommentEvent {
  const event = issue();
  return {
    type: "comment",
    action: "create",
    id: "comment-1",
    organizationId: event.organizationId,
    actor: event.actor,
    comment: { id: "comment-1", issueId: event.issue.id, body },
    issue: event.issue,
  };
}
