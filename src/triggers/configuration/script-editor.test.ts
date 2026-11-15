import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  changeTriggerAction,
  createTriggerYaml,
  mergeTriggerForm,
  needsActorFilter,
  patchTriggerYaml,
  projectTriggerForm,
  triggerFormErrors,
  type TriggerFormValue,
} from "./editor.js";
import { compileTriggerDocument } from "./index.js";
import { agentRun, isScriptRun, TriggerDocumentSchema } from "./schema.js";

const SCRIPT_YAML = `# keep this heading
name: build-on-review
enabled: true
on:
  github.notification:
    filters:
      repo: acme/webapp
      reason: review_requested
      contains: urgent
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: |
    set -e
    npm ci
    echo "$HUB_EVENT_JSON" | jq .
  max_runtime: 15m
`;

function editable(yaml: string): TriggerFormValue {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  return projection.value;
}

function scriptForm(overrides: Partial<TriggerFormValue> = {}): TriggerFormValue {
  return {
    name: "deploy",
    enabled: true,
    event: "slack.mention",
    connection: "acme-slack",
    allowedUsers: "U1, U2",
    qualifiers: {},
    daemon: "devbox",
    cwd: "/workspace/webapp",
    agent: "",
    mode: "",
    thinkingOptionId: "",
    providerOptions: "",
    continuationMode: "conversation",
    continuationKey: "",
    maxRuntime: "10m",
    idleTimeout: "10m",
    githubConnection: "",
    githubRepositories: "",
    githubPermissions: "",
    githubDuration: "",
    prompt: "",
    action: "script",
    script: "./deploy.sh\n",
    ...overrides,
  };
}

describe("script trigger form bridge", () => {
  test("projects a script document onto a script form", () => {
    const value = editable(SCRIPT_YAML);
    expect(value).toMatchObject({
      action: "script",
      script: 'set -e\nnpm ci\necho "$HUB_EVENT_JSON" | jq .\n',
      daemon: "devbox",
      cwd: "/workspace/webapp",
      maxRuntime: "15m",
      event: "github.notification",
      qualifiers: { repo: "acme/webapp", reason: "review_requested" },
    });
  });

  test("returns the original YAML byte for byte when the form did not change", () => {
    expect(patchTriggerYaml(SCRIPT_YAML, editable(SCRIPT_YAML))).toBe(SCRIPT_YAML);
  });

  test("patches the script and keeps comments and filters the form does not own", () => {
    const value = editable(SCRIPT_YAML);
    const yaml = patchTriggerYaml(SCRIPT_YAML, {
      ...value,
      script: "make deploy\nmake verify\n",
      maxRuntime: "20m",
    });
    expect(yaml).toContain("# keep this heading");
    expect(yaml).toContain("contains: urgent");
    const document = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    expect(isScriptRun(document.run) && document.run.script).toBe("make deploy\nmake verify\n");
    expect(document.run.max_runtime).toBe("20m");
    expect(editable(yaml).script).toBe("make deploy\nmake verify\n");
  });

  test("a multi-line script survives create, project, and merge unchanged", () => {
    const script = "set -eu\nif [ -n \"$HUB_EVENT_JSON\" ]; then\n  echo 'it''s \"quoted\"'\nfi\n";
    const yaml = createTriggerYaml(scriptForm({ script }));
    expect(editable(yaml).script).toBe(script);
    const merged = mergeTriggerForm(yaml, { ...editable(yaml), name: "renamed" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(editable(merged.yaml)).toMatchObject({ name: "renamed", script });
    compileTriggerDocument(merged.yaml);
  });

  test("creates a minimal script document without agent options", () => {
    const yaml = createTriggerYaml(scriptForm());
    expect(parseDocument(yaml).toJS()).toEqual({
      name: "deploy",
      enabled: true,
      on: {
        "slack.mention": { connection: "acme-slack", filters: { from_users: ["U1", "U2"] } },
      },
      run: {
        target: { daemon: "devbox", cwd: "/workspace/webapp" },
        script: "./deploy.sh\n",
        max_runtime: "10m",
      },
    });
    compileTriggerDocument(yaml);
  });

  test("a script on a manual run writes its named audience", () => {
    const yaml = createTriggerYaml(
      scriptForm({ event: "manual.run", connection: "", allowedUsers: "alice" }),
    );
    expect(parseDocument(yaml).toJS()).toMatchObject({
      on: { "manual.run": { filters: { from_users: ["alice"] } } },
    });
    expect(editable(yaml).allowedUsers).toBe("alice");
    compileTriggerDocument(yaml);
  });

  test("a notification script writes its repository and reason filters", () => {
    const yaml = createTriggerYaml(
      scriptForm({
        event: "github.notification",
        connection: "",
        allowedUsers: "*",
        qualifiers: { repo: " acme/webapp ", reason: "" },
      }),
    );
    expect(parseDocument(yaml).toJS()).toMatchObject({
      on: { "github.notification": { filters: { repo: "acme/webapp" } } },
    });
    compileTriggerDocument(yaml);
  });

  test("switching a prompt trigger to a script drops the agent fields and keeps the target", () => {
    const prompt = createTriggerYaml(
      scriptForm({ action: "prompt", agent: "codex", mode: "full-access", prompt: "Do it." }),
    );
    const value = editable(prompt);
    const yaml = patchTriggerYaml(prompt, {
      ...changeTriggerAction(value, "script"),
      script: "./deploy.sh",
    });
    const { run } = z
      .object({ run: z.record(z.string(), z.unknown()) })
      .parse(parseDocument(yaml).toJS());
    expect(Object.keys(run).sort()).toEqual(["max_runtime", "script", "target"]);
    compileTriggerDocument(yaml);
  });

  test("switching a script trigger back to a prompt writes the agent and removes the script", () => {
    const yaml = patchTriggerYaml(SCRIPT_YAML, {
      ...changeTriggerAction(editable(SCRIPT_YAML), "prompt"),
      agent: "codex",
      mode: "full-access",
      prompt: "Review it.",
    });
    const document = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    expect(isScriptRun(document.run)).toBe(false);
    expect(agentRun(document.run).prompt).toBe("Review it.");
    expect(yaml).not.toContain("script:");
  });

  test("changing the action moves the run limit between the two defaults", () => {
    const agent = scriptForm({ action: "prompt", maxRuntime: "2h", allowedUsers: "*" });
    const script = changeTriggerAction(agent, "script");
    expect(script).toMatchObject({ action: "script", maxRuntime: "10m", allowedUsers: "" });
    expect(changeTriggerAction(script, "prompt").maxRuntime).toBe("2h");
    expect(
      changeTriggerAction(scriptForm({ action: "prompt", maxRuntime: "45m" }), "script").maxRuntime,
    ).toBe("45m");
  });

  test("an open audience is refused for a script on every actor-driven event", () => {
    expect(needsActorFilter({ event: "slack.mention", action: "script" })).toBe(true);
    expect(needsActorFilter({ event: "manual.run", action: "script" })).toBe(true);
    expect(needsActorFilter({ event: "manual.run", action: "prompt" })).toBe(false);
    expect(needsActorFilter({ event: "schedule.tick", action: "script" })).toBe(false);
    expect(needsActorFilter({ event: "github.notification", action: "script" })).toBe(false);
    for (const allowedUsers of ["*", "", "U1, *"]) {
      expect(triggerFormErrors(scriptForm({ allowedUsers })).allowedUsers).toMatch(
        /cannot run for everyone/u,
      );
    }
    expect(
      triggerFormErrors(scriptForm({ event: "manual.run", allowedUsers: "*" })).allowedUsers,
    ).toMatch(/cannot run for everyone/u);
    expect(triggerFormErrors(scriptForm())).toEqual({});
  });

  test("a notification script needs a repository or a reason", () => {
    const base = scriptForm({ event: "github.notification", connection: "", allowedUsers: "" });
    expect(triggerFormErrors(base)["qualifiers.repo"]).toMatch(/repository or a reason/u);
    expect(triggerFormErrors({ ...base, qualifiers: { reason: "mention" } })).toEqual({});
    expect(triggerFormErrors({ ...base, qualifiers: { repo: "acme/webapp" } })).toEqual({});
  });

  test("a script form is checked for its own fields only", () => {
    const errors = triggerFormErrors(
      scriptForm({ script: "  \n", daemon: "", cwd: "relative", maxRuntime: "", idleTimeout: "" }),
    );
    expect(Object.keys(errors)).toEqual(["daemon", "cwd", "maxRuntime", "script"]);
    expect(errors.script).toBe("Script is required.");
  });

  test("a templated script is refused in the form with the way to read the event", () => {
    expect(triggerFormErrors(scriptForm({ script: "echo ${{ paseo.prompt }}" })).script).toMatch(
      /HUB_EVENT_JSON/u,
    );
  });

  test("a prompt form is still checked for its agent fields", () => {
    const errors = triggerFormErrors(scriptForm({ action: "prompt" }));
    expect(Object.keys(errors)).toEqual(["agent", "mode", "prompt"]);
  });
});
