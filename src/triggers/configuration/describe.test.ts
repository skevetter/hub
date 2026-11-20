import { expect, test } from "vitest";
import { DEFAULT_RECURRENCE } from "../schedule/recurrence.js";
import { describeTrigger, describeTriggerYaml } from "./describe.js";
import { TriggerDocumentSchema } from "./schema.js";

const agent = {
  target: { daemon: "office", cwd: "/workspace" },
  agent: { provider: "codex", model: "example" },
  prompt: "PRIVATE INSTRUCTIONS",
};

test.each([
  [
    "GitHub",
    {
      "github.issue_comment_created": {
        filters: {
          from_users: ["alice"],
          repo: "acme/web",
          pattern: "/run",
          exclude_contains: "skip",
        },
      },
    },
    'When a comment is added to a GitHub issue from alice in repository acme/web and the comment starts with "/run" and the comment excludes "skip", run codex/example on host office.',
  ],
  [
    "Linear",
    {
      "linear.comment_created": {
        filters: {
          from_users: ["alice", "bob"],
          project: "project-x",
          contains: "run",
          exclude_labels: ["blocked"],
        },
      },
    },
    'When a comment is added to a Linear issue from alice or bob in project project-x without labels blocked and the comment contains "run", run codex/example on host office.',
  ],
  [
    "schedule",
    { "schedule.tick": { recurrence: DEFAULT_RECURRENCE } },
    "Every day at 09:00 (UTC), run codex/example on host office.",
  ],
  [
    "manual",
    { "manual.run": { filters: { from_users: ["hook-ci"] } } },
    "When a manual or webhook request arrives from hook-ci, run codex/example on host office.",
  ],
  [
    "notification",
    { "github.notification": { filters: { repo: "acme/web", reason: "review_requested" } } },
    'When a GitHub notification arrives in repository acme/web with reason "review_requested", run codex/example on host office.',
  ],
])("describes a %s trigger without including its prompt", (_kind, on, expected) => {
  expect(describeTrigger(TriggerDocumentSchema.parse({ name: "example", on, run: agent }))).toBe(
    expected,
  );
});

test("describes multiple events and the script action without including script text", () => {
  const on = {
    "schedule.tick": { recurrence: DEFAULT_RECURRENCE },
    "manual.run": { filters: { from_users: ["hook-ci"] } },
  };
  const run = { target: agent.target, script: "printf 'PRIVATE SCRIPT'" };
  expect(describeTrigger(TriggerDocumentSchema.parse({ name: "example", on, run }))).toBe(
    "Every day at 09:00 (UTC) or when a manual or webhook request arrives from hook-ci, run a script on host office.",
  );
});

test.each([
  ["prompt", "  agent: { provider: codex }\n  prompt: &private SYNTHETIC-PROMPT"],
  ["script", "  script: &private SYNTHETIC-SCRIPT"],
  [
    "environment",
    "  agent: { provider: codex }\n  prompt: Go.\n  env: { PRIVATE: &private SYNTHETIC-ENV }",
  ],
])("uses an opaque summary for a filter aliased to the %s", (_field, run) => {
  const yaml = `name: example
run:
  target: { daemon: office, cwd: /workspace }
${run}
on:
  github.notification:
    filters:
      repo: acme/web
      reason: review_requested
      contains: *private
`;
  const summary = describeTriggerYaml(yaml);
  expect(summary).toContain("a GitHub notification arrives");
  expect(summary).toContain("on host office");
  expect(summary).not.toContain("SYNTHETIC-");
});

test.each([
  ["manual.run", { from_users: [] }, "no callers can run this trigger"],
  ["slack.mention", { from_users: ["*"], channels: [] }, "no channels can match"],
  ["discord.mention", { from_users: ["*"], channels: [] }, "no channels can match"],
  ["github.push", { from_users: ["alice"] }, "push events carry no sender"],
])("explains why %s cannot match", (event, filters, message) => {
  const document = TriggerDocumentSchema.parse({
    name: "example",
    on: { [event]: { filters } },
    run: agent,
  });
  const summary = describeTrigger(document);
  expect(summary).toContain(message);
  expect(summary).not.toContain("from alice");
});

test("keeps an anchor in a visible field opaque when the prompt references it", () => {
  const summary = describeTriggerYaml(`name: example
on:
  github.notification:
    filters:
      contains: &private SYNTHETIC-CONTENT
run:
  target: { daemon: office, cwd: /workspace }
  agent: { provider: codex }
  prompt: *private
`);
  expect(summary).toContain("with additional configured filters");
  expect(summary).not.toContain("SYNTHETIC-CONTENT");
});

test("keeps aliased lists and execution fields opaque", () => {
  const summary = describeTriggerYaml(`name: example
run:
  target: { daemon: &host SYNTHETIC-HOST, cwd: /workspace }
  agent: { provider: codex, model: &model SYNTHETIC-MODEL }
  prompt: &private SYNTHETIC-PROMPT
  env: { HOST: *host, MODEL: *model }
on:
  manual.run:
    filters:
      from_users: [*private, alice]
`);
  expect(summary).toContain("with additional configured filters");
  expect(summary).toContain("run codex on the configured host");
  expect(summary).not.toContain("SYNTHETIC-");
});
