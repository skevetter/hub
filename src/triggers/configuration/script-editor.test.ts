import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  changeStepAction,
  createTriggerYaml,
  mergeTriggerForm,
  needsActorFilter,
  newStepFormValue,
  patchTriggerYaml,
  projectTriggerForm,
  triggerFormErrors,
  type TriggerFormValue,
  type TriggerStepFormValue,
} from "./editor.js";
import { SCRIPT_NOTIFICATION_REASONS } from "./events.js";
import { compileTriggerDocument } from "./index.js";
import { agentRun, isScriptRun, TriggerDocumentSchema } from "./schema.js";
import { documentRun } from "./steps.js";

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

function withStep(value: TriggerFormValue, patch: Partial<TriggerStepFormValue>) {
  return {
    ...value,
    steps: value.steps.map((step, index) => (index === 0 ? { ...step, ...patch } : step)),
  };
}

function scriptForm(
  overrides: Partial<TriggerFormValue> = {},
  step: Partial<TriggerStepFormValue> = {},
): TriggerFormValue {
  return {
    name: "deploy",
    enabled: true,
    event: "slack.mention",
    connection: "acme-slack",
    allowedUsers: "U1, U2",
    qualifiers: {},
    daemon: "devbox",
    cwd: "/workspace/webapp",
    runMaxRuntime: "",
    steps: [
      newStepFormValue({
        maxRuntime: "10m",
        action: "script",
        script: "./deploy.sh\n",
        ...step,
      }),
    ],
    ...overrides,
  };
}

describe("script trigger form bridge", () => {
  test("projects a script document onto a script form", () => {
    const value = editable(SCRIPT_YAML);
    expect(value).toMatchObject({
      steps: [
        {
          action: "script",
          script: 'set -e\nnpm ci\necho "$HUB_EVENT_JSON" | jq .\n',
          maxRuntime: "15m",
        },
      ],
      daemon: "devbox",
      cwd: "/workspace/webapp",
      event: "github.notification",
      qualifiers: { repo: "acme/webapp", reason: "review_requested" },
    });
  });

  test("returns the original YAML byte for byte when the form did not change", () => {
    expect(patchTriggerYaml(SCRIPT_YAML, editable(SCRIPT_YAML))).toBe(SCRIPT_YAML);
  });

  test("patches the script and keeps comments and filters the form does not own", () => {
    const value = editable(SCRIPT_YAML);
    const yaml = patchTriggerYaml(
      SCRIPT_YAML,
      withStep(value, {
        script: "make deploy\nmake verify\n",
        maxRuntime: "20m",
      }),
    );
    expect(yaml).toContain("# keep this heading");
    expect(yaml).toContain("contains: urgent");
    const document = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    const run = documentRun(document);
    expect(isScriptRun(run) && run.script).toBe("make deploy\nmake verify\n");
    expect(run.max_runtime).toBe("20m");
    expect(editable(yaml).steps[0]?.script).toBe("make deploy\nmake verify\n");
  });

  test("writes and projects the same progress opt-in for a script", () => {
    const yaml = createTriggerYaml(scriptForm({ progressMessage: true }));
    expect(editable(yaml).progressMessage).toBe(true);
    expect(compileTriggerDocument(yaml).events[0]?.progressMessage).toBe(true);

    const cleared = patchTriggerYaml(yaml, { ...editable(yaml), progressMessage: false });
    expect(parseDocument(cleared).has("progress_message")).toBe(false);
  });

  test("a multi-line script survives create, project, and merge unchanged", () => {
    const script = "set -eu\nif [ -n \"$HUB_EVENT_JSON\" ]; then\n  echo 'it''s \"quoted\"'\nfi\n";
    const yaml = createTriggerYaml(scriptForm({}, { script }));
    expect(editable(yaml).steps[0]?.script).toBe(script);
    const merged = mergeTriggerForm(yaml, { ...editable(yaml), name: "renamed" });
    if (merged.status !== "ok") throw new Error(merged.reason);
    expect(editable(merged.yaml)).toMatchObject({ name: "renamed", steps: [{ script }] });
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

  test("a notification script writes its repository and reason filters", () => {
    const yaml = createTriggerYaml(
      scriptForm({
        event: "github.notification",
        connection: "",
        allowedUsers: "*",
        qualifiers: { repo: " acme/webapp ", reason: "review_requested" },
      }),
    );
    expect(parseDocument(yaml).toJS()).toMatchObject({
      on: {
        "github.notification": {
          filters: { repo: "acme/webapp", reason: "review_requested" },
        },
      },
    });
    compileTriggerDocument(yaml);
  });

  test("switching a prompt trigger to a script drops the agent fields and keeps the target", () => {
    const prompt = createTriggerYaml(
      scriptForm({}, { action: "prompt", agent: "codex", mode: "full-access", prompt: "Do it." }),
    );
    const value = editable(prompt);
    const yaml = patchTriggerYaml(
      prompt,
      withStep(changeStepAction(value, 0, "script"), {
        script: "./deploy.sh",
      }),
    );
    const { run } = z
      .object({ run: z.record(z.string(), z.unknown()) })
      .parse(parseDocument(yaml).toJS());
    expect(Object.keys(run).sort()).toEqual(["max_runtime", "script", "target"]);
    compileTriggerDocument(yaml);
  });

  test("switching a script trigger back to a prompt writes the agent and removes the script", () => {
    const yaml = patchTriggerYaml(
      SCRIPT_YAML,
      withStep(changeStepAction(editable(SCRIPT_YAML), 0, "prompt"), {
        agent: "codex",
        mode: "full-access",
        prompt: "Review it.",
      }),
    );
    const document = TriggerDocumentSchema.parse(parseDocument(yaml).toJS());
    expect(isScriptRun(documentRun(document))).toBe(false);
    expect(agentRun(documentRun(document)).prompt).toBe("Review it.");
    expect(yaml).not.toContain("script:");
  });

  test("changing the action moves the run limit between the two defaults", () => {
    const agent = scriptForm({ allowedUsers: "*" }, { action: "prompt", maxRuntime: "2h" });
    const script = changeStepAction(agent, 0, "script");
    expect(script).toMatchObject({
      steps: [{ action: "script", maxRuntime: "10m" }],
      allowedUsers: "",
    });
    expect(changeStepAction(script, 0, "prompt").steps[0]?.maxRuntime).toBe("2h");
    expect(
      changeStepAction(scriptForm({}, { action: "prompt", maxRuntime: "45m" }), 0, "script")
        .steps[0]?.maxRuntime,
    ).toBe("45m");
  });

  test("an open audience is refused for a script on every provider event", () => {
    expect(needsActorFilter({ event: "slack.mention" })).toBe(true);
    expect(needsActorFilter({ event: "schedule.tick" })).toBe(false);
    expect(needsActorFilter({ event: "github.notification" })).toBe(false);
    for (const allowedUsers of ["*", "", "U1, *"]) {
      expect(triggerFormErrors(scriptForm({ allowedUsers })).allowedUsers).toMatch(
        /cannot run for everyone/u,
      );
    }
    expect(triggerFormErrors(scriptForm())).toEqual({});
  });

  test("a script on a manual run accepts a named key actor", () => {
    const errors = triggerFormErrors(
      scriptForm({ event: "manual.run", connection: "", allowedUsers: "alice" }),
    );
    expect(errors).toEqual({});
    expect(
      triggerFormErrors(scriptForm({ event: "manual.run", connection: "" }, { action: "prompt" }))[
        "steps.0.action"
      ],
    ).toBeUndefined();
  });

  test("a notification script needs a repository and one of the safe reasons", () => {
    const base = scriptForm({ event: "github.notification", connection: "", allowedUsers: "" });
    const errors = triggerFormErrors(base);
    expect(errors["qualifiers.repo"]).toMatch(/needs a repository/u);
    expect(errors["qualifiers.reason"]).toMatch(/needs a reason/u);
    expect(
      triggerFormErrors({ ...base, qualifiers: { repo: "acme/webapp", reason: "mention" } })[
        "qualifiers.reason"
      ],
    ).toMatch(/third parties can cause that notification/u);
    expect(
      triggerFormErrors({ ...base, qualifiers: { reason: "author" } })["qualifiers.repo"],
    ).toMatch(/needs a repository/u);
    for (const reason of SCRIPT_NOTIFICATION_REASONS) {
      expect(triggerFormErrors({ ...base, qualifiers: { repo: "acme/webapp", reason } })).toEqual(
        {},
      );
    }
  });

  test("a script form is checked for its own fields only", () => {
    const errors = triggerFormErrors(
      scriptForm(
        { daemon: "", cwd: "relative" },
        { script: "  \n", maxRuntime: "", idleTimeout: "" },
      ),
    );
    expect(Object.keys(errors)).toEqual(["daemon", "cwd", "steps.0.maxRuntime", "steps.0.script"]);
    expect(errors["steps.0.script"]).toBe("Script is required.");
  });

  test("a templated script is refused in the form with the way to read the event", () => {
    expect(
      triggerFormErrors(scriptForm({}, { script: "echo ${{ paseo.prompt }}" }))["steps.0.script"],
    ).toMatch(/HUB_EVENT_JSON/u);
  });

  test("a prompt form is still checked for its agent fields", () => {
    const errors = triggerFormErrors(scriptForm({}, { action: "prompt" }));
    expect(Object.keys(errors)).toEqual(["steps.0.agent", "steps.0.mode", "steps.0.prompt"]);
  });
});
