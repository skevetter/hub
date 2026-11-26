import { agentStep, parseCompiledHubConfig } from "../../config/compiler.js";
import { agentRun } from "./schema.js";
import { DEFAULT_RECURRENCE } from "../schedule/recurrence.js";
import assert from "node:assert/strict";
import { parseProjectConfiguration } from "../../configuration/store.js";
import type { ProjectConfigurationRevisionRecord } from "../../db/types.js";
import { describe, expect, it } from "vitest";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  serializeTriggerDocument,
  TriggerDocumentError,
} from "./index.js";
import { documentRun } from "./steps.js";

function reportsMissingEvent(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) => path.join(".") === "on" && /at least one event/u.test(message),
    )
  );
}

function reportsScheduledRequiredInput(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(
      ({ path, message }) => path.join(".") === "inputs.focus" && /schedule/u.test(message),
    )
  );
}

function reportsEmptyTitle(error: unknown): boolean {
  return (
    error instanceof TriggerDocumentError &&
    error.issues.some(({ path }) => path.join(".") === "run.title")
  );
}

const trigger = `
name: engineering-requests
enabled: true
on:
  slack.mention:
    connection: acme-slack
    filters:
      channels: [engineering]
      from_users: [U0BNGPZEXT2]
  github.issue_comment:
    connection: getpaseo-github
    filters:
      contains: "@paseo-bot"
      from_users: [boudra]
inputs:
  model:
    type: string
    default: codex
    choices: [codex, claude]
run:
  target:
    daemon: devbox
    cwd: /workspace/company
  agent:
    select: \${{ paseo.inputs.model }}
    choices:
      codex:
        provider: codex
        model: gpt-5.6-sol
      claude:
        provider: claude
        model: claude-opus-5
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: getpaseo-github
    repositories: [getpaseo/paseo, getpaseo/hub]
    permissions:
      contents: write
      pull_requests: write
  prompt: |
    Use Paseo when delegation is useful.
    \${{ paseo.prompt }}
  outputs:
    slack.reply:
      max: 5
`;

describe("trigger progress opt-in", () => {
  it.each([undefined, false, true])("compiles and exports progress_message %s", (flag) => {
    const yaml =
      flag === undefined
        ? trigger
        : `progress_message: ${String(flag)}
${trigger}`;
    const compiled = compileTriggerDocument(yaml);
    assert.equal(compiled.authored.progress_message, flag);
    const expected = flag === true ? true : undefined;
    const configuration = parseCompiledHubConfig({
      environments: [compiled.environment],
      triggers: compiled.events,
    });
    assert.equal(configuration.triggers.length, 2);
    for (const event of configuration.triggers) {
      assert.equal(event.progressMessage, expected);
      assert.equal(Object.hasOwn(event, "progressMessage"), flag === true);
    }
    const exported = serializeTriggerDocument(compiled.authored);
    assert.equal(/^progress_message: true$/mu.test(exported), flag === true);
    const roundTrip = compileTriggerDocument(exported);
    assert.equal(roundTrip.authored.progress_message, expected);
    assert.deepEqual(roundTrip.events, compiled.events);
  });

  it.each(['"true"', "1", "null", "{}", "[]"])("refuses progress_message %s", (value) => {
    assert.throws(
      () =>
        parseTriggerDocument(`progress_message: ${value}
${trigger}`),
      {
        name: "TriggerDocumentError",
        message: /^progress_message: .*expected boolean/u,
      },
    );
  });

  it.each([
    ["github.push", "{}"],
    ["manual.run", "{}"],
    ["schedule.tick", JSON.stringify({ recurrence: DEFAULT_RECURRENCE })],
    ["discord.mention", "{}"],
    ["webhook.received", "{}"],
  ])("refuses progress_message on %s even alongside a supported event", (event, definition) => {
    const yaml = `progress_message: true
${trigger.replace(
  "on:",
  `on:
  ${event}: ${definition}`,
)}`;
    assert.throws(() => parseTriggerDocument(yaml), {
      name: "TriggerDocumentError",
      message:
        "progress_message: progress_message needs an event with a place to post: a GitHub issue or pull request event, a GitHub notification, a Slack mention or a Linear event. github.push, manual.run, schedule.tick and Discord events have none.",
    });
    assert.equal(
      parseTriggerDocument(yaml.replace("progress_message: true", "progress_message: false"))
        .progress_message,
      false,
    );
  });
});

describe("Linear reply opt-in", () => {
  const yaml = `name: answer
on:
  linear.comment_created:
    connection: linear
    filters:
      from_users: [operator]
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: claude }
  max_runtime: 1h
  idle_timeout: 10m
  prompt: Answer the question.
`;

  it("keeps the opt-in through document export and compiled parsing", () => {
    const authored = compileTriggerDocument(`reply_message: true\n${yaml}`);
    const compiled = parseCompiledHubConfig({
      environments: [authored.environment],
      triggers: authored.events,
    });
    expect(compiled.triggers).toMatchObject([{ replyMessage: true }]);
    expect(
      compileTriggerDocument(serializeTriggerDocument(authored.authored)).events,
    ).toMatchObject([{ replyMessage: true }]);
    expect(compileTriggerDocument(yaml).events[0]).not.toHaveProperty("replyMessage");
    expect(compileTriggerDocument(`reply_message: false\n${yaml}`).events[0]).not.toHaveProperty(
      "replyMessage",
    );
  });

  it("refuses events outside Linear and a missing or open Linear audience", () => {
    assert.throws(
      () =>
        compileTriggerDocument(
          `reply_message: true\n${yaml.replace("linear.comment_created", "slack.mention")}`,
        ),
      /reply_message.*requires a Linear event/u,
    );
    for (const audience of ["[]", '["*"]']) {
      assert.throws(
        () =>
          compileTriggerDocument(`reply_message: true\n${yaml.replace("[operator]", audience)}`),
        /reply_message.*from_users/u,
      );
    }
  });
});

describe("self-contained trigger documents", () => {
  it.each([undefined, false, true])("compiles and round-trips background %s", (background) => {
    const yaml =
      background === undefined
        ? trigger
        : trigger.replace(
            "run:",
            `run:
  background: ${background}`,
          );
    const compiled = compileTriggerDocument(yaml);
    assert.equal(agentRun(documentRun(compiled.authored)).background, background ?? false);
    assert.equal(agentStep(compiled.events[0]?.steps[0]).background, background ?? false);
    assert.equal(
      agentRun(documentRun(parseTriggerDocument(serializeTriggerDocument(compiled.authored))))
        .background,
      background ?? false,
    );
  });

  it("rejects a non-boolean background value", () => {
    assert.throws(
      () => parseTriggerDocument(trigger.replace("run:", 'run:\n  background: "true"')),
      /run.background/,
    );
  });

  it.each([undefined, false, true])(
    "keeps complete_on_turn_end %s off the compiled step unless it is on",
    (completeOnTurnEnd) => {
      const yaml =
        completeOnTurnEnd === undefined
          ? trigger
          : trigger.replace("run:", `run:\n  complete_on_turn_end: ${String(completeOnTurnEnd)}`);
      const compiled = compileTriggerDocument(yaml);
      const step = agentStep(compiled.events[0]?.steps[0]);
      assert.equal(step.completeOnTurnEnd, completeOnTurnEnd === true ? true : undefined);
      assert.equal("completeOnTurnEnd" in step, completeOnTurnEnd === true);
      const exported = serializeTriggerDocument(compiled.authored);
      assert.equal(/complete_on_turn_end/u.test(exported), completeOnTurnEnd !== undefined);
      assert.equal(
        agentRun(documentRun(parseTriggerDocument(exported))).complete_on_turn_end,
        completeOnTurnEnd,
      );
    },
  );

  it("rejects a non-boolean complete_on_turn_end value", () => {
    assert.throws(
      () => parseTriggerDocument(trigger.replace("run:", 'run:\n  complete_on_turn_end: "yes"')),
      /run.complete_on_turn_end/,
    );
  });

  it("refuses complete_on_turn_end beside a structured output or a required output", () => {
    const on = trigger.replace("run:", "run:\n  complete_on_turn_end: true");
    assert.throws(
      () =>
        compileTriggerDocument(
          on.replace("  outputs:", "  output:\n    schema: { type: object }\n  outputs:"),
        ),
      /complete_on_turn_end cannot be combined with output.schema/,
    );
    assert.throws(
      () =>
        compileTriggerDocument(on.replace("      max: 5", "      max: 5\n      required: true")),
      /complete_on_turn_end cannot be combined with a required output/,
    );
  });

  it("compiles and preserves a configurable startup timeout", () => {
    const yaml = trigger.replace("  max_runtime: 90m", "  max_runtime: 90m\n  startup_timeout: 3m");
    const compiled = compileTriggerDocument(yaml);
    assert.equal(agentStep(compiled.events[0]?.steps[0]).startupTimeoutMs, 180_000);
    assert.equal(
      agentRun(documentRun(parseTriggerDocument(serializeTriggerDocument(compiled.authored))))
        .startup_timeout,
      "3m",
    );
  });

  it("compiles an authored title template and preserves it through canonical YAML", () => {
    const title = "Intake · ${{ paseo.execution.id }}";
    const yaml = trigger.replace("  max_runtime: 90m", `  max_runtime: 90m\n  title: "${title}"`);
    const compiled = compileTriggerDocument(yaml);
    assert.equal(agentStep(compiled.events[0]?.steps[0]).title, title);
    assert.equal(
      agentRun(documentRun(parseTriggerDocument(serializeTriggerDocument(compiled.authored))))
        .title,
      title,
    );
  });

  it("rejects an empty title at the document boundary", () => {
    assert.throws(
      () =>
        parseTriggerDocument(
          trigger.replace("  max_runtime: 90m", '  max_runtime: 90m\n  title: ""'),
        ),
      reportsEmptyTitle,
    );
  });

  it.each(["0s", "25h", "invalid"])("rejects invalid startup timeout %s", (duration) => {
    assert.throws(
      () =>
        compileTriggerDocument(
          trigger.replace(
            "  max_runtime: 90m",
            `  max_runtime: 90m\n  startup_timeout: ${duration}`,
          ),
        ),
      /startup_timeout/,
    );
  });

  it("compiles every input event to one launch against the inline target and agent choices", () => {
    const compiled = compileTriggerDocument(trigger);

    assert.equal(compiled.authored.name, "engineering-requests");
    assert.equal(compiled.environment.kind, "daemon");
    assert.equal(compiled.events.length, 2);
    assert.deepEqual(
      compiled.events.map(({ on }) => on),
      ["slack.mention", "github.issue_comment"],
    );
    assert.deepEqual(agentStep(compiled.events[0]?.steps[0]).agent, {
      selector: "${{ paseo.inputs.model }}",
      choices: {
        codex: { provider: "codex", model: "gpt-5.6-sol" },
        claude: { provider: "claude", model: "claude-opus-5" },
      },
    });
    assert.deepEqual(agentStep(compiled.events[0]?.steps[0]).allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
    ]);
    assert.deepEqual(agentStep(compiled.events[1]?.steps[0]).allowOutputs, [
      { type: "slack.reply", max: 5, required: false },
      { type: "github.reply", required: false },
    ]);
  });

  it("round-trips the semantic document through canonical YAML", () => {
    const parsed = parseTriggerDocument(trigger);
    assert.deepEqual(parseTriggerDocument(serializeTriggerDocument(parsed)), parsed);
  });

  it("allows authenticated manual dispatches when no actor filter is authored", () => {
    const compiled = compileTriggerDocument(`
name: deploy
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex }
  prompt: Handle it
`);

    assert.deepEqual(compiled.events[0]?.filters?.from_users, ["*"]);
    assert.deepEqual(agentStep(compiled.events[0]?.steps[0]).allowOutputs, []);
  });

  it("automatically grants an unlimited event-native reply for a new conversational trigger", () => {
    const compiled = compileTriggerDocument(`
name: answer
on:
  slack.mention:
    connection: acme-slack
    filters: { from_users: ["*"] }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`);

    assert.deepEqual(agentStep(compiled.events[0]?.steps[0]).allowOutputs, [
      { type: "slack.reply", required: false },
    ]);
  });

  it("rejects a trigger without events at the document boundary", () => {
    assert.throws(
      () =>
        parseTriggerDocument(`
name: empty
on: {}
run:
  target: { daemon: local, cwd: /workspace }
  agent: { provider: codex }
  prompt: run
`),
      reportsMissingEvent,
    );
  });

  it("refuses a schedule beside an input that a tick cannot supply", () => {
    const scheduled = (input: string) => `
name: watch
inputs:
  focus: ${input}
on:
  schedule.tick:
    recurrence: { start: "2026-01-01T09:00:00", rule: "FREQ=DAILY", timezone: UTC }
  manual.run: {}
run:
  target: { daemon: local, cwd: /workspace }
  agent: { provider: codex }
  prompt: run
`;
    assert.equal(
      Object.keys(parseTriggerDocument(scheduled("{ type: string, default: everything }")).on)
        .length,
      2,
    );
    assert.throws(
      () => parseTriggerDocument(scheduled("{ type: string, required: true }")),
      reportsScheduledRequiredInput,
    );
  });
});

it("applies the continuation default when reading old trigger revisions without rewriting their evidence", () => {
  const compiled = compileTriggerDocument(trigger);
  const stored = structuredClone({
    environments: [{ ...compiled.environment, daemonId: "daemon" }],
    triggers: compiled.events,
  });
  for (const event of stored.triggers)
    for (const step of event.steps) delete agentStep(step).continuation;
  const revision: ProjectConfigurationRevisionRecord = {
    id: "revision",
    projectId: "project",
    organizationId: "org",
    version: 1,
    sourceKind: "manual",
    sourceEvidence: { kind: "organization_trigger_adapter" },
    rawYaml: trigger,
    normalizedConfiguration: stored,
    validationErrors: null,
    contentHash: "original",
    createdByUserId: "user",
    receivedAt: null,
    createdAt: new Date(),
    validatedAt: new Date(),
  };
  const loaded = parseProjectConfiguration(revision);
  assert.deepEqual(agentStep(loaded.triggers[0]?.steps[0]).continuation, { mode: "conversation" });
  assert.equal(agentStep(stored.triggers[0]?.steps[0]).continuation, undefined);
  const legacy = parseProjectConfiguration({ ...revision, sourceEvidence: { kind: "manual" } });
  assert.equal(agentStep(legacy.triggers[0]?.steps[0]).continuation, undefined);
  const migratedLegacy = parseProjectConfiguration({
    ...revision,
    rawYaml: JSON.stringify({
      name: "preserved-workflow",
      legacy_multistep: { trigger: stored.triggers[0], environments: stored.environments },
    }),
  });
  assert.deepEqual(migratedLegacy, legacy);
});
