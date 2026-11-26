import { expect, it } from "vitest";
import { MAX_TRIGGER_STEPS, TriggerDocumentSchema, TriggerInputSchema } from "./schema.js";
import { normalizeSteps } from "./steps.js";

it("reports an empty event map before an empty agent choice map", () => {
  const result = TriggerDocumentSchema.safeParse({
    name: "example",
    on: {},
    run: {
      target: { daemon: "dev", cwd: "/workspace" },
      agent: { select: "agent", choices: {} },
      prompt: "Run",
    },
  });
  expect(result.error?.issues).toEqual([
    { code: "custom", path: ["on"], message: "at least one event is required" },
    {
      code: "custom",
      path: ["run", "agent", "choices"],
      message: "at least one agent choice is required",
    },
  ]);
});

it.each([
  [Number.MAX_VALUE, true],
  [0, true],
  [Infinity, false],
  [-Infinity, false],
  [NaN, false],
])("validates a numeric default of %s", (value, accepted) => {
  expect(TriggerInputSchema.safeParse({ type: "number", default: value }).success).toBe(accepted);
});

it.each([Infinity, -Infinity, NaN])("rejects non-finite numeric choice %s", (value) => {
  const result = TriggerInputSchema.safeParse({ type: "number", choices: [0, value] });
  expect(result.error?.issues.map((issue) => issue.path)).toEqual([["choices", 1]]);
});

const target = { daemon: "dev", cwd: "/workspace" };
const agentStep = (id: string) => ({ id, agent: { provider: "codex" }, prompt: "Go" });
const base = { name: "example", on: { "manual.run": {} } };
const issues = (document: object) =>
  TriggerDocumentSchema.safeParse({ ...base, ...document }).error?.issues.map(
    ({ path, message }) => ({ path, message }),
  );

it("accepts steps with one shared target and normalizes run to a single step", () => {
  const many = TriggerDocumentSchema.parse({
    ...base,
    target,
    steps: [agentStep("plan"), { id: "check", script: "true" }],
  });
  expect(normalizeSteps(many)).toMatchObject({ target, shorthand: false });
  expect(normalizeSteps(many).steps.map((step) => step.id)).toEqual(["plan", "check"]);

  const one = TriggerDocumentSchema.parse({
    ...base,
    run: { target, agent: { provider: "codex" }, prompt: "Go" },
  });
  const normalized = normalizeSteps(one);
  expect(normalized).toMatchObject({ target, shorthand: true });
  expect(normalized.steps).toHaveLength(1);
  expect(normalized.steps[0]).toMatchObject({
    id: "run",
    agent: { provider: "codex" },
    prompt: "Go",
  });
  expect(normalized.steps[0]).not.toHaveProperty("target");
});

it("requires exactly one of run and steps", () => {
  const run = { target, agent: { provider: "codex" }, prompt: "Go" };
  expect(issues({ run, target, steps: [agentStep("a")] })).toContainEqual({
    path: ["steps"],
    message: "Use run for one step or steps for several, not both.",
  });
  expect(issues({})).toEqual([
    { path: [], message: "A trigger needs run for one step or steps for several." },
  ]);
});

it("keeps the target at the top level for steps and inside run for run", () => {
  expect(issues({ steps: [agentStep("a")] })).toEqual([
    { path: ["target"], message: "steps needs a top-level target with a daemon and a cwd." },
  ]);
  expect(issues({ target, run: { target, script: "true" } })).toEqual([
    {
      path: ["target"],
      message: "A top-level target goes with steps. With run, put target inside run.",
    },
  ]);
  expect(issues({ target, steps: [{ ...agentStep("a"), target }] })).toEqual([
    {
      path: ["steps", 0, "target"],
      message:
        "target is set once for all steps. Put it at the top level of the document, next to steps.",
    },
  ]);
});

it("caps steps at the maximum and rejects an empty list", () => {
  const steps = (count: number) =>
    Array.from({ length: count }, (_, i) => agentStep(`s${String(i)}`));
  expect(issues({ target, steps: steps(MAX_TRIGGER_STEPS) })).toBeUndefined();
  expect(issues({ target, steps: steps(MAX_TRIGGER_STEPS + 1) })).toEqual([
    { path: ["steps"], message: "A trigger can have at most 20 steps." },
  ]);
  expect(issues({ target, steps: [] })).toEqual([
    { path: ["steps"], message: "steps needs at least one step." },
  ]);
});

it("reports a duplicate step id at the second step", () => {
  expect(issues({ target, steps: [agentStep("a"), agentStep("a")] })).toEqual([
    { path: ["steps", 1, "id"], message: 'The step id "a" is used more than once.' },
  ]);
});

it("refuses agent options on a script step and a worktree with a script step", () => {
  expect(issues({ target, steps: [{ id: "s", script: "true", prompt: "x" }] })?.[0]?.path).toEqual([
    "steps",
    0,
    "prompt",
  ]);
  expect(
    issues({
      target: { ...target, worktree: { mode: "branch-off", newBranch: "x" } },
      steps: [{ id: "s", script: "true" }],
    })?.[0]?.path,
  ).toEqual(["target", "worktree"]);
});

it("addresses an empty agent choice map inside steps", () => {
  expect(
    issues({
      target,
      steps: [{ id: "a", agent: { select: "agent", choices: {} }, prompt: "Go" }],
    }),
  ).toEqual([
    { path: ["steps", 0, "agent", "choices"], message: "at least one agent choice is required" },
  ]);
});
