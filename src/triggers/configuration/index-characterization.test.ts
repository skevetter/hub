import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { agentStep, isScriptStep } from "../../config/compiler.js";
import { compileTriggerDocument, migrateLegacyBundle, TriggerDocumentError } from "./index.js";

const run = {
  target: { daemon: "devbox", cwd: "/workspace" },
  agent: { provider: "codex" },
  prompt: "Handle the request.",
};

test("names manual events ahead of earlier events and retains the exact source hash", () => {
  const yaml = JSON.stringify({
    name: "example",
    inputs: { topic: { type: "string", default: "support" } },
    on: {
      "slack.mention": { connection: "slack", filters: { from_users: ["alice"] } },
      "manual.run": { filters: { from_users: [] } },
      "discord.mention": { filters: { from_users: ["bob"] } },
    },
    run,
  });
  const result = compileTriggerDocument(yaml);
  assert.equal(result.authoredHash, createHash("sha256").update(yaml).digest("hex"));
  assert.notEqual(compileTriggerDocument(`${yaml}\n`).authoredHash, result.authoredHash);
  assert.deepEqual(
    result.events.map(({ name, filters, steps }) => [
      name,
      filters,
      agentStep(steps[0]).allowOutputs,
    ]),
    [
      [
        "example-event-1",
        { connection: "slack", from_users: ["alice"] },
        [{ type: "slack.reply", required: false }],
      ],
      ["example", { from_users: [] }, []],
      ["example-event-3", { from_users: ["bob"] }, [{ type: "discord.reply", required: false }]],
    ],
  );
  assert.deepEqual(result.events[0]?.inputs, {
    topic: { type: "string", default: "support", required: false },
  });
});

test("retains optional agent settings and an explicit native reply grant", () => {
  const result = compileTriggerDocument(
    JSON.stringify({
      name: "example",
      on: { "linear.comment_created": { filters: { from_users: ["alice"] } } },
      progress_message: true,
      reply_message: true,
      max_runtime: "2h",
      run: {
        ...run,
        title: "Review",
        max_runtime: "1h",
        startup_timeout: "3m",
        env: { STAGE: "test" },
        github: {
          connection: "github",
          repositories: ["example/project"],
          permissions: { contents: "read" },
        },
        output: { schema: { type: "object" } },
        outputs: { "linear.reply": { max: 2, required: true }, "slack.reply": {} },
        continuation: { mode: "new" },
        auto_archive: false,
        background: true,
      },
    }),
  );
  const [event] = result.events;
  assert.ok(event);
  const step = agentStep(event.steps[0]);
  assert.equal(event.progressMessage, true);
  assert.equal(event.replyMessage, true);
  assert.equal(event.maxRuntimeMs, 7_200_000);
  assert.equal(step.maxRuntimeMs, 3_600_000);
  assert.equal(step.startupTimeoutMs, 180_000);
  assert.equal(step.title, "Review");
  assert.deepEqual(step.env, { STAGE: "test" });
  assert.deepEqual(step.github?.permissions, { contents: "read" });
  assert.deepEqual(step.output?.schema, { type: "object" });
  assert.deepEqual(step.allowOutputs, [
    { type: "linear.reply", max: 2, required: true },
    { type: "slack.reply", max: 1, required: false },
  ]);
  assert.deepEqual(step.continuation, { mode: "new" });
  assert.equal(step.autoArchive, false);
  assert.equal(step.background, true);
});

test("does not add an agent continuation to a script", () => {
  const result = compileTriggerDocument(
    JSON.stringify({
      name: "example",
      on: { "manual.run": { filters: { from_users: ["alice"] } } },
      run: { target: run.target, script: "echo done" },
    }),
  );
  const step = result.events[0]?.steps[0];
  assert.ok(step && isScriptStep(step));
  assert.equal(step.script, "echo done");
  assert.equal(Object.hasOwn(step, "continuation"), false);
});

test("wraps compiler failures and reports the first failing event", () => {
  const yaml = JSON.stringify({
    name: "example",
    on: { "slack.mention": {}, "discord.mention": {} },
    run,
  });
  assert.throws(
    () => compileTriggerDocument(yaml),
    (error) => {
      assert.ok(error instanceof TriggerDocumentError);
      assert.deepEqual(error.issues, [
        {
          path: [],
          message:
            "trigger example requires a non-empty filters.from_users allowlist for externally sourced events",
        },
      ]);
      return true;
    },
  );
});

test("preserves document issue order without reaching compilation", () => {
  assert.throws(
    () => compileTriggerDocument('{"name":"","on":{},"run":null}'),
    (error) => {
      assert.ok(error instanceof TriggerDocumentError);
      assert.deepEqual(error.issues, [
        { path: ["name"], message: "Invalid string: must match pattern /^[a-z][a-z0-9_-]*$/u" },
        {
          path: ["run"],
          message:
            "run must be an object with a target and an action: agent and prompt, or script.",
        },
      ]);
      return true;
    },
  );
});

test("keeps multiple legacy conversion blockers in their original order", () => {
  const migrated = migrateLegacyBundle({
    files: [
      {
        path: ".paseo/hub.yml",
        content: "environments: { runner: { kind: daemon, daemon: devbox, cwd: /workspace } }",
      },
      {
        path: ".paseo/workflows/example.yml",
        content: `
name: example
on: manual.run
max_runtime: 1h
values: { answer: "\${{ paseo.prompt }}" }
steps:
  - id: work
    environment: runner
    max_runtime: 10m
    idle_timeout: 2m
    agent: { provider: codex }
    if: "\${{ paseo.prompt != '' }}"
    prompt: [{ text: work }]
    allow_outputs:
      - { type: slack.reply, max: 1 }
      - { type: slack.reply, max: 2 }
  - id: later
    environment: runner
    max_runtime: 5m
    idle_timeout: 2m
    agent: { provider: codex }
    prompt: [{ text: later }]
`,
      },
    ],
  });
  const [trigger] = migrated;
  assert.ok(trigger?.format === "legacy_multistep");
  assert.deepEqual(trigger.conversionBlockers, [
    "trigger has multiple steps",
    "trigger defines workflow values",
    "run is conditional",
    "run contains duplicate output grants",
  ]);
});
