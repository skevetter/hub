import { describe, expect, it } from "vitest";
import { compileTriggerDocument, parseTriggerDocument } from "./index.js";
import {
  addStep,
  changeStepAction,
  createTriggerYaml,
  earlierStepOutputs,
  mergeTriggerForm,
  moveStep,
  newStepFormValue,
  patchTriggerYaml,
  projectTriggerForm,
  remapStepErrors,
  removeStep,
  sharedYamlField,
  stepListEditError,
  triggerFormErrors,
  type TriggerFormValue,
  type TriggerStepFormValue,
} from "./editor.js";

const ON = `on:
  slack.mention:
    connection: acme-slack
    filters:
      from_users: [U0BNGPZEXT2]
`;

const RUN = `name: build-review
${ON}run:
  target: { daemon: devbox, cwd: /workspace/app }
  agent: { provider: codex, mode: full-access }
  prompt: Review it.
`;

const STEPS = `name: build-review
# the build comes first
${ON}max_runtime: 3h
target: { daemon: devbox, cwd: /workspace/app }
steps:
  - id: plan
    agent: { provider: codex, mode: full-access }
    prompt: Plan it.
    title: Plan \${{ paseo.execution.id }} # keep this
    env: { MODE: plan }
    output:
      schema:
        type: object
        properties:
          verdict: { enum: [ok, fix] }
          reason: { type: string }
  - id: build
    # run the build
    script: npm run build
    max_runtime: 15m
  - id: fix
    if: "\${{ steps.plan.outputs.verdict == 'fix' }}"
    agent: { provider: codex, mode: full-access }
    prompt: Fix it.
    continuation: { mode: conversation }
`;

const ANCHORED_STEPS = STEPS.replace("prompt: Plan it.", "prompt: &p Plan it.")
  .replace("prompt: Fix it.", "prompt: *p")
  .replace("    if: \"${{ steps.plan.outputs.verdict == 'fix' }}\"\n", "");

const ALIAS_REFUSAL =
  "This change would break a YAML alias. Edit the anchor or alias in YAML first.";

function form(yaml: string): TriggerFormValue {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  return projection.value;
}

function step(value: TriggerFormValue, index: number): TriggerStepFormValue {
  const found = value.steps[index];
  if (found === undefined) throw new Error(`no step ${String(index)}`);
  return found;
}

function withStep(value: TriggerFormValue, index: number, patch: Partial<TriggerStepFormValue>) {
  return { ...value, steps: value.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) };
}

function agentStep(id: string): TriggerStepFormValue {
  return newStepFormValue({
    id,
    agent: "codex",
    mode: "full-access",
    prompt: "Go",
    continuationMode: "new",
  });
}

/** Fills in what a step added in the form still needs, as a person would. */
function complete(value: TriggerFormValue): TriggerFormValue {
  return {
    ...value,
    steps: value.steps.map((entry) =>
      entry.action === "script"
        ? { ...entry, script: entry.script || "make" }
        : {
            ...entry,
            agent: entry.agent || "codex",
            mode: entry.mode || "full-access",
            prompt: entry.prompt || "Go",
          },
    ),
  };
}

function patched(yaml: string, value: TriggerFormValue): string {
  const result = mergeTriggerForm(yaml, value);
  if (result.status !== "ok") throw new Error(result.reason);
  return result.yaml;
}

describe("projecting a document with steps", () => {
  it("is editable, with the trigger's own event and each step's fields", () => {
    const value = form(STEPS);
    expect(value.event).toBe("slack.mention");
    expect(value.daemon).toBe("devbox");
    expect(value.runMaxRuntime).toBe("3h");
    expect(value.steps.map(({ id, action, origin }) => [id, action, origin])).toEqual([
      ["plan", "prompt", 0],
      ["build", "script", 1],
      ["fix", "prompt", 2],
    ]);
    expect(step(value, 2).runIf).toBe("${{ steps.plan.outputs.verdict == 'fix' }}");
    expect(JSON.parse(step(value, 0).outputSchema)).toMatchObject({ type: "object" });
  });

  it("starts a list step as a new agent and a run as a conversation", () => {
    expect(step(form(STEPS), 0).continuationMode).toBe("new");
    expect(step(form(STEPS), 2).continuationMode).toBe("conversation");
    const run = form(RUN);
    expect(step(run, 0).continuationMode).toBe("conversation");
    expect(step(run, 0).id).toBe("run");
    expect(run.runMaxRuntime).toBe("");
  });

  it("leaves a document that chooses between agents to YAML", () => {
    const choices = STEPS.replace(
      "agent: { provider: codex, mode: full-access }\n    prompt: Plan it.",
      "agent:\n      select: codex\n      choices:\n        codex: { provider: codex, mode: full-access }\n    prompt: Plan it.",
    );
    expect(projectTriggerForm(choices)).toEqual({
      status: "yaml_only",
      reason: "Agent choices can only be edited in YAML.",
    });
  });
});

describe("writing steps", () => {
  it("leaves an unchanged run document byte for byte", () => {
    expect(patchTriggerYaml(RUN, form(RUN))).toBe(RUN);
    expect(patchTriggerYaml(STEPS, form(STEPS))).toBe(STEPS);
  });

  it("keeps one plain step as run and writes anything else as steps", () => {
    const base = form(RUN);
    expect(createTriggerYaml(base)).toContain("run:");
    const conditioned = withStep(base, 0, { runIf: "${{ paseo.inputs.go }}" });
    expect(createTriggerYaml(conditioned)).toContain("steps:");
    expect(createTriggerYaml(withStep(base, 0, { id: "review" }))).toContain("steps:");
    const schema = withStep(base, 0, { outputSchema: '{"type":"object"}' });
    const written = createTriggerYaml(schema);
    expect(written).toContain("steps:");
    expect(parseTriggerDocument(written).steps?.[0]).toMatchObject({
      id: "run",
      output: { schema: { type: "object" } },
    });
  });

  it("keeps every other step byte-identical when one step of a list is edited", () => {
    const edited = patched(STEPS, withStep(form(STEPS), 0, { prompt: "Plan it twice." }));
    expect(edited).toContain("prompt: Plan it twice.");
    const rest = STEPS.slice(STEPS.indexOf("  - id: build"));
    expect(edited.endsWith(rest)).toBe(true);
    expect(patched(STEPS, form(STEPS))).toBe(STEPS);
  });

  it("converts a plain run without aliases when a step is added", () => {
    const yaml = patched(RUN, complete(addStep(form(RUN))));
    const document = parseTriggerDocument(yaml);
    expect(document.run).toBeUndefined();
    expect(document.target).toEqual({ daemon: "devbox", cwd: "/workspace/app" });
    expect(document.steps?.map(({ id }) => id)).toEqual(["run", "step-2"]);
    expect(document.steps?.[0]).toMatchObject({ continuation: { mode: "conversation" } });
    expect(document.steps?.[1]).not.toHaveProperty("continuation");
    expect(() => compileTriggerDocument(yaml)).not.toThrow();
  });

  it("converts a run when its alias keeps the same anchor", () => {
    const yaml = RUN.replace("name: build-review", "name: &p review").replace(
      "prompt: Review it.",
      "prompt: *p",
    );
    const converted = patched(yaml, complete(addStep(form(yaml))));
    expect(converted).toContain("prompt: *p");
    expect(parseTriggerDocument(converted).steps?.[0]).toMatchObject({ prompt: "review" });
  });

  it("keeps a one-step list as a list, and does not write a continuation for a new agent", () => {
    const one = `name: build-review
${ON}target: { daemon: devbox, cwd: /workspace/app }
steps:
  - id: run
    agent: { provider: codex, mode: full-access }
    prompt: Review it.
`;
    const edited = patched(one, withStep(form(one), 0, { prompt: "Review it twice." }));
    expect(edited).toContain("steps:");
    expect(edited).not.toContain("run:\n");
    expect(edited).not.toContain("continuation");
  });

  it("reorders and removes steps without losing what the form does not own", () => {
    const moved = patched(STEPS, moveStep(form(STEPS), 1, 0));
    const document = parseTriggerDocument(moved);
    expect(document.steps?.map(({ id }) => id)).toEqual(["build", "plan", "fix"]);
    expect(document.steps?.[1]).toMatchObject({ env: { MODE: "plan" } });
    expect(moved).toContain("# keep this");
    expect(moved).toContain("# run the build");
    expect(moved).toContain("# the build comes first");
    const removed = patched(STEPS, removeStep(form(STEPS), 1));
    expect(parseTriggerDocument(removed).steps?.map(({ id }) => id)).toEqual(["plan", "fix"]);
  });

  it("follows a step through a rename and a move", () => {
    const renamed = withStep(moveStep(form(STEPS), 1, 0), 0, { id: "compile" });
    const document = parseTriggerDocument(patched(STEPS, renamed));
    expect(document.steps?.map(({ id }) => id)).toEqual(["compile", "plan", "fix"]);
    expect(document.steps?.[0]).toMatchObject({ script: "npm run build", max_runtime: "15m" });
    expect(document.steps?.[1]).toMatchObject({ env: { MODE: "plan" } });
  });

  it("does not inherit hidden fields when a new step reuses a removed ID", () => {
    const source = STEPS.replace("env: { MODE: plan }", "env: { KEEP: hidden }");
    const value = withStep(form(source), 2, { runIf: "" });
    const added = addStep(removeStep(value, 0));
    const replacement = complete(withStep(added, 2, { id: "plan" }));
    const document = parseTriggerDocument(patched(source, replacement));
    expect(document.steps?.[2]).toMatchObject({ id: "plan" });
    expect(document.steps?.[2]).not.toHaveProperty("env");
  });

  it("refuses to patch a list with an orphaned alias without throwing", () => {
    const value = form(ANCHORED_STEPS);
    const changed = { ...value, steps: value.steps.slice(1) };
    expect(patchTriggerYaml(ANCHORED_STEPS, changed)).toBe(ANCHORED_STEPS);
    expect(mergeTriggerForm(ANCHORED_STEPS, changed)).toEqual({
      status: "incomplete",
      reason: ALIAS_REFUSAL,
    });
  });

  it("refuses to convert a run when its alias would resolve to a different anchor", () => {
    const run = RUN.replace(ON, "")
      .replace("name: build-review", "name: &p review")
      .replace("prompt: Review it.", "prompt: *p");
    const yaml = run + ON.replace("connection: acme-slack", "connection: &p work-slack");
    const value = form(yaml);
    expect(step(value, 0).prompt).toBe("review");
    const changed = complete(addStep(value));
    expect(patchTriggerYaml(yaml, changed)).toBe(yaml);
    expect(mergeTriggerForm(yaml, changed)).toEqual({
      status: "incomplete",
      reason: ALIAS_REFUSAL,
    });
  });

  it("refuses to replace a run when the surviving target alias would lose its anchor", () => {
    const yaml = RUN.replace("run:\n", "run:\n  prompt: &dir /workspace/app\n")
      .replace("cwd: /workspace/app", "cwd: *dir")
      .replace("  prompt: Review it.\n", "");
    const added = complete(addStep(form(yaml)));
    const replacement = withStep({ ...added, steps: added.steps.slice(1) }, 0, { id: "run" });
    expect(mergeTriggerForm(yaml, replacement)).toEqual({
      status: "incomplete",
      reason: ALIAS_REFUSAL,
    });
    expect(patchTriggerYaml(yaml, replacement)).toBe(yaml);
    expect(stepListEditError(added, { kind: "remove", index: 0 })).toBe(ALIAS_REFUSAL);
    expect(removeStep(added, 0)).toBe(added);
  });

  it("adds a step, writes the whole-run deadline, and drops a cleared condition", () => {
    const value = complete(addStep(form(STEPS), "script"));
    const yaml = patched(STEPS, withStep({ ...value, runMaxRuntime: "" }, 2, { runIf: "" }));
    const document = parseTriggerDocument(yaml);
    expect(document.max_runtime).toBeUndefined();
    expect(document.steps?.[2]).not.toHaveProperty("if");
    expect(document.steps?.at(-1)).toMatchObject({ id: "step-4", max_runtime: "10m" });
    expect(
      parseTriggerDocument(patched(RUN, { ...form(RUN), runMaxRuntime: "1h" })).max_runtime,
    ).toBe("1h");
  });

  it("drops a script's output schema and the agent keys when the action changes", () => {
    const value = changeStepAction(form(STEPS), 0, "script");
    expect(step(value, 0).outputSchema).toBe("");
    expect(step(value, 0).agent).toBe("codex");
    const yaml = patched(STEPS, withStep(value, 0, { script: "make" }));
    const [first] = parseTriggerDocument(yaml).steps ?? [];
    expect(first).toMatchObject({ id: "plan", script: "make", max_runtime: "10m" });
    for (const key of ["agent", "prompt", "env", "title", "output"]) {
      expect(first).not.toHaveProperty(key);
    }
  });

  it("keeps a run's existing output schema on the run, and moves to steps for a new one", () => {
    const withSchema = RUN.replace(
      "  prompt: Review it.\n",
      "  prompt: Review it.\n  output:\n    schema: { type: object }\n",
    );
    const moved = patched(withSchema, { ...form(withSchema), cwd: "/other" });
    expect(moved).toContain("run:");
    expect(moved).toContain("cwd: /other");
    expect(moved).not.toContain("steps:");
    const added = patched(RUN, withStep(form(RUN), 0, { outputSchema: '{"type":"object"}' }));
    expect(added).toContain("steps:");
  });

  it("keeps shorthand when an existing output schema is edited", () => {
    const yaml = `${RUN}  output:\n    schema: { type: object }\n`;
    const outputSchema = '{"type":"object","properties":{"verdict":{"type":"string"}}}';
    const saved = patched(yaml, withStep(form(yaml), 0, { outputSchema }));
    expect(parseTriggerDocument(saved).run).toMatchObject({
      output: { schema: { properties: { verdict: { type: "string" } } } },
    });
  });
});

describe("the step list helpers", () => {
  it("refuses to remove the last step or add past the limit", () => {
    const one = form(RUN);
    expect(removeStep(one, 0)).toBe(one);
    let many = one;
    for (let count = 0; count < 25; count++) many = addStep(many);
    expect(many.steps).toHaveLength(20);
    expect(new Set(many.steps.map(({ id }) => id)).size).toBe(20);
  });

  it("refuses to remove the anchor of a surviving alias", () => {
    const value = structuredClone(form(ANCHORED_STEPS));
    expect(removeStep(value, 0)).toBe(value);
    expect(stepListEditError(value, { kind: "remove", index: 0 })).toContain("YAML alias");
    expect(stepListEditError(value, { kind: "remove", index: 2 })).toBeUndefined();
    expect(removeStep(value, 2).steps).toHaveLength(2);
  });

  it("refuses to put an alias before its anchor and allows safe moves", () => {
    const value = form(ANCHORED_STEPS);
    expect(moveStep(value, 0, 2)).toBe(value);
    expect(moveStep(value, 1, 0).steps.map(({ id }) => id)).toEqual(["build", "plan", "fix"]);
  });

  it("lists the fields earlier agent steps declare, and nothing for invalid JSON", () => {
    const value = form(STEPS);
    expect(earlierStepOutputs(value, 2)).toEqual([{ id: "plan", fields: ["verdict", "reason"] }]);
    expect(earlierStepOutputs(value, 0)).toEqual([]);
    const broken = withStep(value, 0, { outputSchema: "{ nope" });
    expect(earlierStepOutputs(broken, 2)).toEqual([]);
  });

  it("re-keys errors with the step they belong to", () => {
    const errors = {
      name: "n",
      "steps.0.id": "a",
      "steps.1.prompt": "b",
      "steps.2.runIf": "c",
    } as const;
    expect(remapStepErrors(errors, { kind: "remove", index: 1 })).toEqual({
      name: "n",
      "steps.0.id": "a",
      "steps.1.runIf": "c",
    });
    expect(remapStepErrors(errors, { kind: "move", from: 2, to: 0 })).toEqual({
      name: "n",
      "steps.1.id": "a",
      "steps.2.prompt": "b",
      "steps.0.runIf": "c",
    });
  });
});

describe("step errors", () => {
  it("flags an empty, malformed or repeated id on the step", () => {
    const value = form(STEPS);
    const errors = triggerFormErrors(withStep(withStep(value, 1, { id: "plan" }), 2, { id: "" }));
    expect(errors["steps.1.id"]).toBe("Another step already uses this ID.");
    expect(errors["steps.2.id"]).toBe("Step ID is required.");
    expect(triggerFormErrors(withStep(value, 0, { id: "Plan 1" }))["steps.0.id"]).toMatch(
      /lowercase/u,
    );
  });

  it("rejects surrounding whitespace on step IDs", () => {
    expect(triggerFormErrors(withStep(form(STEPS), 1, { id: " build " }))["steps.1.id"]).toBe(
      "Step ID cannot start or end with a space.",
    );
  });

  it("flags a condition that reads a removed or later step, and never rewrites it", () => {
    const value = form(STEPS);
    const removed = removeStep(value, 0);
    expect(triggerFormErrors(removed)["steps.1.runIf"]).toContain('Step "plan"');
    expect(step(removed, 1).runIf).toBe(step(value, 2).runIf);
    const moved = moveStep(value, 2, 0);
    expect(triggerFormErrors(moved)["steps.0.runIf"]).toContain('Step "plan"');
    expect(triggerFormErrors(value)["steps.2.runIf"]).toBeUndefined();
  });

  it("ignores step paths in quoted strings just like the compiler", () => {
    const runIf = "${{ paseo.prompt == 'steps.missing.outputs.foo' }}";
    const value = withStep(form(STEPS), 2, { runIf });
    expect(triggerFormErrors(value)["steps.2.runIf"]).toBeUndefined();
    expect(() => compileTriggerDocument(patched(STEPS, value))).not.toThrow();
  });

  it("detects a forward reference with whitespace around path separators", () => {
    const runIf = "  ${{ steps . plan . outputs . verdict == 'fix' }}  ";
    const value = withStep(form(STEPS), 2, { runIf });
    const moved = moveStep(value, 2, 0);
    expect(triggerFormErrors(moved)["steps.0.runIf"]).toContain('Step "plan"');
    expect(step(moved, 0).runIf).toBe(runIf);
    expect(step(form(patched(STEPS, value)), 2).runIf).toBe(runIf);
  });

  it("checks the output schema, the step count and each step's own fields", () => {
    const value = form(STEPS);
    expect(
      triggerFormErrors(withStep(value, 0, { outputSchema: "[]" }))["steps.0.outputSchema"],
    ).toBe("Output schema must be a JSON object.");
    expect(triggerFormErrors(withStep(value, 2, { prompt: " " }))["steps.2.prompt"]).toBe(
      "Instructions are required.",
    );
    expect(triggerFormErrors({ ...value, steps: [] }).steps).toBe("Add at least one step.");
    expect(() => createTriggerYaml(withStep(value, 1, { script: "" }))).toThrow(
      "Script is required.",
    );
  });

  it("requires named callers when any step is a script", () => {
    const value = { ...form(RUN), event: "manual.run" as const, allowedUsers: "*" };
    const withScript = addStep(value, "script");
    expect(triggerFormErrors(withScript).allowedUsers).toBe(
      "Name the people allowed to start a script. It cannot run for everyone.",
    );
  });

  it("reports a shared field of one step on that step", () => {
    const anchored = STEPS.replace("prompt: Plan it.", "prompt: &p Plan it.").replace(
      "prompt: Fix it.",
      "prompt: *p",
    );
    const value = form(anchored);
    expect(sharedYamlField(value, "steps.0.prompt").disabled).toBe(true);
    expect(sharedYamlField(value, "steps.2.prompt").disabled).toBeUndefined();
    expect(sharedYamlField(value, "steps.1.script").disabled).toBeUndefined();
  });
});

describe("a new document", () => {
  it("writes steps that compile", () => {
    const value = complete(addStep({ ...form(RUN), steps: [agentStep("run")] }));
    const yaml = createTriggerYaml(value);
    expect(compileTriggerDocument(yaml).events[0]?.steps.map(({ id }) => id)).toEqual([
      "run",
      "step-2",
    ]);
  });
});
