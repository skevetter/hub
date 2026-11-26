import assert from "node:assert/strict";
import { test } from "vitest";
import {
  changeTriggerEvent,
  createTriggerYaml,
  droppedTriggerRules,
  patchTriggerYaml,
  projectTriggerForm,
  triggerFormErrors,
  type TriggerFormValue,
  type TriggerStepFormValue,
} from "./editor.js";

const AGENT_YAML = `# Keep this header.
name: check
enabled: false
on:
  manual.run:
    filters:
      from_users: [] # No callers.
run:
  target: { daemon: primary, cwd: /workspace }
  agent: { provider: codex, mode: safe }
  prompt: "Review it."
`;

function editable(yaml = AGENT_YAML) {
  const projection = projectTriggerForm(yaml);
  assert.equal(projection.status, "editable");
  return projection.value;
}

function withStep(value: TriggerFormValue, patch: Partial<TriggerStepFormValue>) {
  return {
    ...value,
    steps: value.steps.map((step, index) => (index === 0 ? { ...step, ...patch } : step)),
  };
}

test("retains explicit false flags in the form and strips them from unchanged YAML", () => {
  const yaml = `${AGENT_YAML}progress_message: false\nreply_message: false\n`;
  const value = editable(yaml);
  assert.equal(value.progressMessage, false);
  assert.equal(value.replyMessage, false);
  assert.equal(value.manualNoCallers, true);
  assert.equal(value.allowedUsers, "");
  assert.equal(patchTriggerYaml(yaml, value), AGENT_YAML);
});

test("updates agent settings and authority in their original YAML order", () => {
  const original = `${AGENT_YAML}  github: { connection: old } # Keep authority.\n`;
  const value = editable(original);
  const yaml = patchTriggerYaml(original, {
    ...withStep(value, {
      agent: "pi/vendor/model",
      mode: " safe ",
      thinkingOptionId: " high ",
      providerOptions: '{"temperature":0}',
      continuationMode: "key",
      continuationKey: "item",
      maxRuntime: " 3h ",
      idleTimeout: " 15m ",
      completeOnTurnEnd: true,
      githubConnection: " new ",
      githubRepositories: "one/repo, two/repo",
      githubPermissions: '{"issues":"write"}',
      githubDuration: " 1h ",
      prompt: "Review again.",
    }),
    name: "new-check",
    enabled: true,
    daemon: "secondary",
  });
  assert.equal(
    yaml,
    `# Keep this header.
name: new-check
enabled: true
on:
  manual.run:
    filters:
      from_users: [] # No callers.
run:
  target: { daemon: secondary, cwd: /workspace }
  agent: { provider: pi, mode: safe, model: vendor/model, thinkingOptionId: high, options: { temperature: 0 } }
  prompt: "Review again."
  github: { connection: new, repositories: [ one/repo, two/repo ], permissions: { issues: write }, duration: 1h } # Keep authority.
  max_runtime: 3h
  continuation:
    mode: key
    key: item
  idle_timeout: 15m
  complete_on_turn_end: true
`,
  );
  assert.equal(editable(yaml).steps[0]?.githubPermissions, '{\n  "issues": "write"\n}');
});

test("replaces prompt-only fields on conversion to script and restores them on reversal", () => {
  const agent = { ...editable(), manualNoCallers: false, allowedUsers: "alice" };
  const script = withStep(agent, { action: "script", script: "echo ready" });
  const yaml = patchTriggerYaml(AGENT_YAML, script);
  assert.doesNotMatch(yaml, /agent:|prompt:|idle_timeout:/);
  assert.equal(editable(yaml).steps[0]?.script, "echo ready");
  const edited = patchTriggerYaml(yaml, withStep(editable(yaml), { script: "echo again" }));
  assert.equal(editable(edited).steps[0]?.script, "echo again");
  const restored = patchTriggerYaml(edited, agent);
  assert.doesNotMatch(restored, /script:/);
  const [originalStep] = agent.steps;
  assert.ok(originalStep);
  assert.equal(editable(restored).steps[0]?.prompt, originalStep.prompt);
});

test("changes events without moving the named rule cleanup ahead of advanced filters", () => {
  const original = AGENT_YAML.replace("    filters:", "    filters:\n      unknown_rule: true");
  const previous = { ...editable(original), progressMessage: true, replyMessage: true };
  assert.equal(changeTriggerEvent(previous, previous.event), previous);
  const next = changeTriggerEvent(previous, "schedule.tick");
  assert.deepEqual(droppedTriggerRules(previous, next), [
    "unknown_rule",
    "Audience",
    "Live progress messages",
    "Agent reply",
  ]);
  assert.deepEqual(droppedTriggerRules(next, next), []);
  const scheduled = patchTriggerYaml(original, next);
  assert.doesNotMatch(scheduled, /filters:|unknown_rule:/);
  assert.match(scheduled, /schedule\.tick:\n    recurrence:/);
  assert.deepEqual(droppedTriggerRules(next, changeTriggerEvent(next, "manual.run")), ["Schedule"]);
});

test("preserves field error order for invalid drafts", () => {
  const value = {
    ...withStep(editable(), {
      maxRuntime: "",
      idleTimeout: "",
      agent: "codex/",
      mode: "",
      providerOptions: "[]",
      githubConnection: "github",
      githubPermissions: "{",
      continuationMode: "key",
      continuationKey: "",
      prompt: "",
    }),
    name: "NOT-valid",
    event: "linear.issue_entered_scope" as const,
    progressMessage: true,
    replyMessage: true,
    daemon: " ",
    cwd: "relative",
  };
  assert.deepEqual(Object.entries(triggerFormErrors(value)), [
    ["name", "Use lowercase letters, digits, and hyphens, starting with a letter."],
    ["connection", "Connection is required."],
    ["replyMessage", "reply_message requires named Linear users in filters.from_users."],
    ["qualifiers.project", "Project is required."],
    ["daemon", "Daemon is required."],
    ["cwd", "Working directory must be an absolute path."],
    ["steps.0.maxRuntime", "Maximum runtime is required."],
    ["steps.0.idleTimeout", "Idle timeout is required."],
    ["steps.0.agent", "Agent must look like provider/model."],
    ["steps.0.mode", "Execution mode is required."],
    ["steps.0.providerOptions", "Provider options must be a JSON object."],
    ["steps.0.githubPermissions", "GitHub permissions must be valid JSON."],
    ["steps.0.continuationKey", "Enter a continuation key or expression."],
    ["steps.0.prompt", "Instructions are required."],
  ]);
  assert.throws(() => patchTriggerYaml(AGENT_YAML, value), {
    message: "Use lowercase letters, digits, and hyphens, starting with a letter.",
  });
});

test("keeps YAML parser and first schema issue messages distinct", () => {
  assert.deepEqual(projectTriggerForm("name: ["), {
    status: "yaml_only",
    reason:
      "Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 8:\n\nname: [\n       ^\n",
  });
  assert.deepEqual(projectTriggerForm(AGENT_YAML.replace("name: check", "name: 42")), {
    status: "yaml_only",
    reason: "name: Invalid input: expected string, received number",
  });
});

test("preserves literal text whitespace, ignores blank lists and rejects non-scalar inputs", () => {
  const value = {
    ...editable(),
    event: "github.issue_created" as const,
    connection: "git",
    allowedUsers: "*",
    qualifiers: { repo: " owner/repo ", pattern: "  run ", labels: " \n\t" },
  };
  const yaml = createTriggerYaml(value);
  assert.deepEqual(editable(yaml).qualifiers, { pattern: "  run ", repo: "owner/repo" });
  assert.deepEqual(
    triggerFormErrors({ ...value, qualifiers: { inputs: '{"bad":{"nested":true}}' } }),
    {
      "qualifiers.inputs":
        "Input matches must be a JSON object with string, number, or boolean values.",
    },
  );
});
