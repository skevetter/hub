import { expect, test } from "vitest";
import { DEFAULT_RECURRENCE } from "../schedule/recurrence.js";
import { describeTrigger } from "./describe.js";
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
