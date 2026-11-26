import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_RECURRENCE } from "../schedule/recurrence.js";
import { describeTrigger } from "./describe.js";
import { TriggerDocumentSchema, type TriggerDocument } from "./schema.js";

const run = {
  target: { daemon: "office", cwd: "/workspace" },
  agent: { provider: "codex", model: "example" },
  prompt: "Run the task.",
};

function document(on: TriggerDocument["on"]): TriggerDocument {
  return TriggerDocumentSchema.parse({ name: "example", on, run });
}

test("checks filter literalness before excluding blocked events", () => {
  const input = document({
    "manual.run": { filters: { from_users: [] } },
    "slack.mention": { filters: { channels: [] } },
    "discord.mention": { filters: { channels: [] } },
    "github.push": { filters: { from_users: [] } },
    "custom.signal": {},
  });
  const paths: string[] = [];
  const summary = describeTrigger(input, (path) => {
    const key = path.join("/");
    paths.push(key);
    return !["on/manual.run/filters/from_users", "on/custom.signal"].includes(key);
  });
  assert.equal(
    summary,
    "When a configured event arrives, run codex/example on host office, while for manual and webhook requests, no callers can run this trigger, for Slack mentions, no channels can match, for Discord mentions, no channels can match, or a named sender filter cannot match because push events carry no sender.",
  );
  assert.deepEqual(paths, [
    "on/manual.run",
    "on/manual.run/filters/from_users",
    "on/slack.mention",
    "on/slack.mention/filters/channels",
    "on/discord.mention",
    "on/discord.mention/filters/channels",
    "on/github.push",
    "on/github.push/filters/from_users",
    "on/custom.signal",
    "run/target/daemon",
    "run/agent/provider",
    "run/agent/model",
  ]);
});

test("does not read the run when all events are blocked", () => {
  const input = document({ "manual.run": { filters: { from_users: [] } } });
  assert.equal(
    describeTrigger(input, ([root]) => {
      assert.equal(root, "on");
      return true;
    }),
    "For manual and webhook requests, no callers can run this trigger.",
  );
});

test("prefers the original command pattern even when it is opaque", () => {
  const input = document({
    "slack.mention": {
      filters: { from_users: ["alice", "*"], pattern: "private", contains: "fallback" },
    },
  });
  assert.equal(
    describeTrigger(input, (path) => path.at(-1) !== "pattern"),
    "When the app is mentioned in Slack with additional configured filters, run codex/example on host office.",
  );
  assert.equal(
    describeTrigger(input),
    'When the app is mentioned in Slack with command prefix "private", run codex/example on host office.',
  );
  input.on["slack.mention"] = { filters: { contains: "fallback" } };
  assert.equal(
    describeTrigger(input),
    'When the app is mentioned in Slack with command prefix "fallback", run codex/example on host office.',
  );
});

test("formats list, text and object qualifiers and omits empty and unknown filters", () => {
  const input = document({
    "linear.issue_entered_scope": {
      filters: {
        from_users: ["alice", "bob"],
        project: "ops",
        states: ["open", "active"],
        labels: ["required", "urgent"],
        exclude_labels: ["quiet", "done"],
        inputs: { enabled: true },
      },
    },
    "github.issues": { filters: { label: "triage", contains: "", inputs: {} } },
    "custom.signal": { filters: { repo: "ignored" } },
  });
  assert.equal(
    describeTrigger(input),
    'When a Linear issue enters the configured scope from alice or bob in project ops with workflow states open or active with required labels required and urgent without labels quiet or done with matching inputs, when a GitHub issue event arrives with added label "triage", or when a custom.signal event arrives, run codex/example on host office.',
  );
});

test("respects opacity for schedule and reply fields", () => {
  const schedule = document({ "schedule.tick": { recurrence: DEFAULT_RECURRENCE } });
  assert.equal(
    describeTrigger(
      schedule,
      (path) => !["recurrence", "daemon", "provider"].includes(path.at(-1) ?? ""),
    ),
    "On the configured schedule, run the selected agent on the configured host.",
  );
  const linear = document({
    "linear.comment_created": { filters: { from_users: ["alice"] } },
  });
  linear.reply_message = true;
  const clause =
    "When a comment is added to a Linear issue from alice, run codex/example on host office.";
  assert.equal(
    describeTrigger(linear),
    `${clause} Post the agent's final reply on the source Linear issue after a successful run.`,
  );
  assert.equal(
    describeTrigger(linear, (path) => path[0] !== "reply_message"),
    clause,
  );
});
