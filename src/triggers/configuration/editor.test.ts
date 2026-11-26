import { compileTriggerDocument, parseTriggerDocument } from "./index.js";
import { matchTriggers } from "../github/match.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { agentRun, TriggerDocumentSchema } from "./schema.js";
import { EDITOR_EVENTS, eventDefinition } from "./events.js";
import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";
import {
  changeTriggerEvent,
  createTriggerYaml,
  describeTriggerEvent,
  droppedTriggerRules,
  needsActorFilter,
  mergeTriggerForm,
  newStepFormValue,
  patchTriggerYaml,
  projectTriggerForm,
  splitAgentId,
  triggerFormErrors,
  type TriggerFormValue,
  type TriggerStepFormValue,
} from "./editor.js";

import {
  GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES,
  GITHUB_TRIGGER_SOURCE_NAMES,
} from "../github/classification.js";
import { documentRun } from "./steps.js";

const ADVANCED = `# keep this heading
name: answer
enabled: true
on:
  slack.mention:
    connection: company
    filters:
      from_users: ["*"]
      channels: [engineering]
inputs:
  urgency:
    type: string
    default: normal
max_runtime: 4h
run:
  target:
    daemon: office
    cwd: /workspace
    worktree:
      mode: branch-off
      newBranch: hub-work
  agent:
    provider: codex
    model: gpt-5.4
    mode: full-access
    thinkingOptionId: xhigh
    options:
      sandbox_mode: workspace-write
      approval_policy: never
  prompt: Handle it.
  max_runtime: 3h
  idle_timeout: 15m
  startup_timeout: 3m
  env:
    TEAM: core
  github:
    connection: company-github
    repositories: [paseo/hub]
  output:
    schema:
      type: object
  outputs:
    slack.reply:
      max: 3
  auto_archive: false
`;

function withStep(value: TriggerFormValue, patch: Partial<TriggerStepFormValue>) {
  return {
    ...value,
    steps: value.steps.map((step, index) => (index === 0 ? { ...step, ...patch } : step)),
  };
}

function manualForm(name: string, step: Partial<TriggerStepFormValue>): TriggerFormValue {
  return {
    name,
    enabled: true,
    event: "manual.run",
    connection: "",
    allowedUsers: "*",
    qualifiers: {},
    daemon: "office",
    cwd: "/workspace",
    runMaxRuntime: "",
    steps: [newStepFormValue({ githubDuration: "1h", ...step })],
  };
}

describe("trigger form YAML bridge", () => {
  test("editing a manual trigger preserves its named sender restriction", () => {
    const original = `name: answer
on:
  manual.run:
    filters:
      from_users: [alice, bob] # named webhook callers
run:
  target: { daemon: office, cwd: /workspace }
  agent: { provider: codex, mode: safe }
  prompt: Handle it.
`;
    const projection = projectTriggerForm(original);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const saved = mergeTriggerForm(original, { ...projection.value, cwd: "/new-workspace" });
    if (saved.status !== "ok") throw new Error(saved.reason);
    const trigger = TriggerDocumentSchema.parse(parseDocument(saved.yaml).toJS());
    expect(trigger.on["manual.run"]?.filters?.from_users).toEqual(["alice", "bob"]);
    expect(saved.yaml).toContain("# named webhook callers");
    expect(documentRun(trigger).target.cwd).toBe("/new-workspace");
  });

  test("preserves YAML aliases and their comments during an unrelated form edit", () => {
    const yaml = ADVANCED.replace('from_users: ["*"]', 'from_users: &audience ["*"]').replace(
      "sandbox_mode: workspace-write",
      "audience: *audience # preserve alias",
    );
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const saved = patchTriggerYaml(yaml, { ...projection.value, cwd: "/other" });
    expect(saved).toContain("from_users: &audience");
    expect(
      TriggerDocumentSchema.parse(parseDocument(saved).toJS()).on["slack.mention"]?.filters
        ?.from_users,
    ).toEqual(["*"]);
    expect(saved).toContain("audience: *audience # preserve alias");
  });

  test("returns the original YAML byte-for-byte when the form did not change", () => {
    const projection = projectTriggerForm(ADVANCED);
    expect(projection.status).toBe("editable");
    if (projection.status === "editable") {
      expect(patchTriggerYaml(ADVANCED, projection.value)).toBe(ADVANCED);
    }
  });

  test("patches owned nodes while preserving comments and advanced configuration", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const yaml = patchTriggerYaml(ADVANCED, {
      ...withStep(projection.value, { agent: "pi/gateway/vendor/model-v1", mode: "safe" }),
      cwd: "/new-workspace",
    });
    expect(yaml).toContain("# keep this heading");
    const value = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    expect(documentRun(value).target).toEqual({
      daemon: "office",
      cwd: "/new-workspace",
      worktree: { mode: "branch-off", newBranch: "hub-work" },
    });
    expect(agentRun(documentRun(value)).agent).toEqual({
      provider: "pi",
      model: "gateway/vendor/model-v1",
      mode: "safe",
      thinkingOptionId: "xhigh",
      options: { sandbox_mode: "workspace-write", approval_policy: "never" },
    });
    expect(value.inputs).toBeDefined();
    expect(value.max_runtime).toBe("4h");
    expect(agentRun(documentRun(value)).startup_timeout).toBe("3m");
    expect(agentRun(documentRun(value)).env).toEqual({ TEAM: "core" });
    expect(agentRun(documentRun(value)).github).toEqual({
      connection: "company-github",
      repositories: ["paseo/hub"],
    });
    expect(agentRun(documentRun(value)).output).toBeDefined();
    expect(agentRun(documentRun(value)).outputs).toEqual({ "slack.reply": { max: 3 } });
    expect(agentRun(documentRun(value)).auto_archive).toBe(false);
    expect(value.on["slack.mention"]?.filters?.channels).toEqual(["engineering"]);
  });

  test("edits provider options without touching thinking selection", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const yaml = patchTriggerYaml(
      ADVANCED,
      withStep(projection.value, { providerOptions: '{"sandbox_mode":"read-only"}' }),
    );
    const value = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    const { agent } = agentRun(documentRun(value));
    if ("choices" in agent) throw new Error("expected an inline agent");
    expect(agent.options).toEqual({ sandbox_mode: "read-only" });
    expect(agent.thinkingOptionId).toBe("xhigh");
  });

  test("keeps advanced YAML added before a new trigger's first save", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const merged = mergeTriggerForm(ADVANCED, withStep(projection.value, { prompt: "Changed." }));
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("# keep this heading");
    expect(merged.yaml).toBe(
      parseDocument(ADVANCED.replace("prompt: Handle it.", "prompt: Changed."), {
        compat: ["timestamp"],
      }).toString({ lineWidth: 0 }),
    );
    const value = TriggerDocumentSchema.parse(parseDocument(merged.yaml).toJS());
    expect(agentRun(documentRun(value)).prompt).toBe("Changed.");
    expect(agentRun(documentRun(value)).target.worktree).toBeDefined();
    expect(agentRun(documentRun(value)).outputs).toBeDefined();
  });

  test("keeps unsupported shapes in YAML-only mode", () => {
    expect(projectTriggerForm(ADVANCED.replace("slack.mention:", "custom.event:"))).toEqual({
      status: "yaml_only",
      reason: "The form does not support the custom.event event.",
    });
    expect(
      projectTriggerForm(
        ADVANCED.replace(
          "provider: codex\n    model: gpt-5.4",
          "select: primary\n    choices:\n      primary:\n        provider: codex",
        ),
      ).status,
    ).toBe("yaml_only");
  });

  test("creates a deliberately minimal new trigger", () => {
    const yaml = createTriggerYaml(
      manualForm("answer", {
        agent: "codex/gpt-5.4",
        mode: "full-access",
        prompt: "Handle it.",
      }),
    );
    expect(parseDocument(yaml).toJS()).toEqual({
      name: "answer",
      enabled: true,
      on: { "manual.run": {} },
      run: {
        target: { daemon: "office", cwd: "/workspace" },
        agent: { provider: "codex", model: "gpt-5.4", mode: "full-access" },
        continuation: { mode: "conversation" },
        max_runtime: "2h",
        idle_timeout: "10m",
        prompt: "Handle it.",
      },
    });
  });

  test.each([undefined, false, true])("projects and exports progress_message %s", (flag) => {
    const yaml =
      flag === undefined
        ? ADVANCED
        : `progress_message: ${String(flag)}
${ADVANCED}`;
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(projection.value.progressMessage).toBe(flag);

    const exported = patchTriggerYaml(yaml, projection.value);
    expect(parseDocument(exported).get("progress_message")).toBe(flag === true ? true : undefined);
    expect(exported).toContain("# keep this heading");

    const edited = patchTriggerYaml(yaml, { ...projection.value, progressMessage: flag !== true });
    expect(parseDocument(edited).get("progress_message")).toBe(flag === true ? undefined : true);

    const fresh = createTriggerYaml(projection.value);
    expect(parseDocument(fresh).get("progress_message")).toBe(flag === true ? true : undefined);
  });

  test("clears the hidden progress opt-in when changing to a destinationless event", () => {
    const yaml = `progress_message: true
${ADVANCED}`;
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const form = changeTriggerEvent(projection.value, "manual.run");
    expect(form.progressMessage).toBe(false);
    expect(parseDocument(patchTriggerYaml(yaml, form)).has("progress_message")).toBe(false);
  });

  test("edits the Linear reply opt-in and clears it when leaving Linear", () => {
    const yaml = ADVANCED.replace("slack.mention", "linear.comment_created").replace(
      'from_users: ["*"]\n      channels: [engineering]',
      "from_users: [operator]",
    );
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const enabled = { ...projection.value, replyMessage: true };
    const patched = patchTriggerYaml(yaml, enabled);
    expect(parseTriggerDocument(patched)).toMatchObject({ reply_message: true });
    expect(parseTriggerDocument(createTriggerYaml(enabled))).toMatchObject({ reply_message: true });
    const next = { ...changeTriggerEvent(enabled, "manual.run"), allowedUsers: "*" };
    expect(droppedTriggerRules(enabled, next)).toContain("Agent reply");
    expect(parseTriggerDocument(patchTriggerYaml(patched, next))).not.toHaveProperty(
      "reply_message",
    );
    const invalid = { ...next, replyMessage: true };
    expect(triggerFormErrors(invalid)).toMatchObject({
      replyMessage: "reply_message requires a Linear event.",
    });
  });

  test("writes complete_on_turn_end only when the box is ticked", () => {
    const form = manualForm("answer", {
      agent: "claude",
      mode: "default",
      prompt: "Handle it.",
    });
    const off = createTriggerYaml(form);
    expect(off).not.toContain("complete_on_turn_end");

    const on = createTriggerYaml(withStep(form, { completeOnTurnEnd: true }));
    expect(parseDocument(on).getIn(["run", "complete_on_turn_end"])).toBe(true);
    const projection = projectTriggerForm(on);
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(projection.value.steps[0]?.completeOnTurnEnd).toBe(true);

    const cleared = mergeTriggerForm(on, withStep(projection.value, { completeOnTurnEnd: false }));
    if (cleared.status !== "ok") throw new Error(cleared.reason);
    expect(cleared.yaml).not.toContain("complete_on_turn_end");
    const set = mergeTriggerForm(off, withStep(form, { completeOnTurnEnd: true }));
    if (set.status !== "ok") throw new Error(set.reason);
    expect(parseDocument(set.yaml).getIn(["run", "complete_on_turn_end"])).toBe(true);
  });

  test("leaves an authored complete_on_turn_end: false alone when the form is unchanged elsewhere", () => {
    const authored = ADVANCED.replace("run:", "run:\n  complete_on_turn_end: false");
    const projection = projectTriggerForm(authored);
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(projection.value.steps[0]?.completeOnTurnEnd).toBe(false);
    const merged = mergeTriggerForm(authored, { ...projection.value, name: "renamed" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("complete_on_turn_end: false");
  });

  test("submits an unchanged minimal manual trigger", () => {
    const initial = createTriggerYaml(
      manualForm("deploy", {
        agent: "opencode",
        mode: "full-access",
        prompt: "${{ paseo.prompt }}",
      }),
    );
    const projection = projectTriggerForm(initial);
    if (projection.status !== "editable") throw new Error(projection.reason);

    const merged = mergeTriggerForm(initial, { ...projection.value, name: "release" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("name: release");
  });

  test("splits only the first slash in a full agent ID", () => {
    expect(splitAgentId("pi/gateway/vendor/model-v1")).toEqual({
      provider: "pi",
      model: "gateway/vendor/model-v1",
    });
  });

  test("reports the missing field instead of throwing when the form is half filled", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);

    expect(mergeTriggerForm("", { ...projection.value, daemon: "" })).toEqual({
      status: "incomplete",
      reason: "Daemon is required.",
    });
    expect(mergeTriggerForm("", withStep(projection.value, { agent: "" }))).toEqual({
      status: "incomplete",
      reason: "Agent is required.",
    });
    expect(mergeTriggerForm("", withStep(projection.value, { providerOptions: "{" }))).toEqual({
      status: "incomplete",
      reason: "Provider options must be valid JSON.",
    });
  });

  test("serialises a complete new trigger that has no document yet", () => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);

    const merged = mergeTriggerForm("", projection.value);
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(merged.yaml).toContain("daemon: office");
  });
});

describe("what the form still needs", () => {
  function editable() {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    return projection.value;
  }

  test("finds nothing wrong with a document that already parses", () => {
    expect(triggerFormErrors(editable())).toEqual({});
  });

  test("names the field, not just the problem", () => {
    expect(triggerFormErrors({ ...editable(), daemon: "" })).toEqual({
      daemon: "Daemon is required.",
    });
    expect(triggerFormErrors({ ...editable(), cwd: "workspace" })).toEqual({
      cwd: "Working directory must be an absolute path.",
    });
    expect(triggerFormErrors(withStep(editable(), { agent: "" }))).toEqual({
      "steps.0.agent": "Agent is required.",
    });
    expect(triggerFormErrors(withStep(editable(), { providerOptions: "{" }))).toEqual({
      "steps.0.providerOptions": "Provider options must be valid JSON.",
    });
    expect(triggerFormErrors(withStep(editable(), { prompt: "  " }))).toEqual({
      "steps.0.prompt": "Instructions are required.",
    });
  });

  test("holds the name to the document's own alphabet", () => {
    expect(triggerFormErrors({ ...editable(), name: "" }).name).toBe("Trigger name is required.");
    expect(triggerFormErrors({ ...editable(), name: "Slack Triage" }).name).toBe(
      "Use lowercase letters, digits, and hyphens, starting with a letter.",
    );
    expect(triggerFormErrors({ ...editable(), name: "slack-triage" }).name).toBeUndefined();
  });

  test("asks for a connection only when an event arrives on one", () => {
    expect(triggerFormErrors({ ...editable(), connection: "" }).connection).toBe(
      "Connection is required.",
    );
    expect(
      triggerFormErrors({ ...editable(), event: "manual.run", connection: "", allowedUsers: "" })
        .connection,
    ).toBeUndefined();
  });

  test("reads GitHub permissions only when a GitHub connection is chosen", () => {
    expect(
      triggerFormErrors(withStep(editable(), { githubConnection: "", githubPermissions: "{" }))[
        "steps.0.githubPermissions"
      ],
    ).toBeUndefined();
    expect(
      triggerFormErrors(
        withStep(editable(), { githubConnection: "company", githubPermissions: "{" }),
      )["steps.0.githubPermissions"],
    ).toBe("GitHub permissions must be valid JSON.");
    expect(
      triggerFormErrors(
        withStep(editable(), { githubConnection: "company", githubPermissions: '{"a":1}' }),
      )["steps.0.githubPermissions"],
    ).toBe('GitHub permissions map a scope to "read", "write", or "admin".');
  });

  test("reports the topmost problem when the document cannot be written at all", () => {
    expect(mergeTriggerForm("", { ...editable(), name: "", daemon: "" })).toEqual({
      status: "incomplete",
      reason: "Trigger name is required.",
    });
  });
});

test.each([
  "github.pull_request_created",
  "github.pull_request_ready_for_review",
  "github.issue_created",
  "linear.issue_assigned",
  "linear.comment_created",
  "linear.issue_entered_scope",
])("edits supported event %s", (event) => {
  expect(projectTriggerForm(ADVANCED.replace("slack.mention", event)).status).toBe("editable");
});

test("round trips the added label separately from existing item labels", () => {
  const yaml = ADVANCED.replace("slack.mention", "github.pull_request_label_added").replace(
    "channels: [engineering]",
    "label: ready\n      labels: [bug]",
  );
  const projection = projectTriggerForm(yaml);
  expect(projection.status).toBe("editable");
  if (projection.status !== "editable") throw new Error("not editable");
  expect(projection.value.qualifiers).toMatchObject({ label: "ready", labels: "bug" });
  const patched = patchTriggerYaml(yaml, {
    ...projection.value,
    qualifiers: { ...projection.value.qualifiers, label: "review" },
  });
  expect(
    TriggerDocumentSchema.parse(parseDocument(patched).toJS()).on["github.pull_request_label_added"]
      ?.filters,
  ).toEqual({
    from_users: ["*"],
    label: "review",
    labels: ["bug"],
  });
  expect(() => patchTriggerYaml(patched, { ...projection.value, qualifiers: {} })).toThrow(
    "Added label is required.",
  );
});

test("offers every supported GitHub semantic event and webhook source", () => {
  for (const event of [...GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES, ...GITHUB_TRIGGER_SOURCE_NAMES]) {
    expect(EDITOR_EVENTS).toContain(event);
  }
});

test("creates a qualified event and removes the qualifier when changing event kind", () => {
  const initial = projectTriggerForm(ADVANCED);
  if (initial.status !== "editable") throw new Error(initial.reason);
  const yaml = createTriggerYaml({
    ...initial.value,
    event: "github.issue_label_added",
    qualifiers: { label: "ready" },
  });
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.qualifiers.label).toBe("ready");
  const changed = patchTriggerYaml(yaml, {
    ...projection.value,
    event: "github.pull_request_created",
  });
  expect(
    TriggerDocumentSchema.parse(parseDocument(changed).toJS()).on["github.pull_request_created"]
      ?.filters,
  ).toEqual({ from_users: ["*"] });
});

test("event changes carry compatible qualifiers and reset provider-bound values", () => {
  const projection = projectTriggerForm(
    ADVANCED.replace("slack.mention", "github.issue_label_added").replace(
      "channels: [engineering]",
      "label: ready",
    ),
  );
  if (projection.status !== "editable") throw new Error(projection.reason);
  const initial = { ...projection.value, qualifiers: { label: "ready" } };
  const pr = changeTriggerEvent(initial, "github.pull_request_label_added");
  expect(pr.qualifiers).toEqual({ label: "ready" });
  expect(pr.connection).toBe(initial.connection);
  const created = changeTriggerEvent(pr, "github.issue_created");
  expect(created.qualifiers).toEqual({});
  const slack = changeTriggerEvent(pr, "slack.mention");
  expect(slack.qualifiers).toEqual({});
  expect(slack.connection).toBe("");
});

test.each(["github.issue_label_added", "github.pull_request_label_added"])(
  "requires an added label for %s",
  (event) => {
    const projection = projectTriggerForm(
      ADVANCED.replace("slack.mention", event).replace("channels: [engineering]", "label: ready"),
    );
    if (projection.status !== "editable") throw new Error(projection.reason);
    expect(triggerFormErrors({ ...projection.value, qualifiers: { label: "  " } })).toEqual({
      "qualifiers.label": "Added label is required.",
    });
    expect(triggerFormErrors({ ...projection.value, qualifiers: {} })).toEqual({
      "qualifiers.label": "Added label is required.",
    });
  },
);

test.each(["github.issue_label_added", "github.pull_request_label_added"])(
  "rejects YAML without an added label for %s",
  (event) => {
    const missing = ADVANCED.replace("slack.mention", event);
    expect(TriggerDocumentSchema.safeParse(parseDocument(missing).toJS()).success).toBe(false);
    const blank = missing.replace("channels: [engineering]", 'label: "   "');
    expect(TriggerDocumentSchema.safeParse(parseDocument(blank).toJS()).success).toBe(false);
  },
);

test("continuation policies round-trip through the form and YAML", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.steps[0]?.continuationMode).toBe("conversation");
  for (const mode of ["key", "new", "conversation"]) {
    const yaml = patchTriggerYaml(
      ADVANCED,
      withStep(projection.value, {
        continuationMode: mode,
        continuationKey: "${{ paseo.inputs.ticket }}",
      }),
    );
    const next = projectTriggerForm(yaml);
    expect(next).toMatchObject({
      status: "editable",
      value: { steps: [{ continuationMode: mode }] },
    });
    expect(yaml).toContain("# keep this heading");
  }
});

test("a trigger row names the event kind before what narrows it", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const slack = projection.value;
  expect(describeTriggerEvent(slack, "slack.mention")).toEqual({
    kind: "Slack mention",
    detail: "company",
  });
  // The recurrence used to stand in for the kind, so a schedule's row never said "Schedule".
  const schedule = {
    ...slack,
    event: "schedule.tick" as const,
    connection: "",
    recurrence: { start: "2026-01-01T08:15:00", rule: "FREQ=DAILY", timezone: "UTC" },
  };
  expect(describeTriggerEvent(schedule, "schedule.tick")).toEqual({
    kind: "Schedule",
    detail: "Every day at 08:15 (UTC)",
  });
  expect(
    describeTriggerEvent({ ...slack, event: "manual.run", connection: "" }, "manual.run"),
  ).toEqual({
    kind: "Manual run",
  });
  expect(describeTriggerEvent(null, "github.push")).toEqual({ kind: "GitHub push" });
});

test("creates and edits the audience of a manual webhook trigger", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const manual = {
    ...changeTriggerEvent(projection.value, "manual.run"),
    allowedUsers: "alice, bob",
  };
  expect(needsActorFilter(manual)).toBe(true);
  const yaml = createTriggerYaml(manual);
  expect(TriggerDocumentSchema.parse(parseDocument(yaml).toJS()).on["manual.run"]).toEqual({
    filters: { from_users: ["alice", "bob"] },
  });
  const opened = patchTriggerYaml(yaml, { ...manual, allowedUsers: "*" });
  expect(parseDocument(opened).hasIn(["on", "manual.run", "filters", "from_users"])).toBe(false);
  expect(triggerFormErrors({ ...manual, allowedUsers: ", ," }).allowedUsers).toBeDefined();
});

test.each(["schedule.tick", "github.notification"] as const)(
  "%s cannot pick up a stale audience, on creation or edit",
  (event) => {
    const projection = projectTriggerForm(ADVANCED);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const previous = { ...projection.value, allowedUsers: "alice" };
    const next = changeTriggerEvent(previous, event);
    expect(needsActorFilter(next)).toBe(false);
    expect(droppedTriggerRules(previous, next)).toContain("Audience");
    for (const yaml of [
      createTriggerYaml({ ...next, allowedUsers: "alice" }),
      patchTriggerYaml(ADVANCED, { ...next, allowedUsers: "alice" }),
    ]) {
      const definition = TriggerDocumentSchema.parse(parseDocument(yaml).toJS()).on[event];
      expect(definition?.filters?.from_users).toBeUndefined();
      expect(definition?.connection).toBeUndefined();
    }
  },
);

test("round trips GitHub repository, label names, and literal text filters", () => {
  const yaml = ADVANCED.replace("slack.mention", "github.issue_comment_created").replace(
    "channels: [engineering]",
    'repo: acme/web # keep this scope\n      labels: ["one,two", bug] # keep this list\n      pattern: "/run " # keep exact trailing space\n      contains: deploy\n      exclude_contains: skip',
  );
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.qualifiers).toEqual({
    repo: "acme/web",
    labels: "one,two\nbug",
    pattern: "/run ",
    contains: "deploy",
    exclude_contains: "skip",
  });
  const patched = patchTriggerYaml(yaml, {
    ...projection.value,
    qualifiers: { ...projection.value.qualifiers, labels: "one,two\nurgent" },
  });
  expect(patched).toContain("# keep this scope");
  expect(patched).toContain("# keep this list");
  expect(patched).toContain("# keep exact trailing space");
  expect(
    TriggerDocumentSchema.parse(parseDocument(patched).toJS()).on["github.issue_comment_created"]
      ?.filters,
  ).toEqual({
    from_users: ["*"],
    repo: "acme/web",
    labels: ["one,two", "urgent"],
    pattern: "/run ",
    contains: "deploy",
    exclude_contains: "skip",
  });
});

const LINEAR_FILTERS = ADVANCED.replace(
  "slack.mention:",
  "linear.comment_created: # keep event comment",
)
  .replace('from_users: ["*"]', "from_users: [alice, bob] # keep audience")
  .replace(
    "channels: [engineering]",
    `# keep this filter comment
      project: project-a
      states: [started, ready]
      assignees: [sam]
      labels: [label-a]
      exclude_labels: [hold, waiting]
      pattern: /run
      contains: deploy
      inputs: { urgency: normal }
      channels: [unused] # outside this event's form`,
  );

test("retains schema-known advanced filter keys and their comments on ordinary form edits", () => {
  const projection = projectTriggerForm(LINEAR_FILTERS);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.advancedFilters).toEqual(["channels"]);
  const saved = mergeTriggerForm(LINEAR_FILTERS, {
    ...projection.value,
    qualifiers: { ...projection.value.qualifiers, exclude_labels: "hold\nblocked" },
  });
  if (saved.status !== "ok") throw new Error(saved.reason);
  expect(saved.yaml).toMatch(/channels: \[\s*unused\s*\] # outside this event's form/u);
  expect(saved.yaml).toContain("# keep this filter comment");
  expect(TriggerDocumentSchema.safeParse(parseDocument(saved.yaml).toJS()).success).toBe(true);
});

test("refuses a form save with a schema-unknown filter and names the key", () => {
  const yaml = LINEAR_FILTERS.replace("channels: [unused]", "future_filter: { value: 5 }");
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const result = mergeTriggerForm(yaml, { ...projection.value, cwd: "/other" });
  expect(result.status).toBe("invalid_document");
  if (result.status !== "invalid_document") throw new Error("Expected a schema error.");
  expect(result.reason).toContain('Unrecognized key: "future_filter"');
});

test("a same-provider change previews dropped rules and keeps compatible Linear rules", () => {
  const projection = projectTriggerForm(LINEAR_FILTERS);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const next = changeTriggerEvent(projection.value, "linear.issue_assigned");
  expect(droppedTriggerRules(projection.value, next)).toEqual([
    "Comment starts with",
    "Comment contains",
    "channels",
  ]);
  const saved = patchTriggerYaml(LINEAR_FILTERS, next);
  expect(saved).toContain("# keep event comment");
  expect(saved).toContain("# keep audience");
  const value = TriggerDocumentSchema.parse(parseDocument(saved).toJS());
  expect(value.on).toEqual({
    "linear.issue_assigned": {
      connection: "company",
      filters: {
        from_users: ["alice", "bob"],
        project: "project-a",
        states: ["started", "ready"],
        assignees: ["sam"],
        labels: ["label-a"],
        exclude_labels: ["hold", "waiting"],
        inputs: { urgency: "normal" },
      },
    },
  });

  const back = changeTriggerEvent(next, "linear.comment_created");
  expect(
    TriggerDocumentSchema.parse(parseDocument(patchTriggerYaml(LINEAR_FILTERS, back)).toJS()).on[
      "linear.comment_created"
    ]?.filters,
  ).toEqual(value.on["linear.issue_assigned"]?.filters);
});

test("keeps a Linear scope trigger's implicit audience while editing its filters", () => {
  const yaml = LINEAR_FILTERS.replace(
    "linear.comment_created:",
    "linear.issue_entered_scope:",
  ).replace("      from_users: [alice, bob] # keep audience\n", "");
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  expect(projection.value.allowedUsers).toBe("");
  const saved = patchTriggerYaml(yaml, {
    ...projection.value,
    qualifiers: { ...projection.value.qualifiers, project: "other-project" },
  });
  expect(
    parseDocument(saved).hasIn(["on", "linear.issue_entered_scope", "filters", "from_users"]),
  ).toBe(false);
});

test("an existing non-projectable document cannot be replaced by a fresh form document", () => {
  const projection = projectTriggerForm(ADVANCED);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const invalid = ADVANCED.replace("name: answer", "name: [");
  expect(mergeTriggerForm(invalid, projection.value).status).toBe("incomplete");
});

test.each(["from_users", "channels"] as const)(
  "keeps comments when editing an unshared anchor on %s",
  (key) => {
    const original = key === "from_users" ? 'from_users: ["*"]' : "channels: [engineering]";
    const yaml = ADVANCED.replace(
      original,
      `${key}: &entries
        - alice # retain Alice's comment
        - someone-else # remove this item
        - bob # retain Bob's comment`,
    );
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const draft =
      key === "from_users"
        ? { ...projection.value, allowedUsers: "bob, alice, carol" }
        : { ...projection.value, qualifiers: { channels: "bob\nalice\ncarol" } };
    const saved = mergeTriggerForm(yaml, draft);
    if (saved.status !== "ok") throw new Error(saved.reason);
    expect(saved.yaml).toContain(`${key}: &entries`);
    expect(saved.yaml).toContain("- alice # retain Alice's comment");
    expect(saved.yaml).toContain("- bob # retain Bob's comment");
    const parsed = TriggerDocumentSchema.parse(parseDocument(saved.yaml).toJS());
    expect(parsed.on["slack.mention"]?.filters?.[key]).toEqual(["bob", "alice", "carol"]);
  },
);

const GITHUB_ALIAS_YAML = `name: alias-audience
on:
  github.issue_created:
    connection: git
    filters:
      from_users: &names
        - alice # keep Alice
      labels: *names # keep label reference
run:
  target: { daemon: office, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Review the issue.
`;

test("editing an aliased GitHub label list leaves Bob outside the sender allowlist", () => {
  const projection = projectTriggerForm(GITHUB_ALIAS_YAML);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const result = mergeTriggerForm(GITHUB_ALIAS_YAML, {
    ...projection.value,
    qualifiers: { ...projection.value.qualifiers, labels: "alice\nbob" },
  });
  if (result.status !== "ok") throw new Error(result.reason);
  const delivery: NormalizedGitHubEvent = {
    id: "delivery",
    installationId: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "issues",
    repo: "acme/web",
    repositoryId: 1,
    payload: {
      action: "opened",
      sender: { login: "bob" },
      issue: { title: "A review", body: "", labels: [{ name: "alice" }, { name: "bob" }] },
    },
  };
  expect(
    matchTriggers({ triggers: compileTriggerDocument(GITHUB_ALIAS_YAML).events }, delivery, "git"),
  ).toHaveLength(0);
  expect(
    matchTriggers({ triggers: compileTriggerDocument(result.yaml).events }, delivery, "git"),
  ).toHaveLength(0);
  expect(parseTriggerDocument(result.yaml).on["github.issue_created"]?.filters).toEqual({
    from_users: ["alice"],
    labels: ["alice", "bob"],
  });
  expect(result.yaml).toContain("from_users: &names");
  expect(result.yaml).toContain("- alice # keep Alice");
  expect(result.yaml).toContain("# keep label reference");
});

test.each(["from_users", "channels"] as const)(
  "refuses direct edits to a shared %s anchor",
  (key) => {
    const original = key === "from_users" ? 'from_users: ["*"]' : "channels: [engineering]";
    const yaml = ADVANCED.replace(original, `${key}: &entries [alice]`).replace(
      "sandbox_mode: workspace-write",
      "selected: *entries",
    );
    const projection = projectTriggerForm(yaml);
    if (projection.status !== "editable") throw new Error(projection.reason);
    const value =
      key === "from_users"
        ? { ...projection.value, allowedUsers: "alice, bob" }
        : { ...projection.value, qualifiers: { channels: "alice\nbob" } };
    const result = mergeTriggerForm(yaml, value);
    expect(result.status).toBe("incomplete");
    if (result.status !== "incomplete") throw new Error("Expected a shared anchor error.");
    expect(result.reason).toContain("through a YAML anchor");
    const unrelated = mergeTriggerForm(yaml, { ...projection.value, cwd: "/other" });
    if (unrelated.status !== "ok") throw new Error(unrelated.reason);
    expect(unrelated.yaml).toContain("selected: *entries");
  },
);

test("scalar aliases copy on write and their shared anchors cannot be edited in the form", () => {
  const yaml = GITHUB_ALIAS_YAML.replace(
    "      labels: *names # keep label reference",
    "      pattern: &text /run\n      contains: *text # retain alias comment",
  );
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const patched = patchTriggerYaml(yaml, {
    ...projection.value,
    qualifiers: { ...projection.value.qualifiers, contains: "deploy" },
  });
  expect(patched).toContain("pattern: &text /run");
  expect(patched).toContain("contains: deploy # retain alias comment");
  expect(() =>
    patchTriggerYaml(yaml, {
      ...projection.value,
      qualifiers: { ...projection.value.qualifiers, pattern: "deploy" },
    }),
  ).toThrow("through a YAML anchor");
});

const githubEvents = [...GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES, ...GITHUB_TRIGGER_SOURCE_NAMES];
const labelEvents = new Set([
  "github.issue_label_added",
  "github.pull_request_label_added",
  "github.issues",
  "github.pull_request",
]);
function editableTrigger(yaml: string) {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  return projection.value;
}

function expectedTextDrops(
  from: (typeof githubEvents)[number],
  to: (typeof githubEvents)[number],
  text: object,
) {
  const dropsText = from !== to && to === "github.push";
  const expectedDrops = dropsText
    ? eventDefinition(from)
        .qualifiers.filter(({ key }) => Object.hasOwn(text, key))
        .map(({ label }) => label)
    : [];
  if (labelEvents.has(from) && !labelEvents.has(to)) expectedDrops.unshift("Added label");
  return expectedDrops;
}

test.each(githubEvents.flatMap((from) => githubEvents.map((to) => [from, to] as const)))(
  "carries GitHub matcher text rules from %s to %s when the destination supports them",
  (from, to) => {
    const projection = editableTrigger(ADVANCED);
    const text = { pattern: "/run", contains: "deploy", exclude_contains: "skip" };
    const document = parseDocument(
      createTriggerYaml({
        ...projection,
        event: from,
        qualifiers: { label: "ready" },
      }),
    );
    const sourcePath = ["on", from, "filters"];
    for (const [key, value] of Object.entries(text)) document.setIn([...sourcePath, key], value);
    const fromYaml = document.toString();
    const authored = editableTrigger(fromYaml);
    const next = changeTriggerEvent(authored, to);
    const dropsText = from !== to && to === "github.push";
    const expectedDrops = expectedTextDrops(from, to, text);
    expect(droppedTriggerRules(authored, next)).toEqual(expectedDrops);
    const saved = patchTriggerYaml(fromYaml, {
      ...next,
      qualifiers: { ...next.qualifiers, ...(labelEvents.has(to) ? { label: "ready" } : {}) },
    });
    const filters = parseTriggerDocument(saved).on[to]?.filters;
    for (const key of ["pattern", "contains", "exclude_contains"] as const) {
      expect(filters?.[key]).toBe(dropsText ? undefined : text[key]);
    }
  },
);

test("preserves an explicit empty manual caller list during an unrelated edit", () => {
  const yaml = ADVANCED.replace("slack.mention:", "manual.run:").replace(
    '      from_users: ["*"]',
    "      from_users: [] # nobody can invoke this",
  );
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const saved = mergeTriggerForm(yaml, { ...projection.value, cwd: "/other" });
  if (saved.status !== "ok") throw new Error(saved.reason);
  expect(saved.yaml).toContain("# nobody can invoke this");
  const parsed = TriggerDocumentSchema.parse(parseDocument(saved.yaml).toJS());
  expect(parsed.on["manual.run"]?.filters?.from_users).toEqual([]);
  expect(documentRun(parsed).target.cwd).toBe("/other");
});

test("clearing an aliased list leaves the original list and its other aliases in place", () => {
  const yaml = GITHUB_ALIAS_YAML.replace(
    "  prompt: Review the issue.",
    "  prompt: Review the issue.\n  agent: { provider: codex, mode: full-access, options: { checked: *names } }",
  ).replace("  agent: { provider: codex, mode: full-access }\n", "");
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const saved = mergeTriggerForm(yaml, { ...projection.value, qualifiers: { labels: "" } });
  if (saved.status !== "ok") throw new Error(saved.reason);
  expect(saved.yaml).toContain("from_users: &names");
  expect(saved.yaml).toContain("checked: *names");
  expect(saved.yaml).toContain("- alice # keep Alice");
  expect(parseTriggerDocument(saved.yaml).on["github.issue_created"]?.filters).toEqual({
    from_users: ["alice"],
  });
});

test("keeps an anchored progress flag and its alias during an unrelated edit", () => {
  const yaml = ADVANCED.replace(
    "enabled: true",
    "enabled: true\nprogress_message: &flag false",
  ).replace("sandbox_mode: workspace-write", "report: *flag");
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  const saved = mergeTriggerForm(yaml, { ...projection.value, cwd: "/other" });
  if (saved.status !== "ok") throw new Error(saved.reason);
  expect(saved.yaml).toContain("progress_message: &flag false");
  expect(saved.yaml).toContain("report: *flag");
  expect(documentRun(parseTriggerDocument(saved.yaml)).target.cwd).toBe("/other");
});
