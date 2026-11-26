import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { compileHubConfig, parseCompiledHubConfig } from "./compiler.js";

function configuration(trigger: Record<string, unknown> = {}, step: Record<string, unknown> = {}) {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "run",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "work",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Do the work." }],
            ...step,
          },
        ],
        ...trigger,
      },
    ],
  };
}

function hasOrderedSchemaIssues(error: unknown): boolean {
  assert.ok(error instanceof z.ZodError);
  assert.deepEqual(
    error.issues.map(({ code, path, message }) => ({ code, path, message })),
    [
      {
        code: "custom",
        path: ["triggers", 0, "steps", 0, "allow_outputs", 0, "max"],
        message: "required outputs must have max at least 1",
      },
      {
        code: "invalid_union",
        path: ["triggers", 0, "inputs", "count", "default"],
        message: "Invalid input",
      },
    ],
  );
  return true;
}

function assertIssue(
  run: () => unknown,
  message: string,
  path?: readonly (string | number)[],
): void {
  assert.throws(run, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    assert.deepEqual(Reflect.get(error, "path"), path);
    return true;
  });
}

describe("compiler characterization", () => {
  it("reports authored issues in schema order", () => {
    const raw = configuration(
      { inputs: { count: { type: "number", default: Infinity } } },
      { allow_outputs: [{ type: "manual.reply", max: 0, required: true }] },
    );
    assert.throws(() => compileHubConfig(raw), hasOrderedSchemaIssues);
  });

  it("requires a project on a Linear scout and an actor on reactive events", () => {
    const scout = { on: "linear.issue_entered_scope" };
    const reactive = { on: "linear.comment_created" };
    assert.doesNotThrow(() =>
      compileHubConfig(configuration({ ...scout, filters: { project: "project" } })),
    );
    assert.throws(() => compileHubConfig(configuration(scout)), {
      message: "trigger run requires filters.project for linear.issue_entered_scope",
    });
    assert.doesNotThrow(() =>
      compileHubConfig(configuration({ ...reactive, filters: { from_users: ["maintainer"] } })),
    );
    assert.throws(() => compileHubConfig(configuration(reactive)), {
      message:
        "trigger run requires a non-empty filters.from_users allowlist for externally sourced events",
    });
  });

  it("requires daemon environments selected from finite inputs", () => {
    const raw = configuration(
      { inputs: { target: { type: "string", choices: ["runner"], default: "runner" } } },
      { environment: "${{ paseo.inputs.target }}" },
    );
    const compiled = compileHubConfig(raw);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
    assert.throws(
      () =>
        compileHubConfig({
          ...raw,
          environments: [{ name: "runner", kind: "fly", image: "image" }],
        }),
      { message: "trigger run step work environment choice runner must be a daemon environment" },
    );
    assert.throws(
      () =>
        compileHubConfig(
          configuration(
            { inputs: { target: { type: "string", default: "runner" } } },
            { environment: "${{ paseo.inputs.target }}" },
          ),
        ),
      {
        path: ["triggers", "run", "steps", "work", "environment"],
        message: "step work environment uses input target without finite choices",
      },
    );
  });

  it("includes absent optional inputs in authority choices and evaluates fallbacks", () => {
    const trigger = { inputs: { target: { type: "string", choices: ["runner"] } } };
    assert.throws(
      () => compileHubConfig(configuration(trigger, { environment: "${{ paseo.inputs.target }}" })),
      {
        path: ["triggers", "run", "steps", "work", "environment"],
        message: "step work resolves to unknown environment null",
      },
    );
    const environment = '${{ paseo.inputs.target ?? "runner" }}';
    const compiled = compileHubConfig(configuration(trigger, { environment }));
    assert.equal(compiled.triggers[0]?.steps[0]?.environment, environment);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
  });

  it("rejects stored input defaults outside the permitted choices", () => {
    const compiled = compileHubConfig(
      configuration({ inputs: { target: { type: "string", choices: ["runner"] } } }),
    );
    const validTrigger = compiled.triggers[0];
    assert.ok(validTrigger);
    const tampered = {
      ...compiled,
      triggers: [
        {
          ...validTrigger,
          inputs: {
            target: { type: "string", required: false, choices: ["runner"], default: "x" },
          },
        },
      ],
    };
    assert.throws(() => parseCompiledHubConfig(tampered), {
      message: "active configuration contains an invalid compiled workflow contract",
    });
  });

  it("validates env templates before reserved GitHub keys and retains authority defaults", () => {
    const github = { connection: "github-app", repositories: ["owner/repo"] };
    const compiled = compileHubConfig(configuration({}, { github, env: { LOCAL: "value" } }));
    assert.deepEqual(compiled.triggers[0]?.steps[0], {
      id: "work",
      environment: "runner",
      maxRuntimeMs: 600_000,
      idleTimeoutMs: 60_000,
      agent: { provider: "codex" },
      prompt: [{ kind: "text", value: "Do the work." }],
      env: { LOCAL: "value" },
      github: { ...github, permissions: { contents: "read" }, durationMs: 3_600_000 },
      allowOutputs: [],
      autoArchive: false,
      background: false,
    });
    assert.throws(
      () => compileHubConfig(configuration({}, { github, env: { GH_TOKEN: "value" } })),
      {
        message:
          "trigger run step work env.GH_TOKEN: reserved by the step-level github authority; remove it from env",
      },
    );
    assert.throws(
      () =>
        compileHubConfig(
          configuration({}, { github, env: { GH_TOKEN: "${{ paseo.inputs.target }}" } }),
        ),
      /env\.GH_TOKEN.*paseo\.connections/u,
    );
  });
});

const scriptStep = { id: "work", environment: "runner", max_runtime: "10m", script: "true" };
const notificationPrefix =
  "trigger run runs a script on github.notification, which has no actor to allowlist.";
const notificationFromUsers =
  "trigger run: github.notification has no commenter or author, so it does not accept from_users.";
const notificationReasons = "author, assign, review_requested, state_change, ci_activity";

describe("trigger launch security", () => {
  it.each([undefined, [], ["maintainer", "*"]].map((users) => ({ users })))(
    "requires named script actors: $users",
    ({ users }) => {
      const raw = configuration({
        on: "github.push",
        filters: { from_users: users },
        steps: [scriptStep],
      });
      assertIssue(
        () => compileHubConfig(raw),
        "trigger run runs a script, so github.push needs filters.from_users that names the people allowed to start it. A wildcard or empty list would let anyone who can reach this event run code on the host.",
      );
    },
  );

  it.each([
    ["scheduled script", { on: "schedule.tick", steps: [scriptStep] }],
    [
      "named script actor",
      { on: "github.push", filters: { from_users: ["maintainer"] }, steps: [scriptStep] },
    ],
    [
      "protected notification",
      {
        on: "github.notification",
        filters: { repo: "owner/repo", reason: "review_requested" },
        steps: [scriptStep],
      },
    ],
    ["Hub event without actors", { on: "manual.run" }],
    ["project-scoped scout", { on: "linear.issue_entered_scope", filters: { project: "project" } }],
  ] as const)("accepts %s", (_name, trigger) => {
    const compiled = compileHubConfig(configuration(trigger));
    assert.equal(compiled.triggers[0]?.on, trigger.on);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
  });

  it("reports missing notification repository before rejecting from_users", () => {
    const on = "github.notification";
    const steps = [scriptStep];
    const filters = { reason: "review_requested", from_users: ["maintainer"] };
    assertIssue(
      () => compileHubConfig(configuration({ on, steps, filters })),
      `${notificationPrefix} Set both filters.repo and filters.reason. reason must be one of ${notificationReasons}.`,
    );
    assertIssue(
      () =>
        compileHubConfig(configuration({ on, steps, filters: { ...filters, repo: "owner/repo" } })),
      notificationFromUsers,
    );
  });

  it("requires a notification reason and rejects an unsafe reason", () => {
    const on = "github.notification";
    const steps = [scriptStep];
    const filters = { repo: "owner/repo" };
    assertIssue(
      () => compileHubConfig(configuration({ on, steps, filters })),
      `${notificationPrefix} Set both filters.repo and filters.reason. reason must be one of ${notificationReasons}.`,
    );
    assertIssue(
      () =>
        compileHubConfig(configuration({ on, steps, filters: { ...filters, reason: "mention" } })),
      `${notificationPrefix} filters.reason "mention" is not allowed for a script. Use one of ${notificationReasons}. Third parties can cause mention, team_mention, comment, subscribed and manual notifications, so those could let an outsider run code on the host.`,
    );
  });

  it.each([
    [
      "notification actors",
      { on: "github.notification", filters: { from_users: [] } },
      notificationFromUsers,
    ],
    [
      "empty external audience",
      { on: "github.push", filters: { from_users: [] } },
      "trigger run requires a non-empty filters.from_users allowlist for externally sourced events",
    ],
    [
      "scout with only an audience",
      { on: "linear.issue_entered_scope", filters: { from_users: ["maintainer"] } },
      "trigger run requires filters.project for linear.issue_entered_scope",
    ],
  ] as const)("rejects %s", (_name, trigger, message) => {
    assertIssue(() => compileHubConfig(configuration(trigger)), message);
  });
});

function workflowSteps(...overrides: readonly Record<string, unknown>[]) {
  const step = configuration().triggers[0]?.steps[0];
  return overrides.map((fields) => Object.assign({}, step, fields));
}

function expressionTemplate(expression: string): string {
  return "${{ " + expression + " }}";
}

const workPath = ["triggers", "run", "steps", "work"] as const;

describe("workflow reference validation", () => {
  it.each([
    ["paseo.prompt", "uses paseo.prompt in an authority-bearing field"],
    ["paseo.context", "uses paseo.context outside a step prompt"],
    [
      "paseo.execution.id",
      "uses paseo.execution outside environment worktree.newBranch or a step title",
    ],
    ["paseo.inputs.missing", "references undeclared input missing"],
    ["steps.missing.outputs.target", "references unknown step missing"],
    ["steps.later.outputs.target", "cannot reference forward step later"],
    [
      "steps.prepare.outputs.target",
      "references output from step prepare without an output schema",
    ],
    [
      "steps.unbounded.outputs.target",
      "uses agent output without provable finite choices for authority; use a finite enum or const",
    ],
  ] as const)("rejects %s in an environment selector", (expression, message) => {
    const steps = workflowSteps(
      { id: "prepare" },
      {
        id: "unbounded",
        output: { schema: { type: "object", properties: { target: { type: "string" } } } },
      },
      { environment: expressionTemplate(expression) },
      { id: "later" },
    );
    assertIssue(
      () => compileHubConfig(configuration({ steps })),
      `step work environment ${message}`,
      [...workPath, "environment"],
    );
  });

  it("reports conditions before environments and references from left to right", () => {
    const environment = expressionTemplate("paseo.prompt ?? paseo.inputs.missing");
    assertIssue(
      () => compileHubConfig(configuration({}, { if: "paseo.context", environment })),
      "step work if uses paseo.context outside a step prompt",
      [...workPath, "if"],
    );
    assertIssue(
      () => compileHubConfig(configuration({}, { environment })),
      "step work environment uses paseo.prompt in an authority-bearing field",
      [...workPath, "environment"],
    );
    assertIssue(
      () =>
        compileHubConfig(
          configuration({}, { environment: expressionTemplate("paseo.inputs.missing") }),
        ),
      "step work environment references undeclared input missing",
      [...workPath, "environment"],
    );
  });
});

const nonFiniteAuthority =
  "step work environment uses an agent-produced authority without provable finite choices; use a finite enum or const";

describe("finite authority expressions", () => {
  it.each([
    '!null && "runner"',
    '(null == null) && "runner"',
    '(null != "runner") && "runner"',
    'false || "runner"',
  ])("accepts the finite result of %s", (expression) => {
    const environment = expressionTemplate(expression);
    const compiled = compileHubConfig(configuration({}, { environment }));
    assert.equal(compiled.triggers[0]?.steps[0]?.environment, environment);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
  });

  it.each(["null", 'null || "runner"', "values.target"])(
    "rejects unprovable authority from %s",
    (expression) => {
      const raw = configuration(
        { values: { target: "null" } },
        { environment: expressionTemplate(expression) },
      );
      assertIssue(() => compileHubConfig(raw), nonFiniteAuthority, [...workPath, "environment"]);
    },
  );

  it("accepts a value derived from a finite input", () => {
    const environment = expressionTemplate("values.target");
    const compiled = compileHubConfig(
      configuration(
        {
          values: { target: "paseo.inputs.target" },
          inputs: { target: { type: "string", choices: ["runner"], required: true } },
        },
        { environment },
      ),
    );
    assert.equal(compiled.triggers[0]?.steps[0]?.environment, environment);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
  });

  it("accepts authority from an earlier step's finite output", () => {
    const environment = expressionTemplate("steps.prepare.outputs.target");
    const steps = workflowSteps(
      {
        id: "prepare",
        output: { schema: { type: "object", properties: { target: { const: "runner" } } } },
      },
      { environment },
    );
    const compiled = compileHubConfig(configuration({ steps }));
    assert.equal(compiled.triggers[0]?.steps[1]?.environment, environment);
    assert.deepEqual(parseCompiledHubConfig(compiled), compiled);
  });
});

describe("named agent and value selection", () => {
  it("requires finite choices to evaluate an otherwise finite selector", () => {
    const raw = configuration(
      { inputs: { answer: { type: "boolean" } }, values: { answer: "paseo.inputs.answer" } },
      { agent: expressionTemplate("!values.answer") },
    );
    assertIssue(() => compileHubConfig(raw), "step work agent must resolve from finite choices", [
      ...workPath,
      "agent",
    ]);
  });

  it("reports unknown named agents in selector choice order", () => {
    const agent = expressionTemplate("paseo.inputs.agent");
    const options = { namedAgents: { known: { provider: "codex" } } };
    const inputs = { agent: { type: "string", required: true, choices: ["first", "second"] } };
    assertIssue(
      () => compileHubConfig(configuration({ inputs }, { agent }), options),
      "step work agent resolves to unknown named agent first",
      [...workPath, "agent"],
    );
    inputs.agent.choices.reverse();
    assertIssue(
      () => compileHubConfig(configuration({ inputs }, { agent }), options),
      "step work agent resolves to unknown named agent second",
      [...workPath, "agent"],
    );
  });

  it("reports the first cyclic or undeclared value before checking step fields", () => {
    const step = { agent: expressionTemplate("values.unavailable") };
    const cycle = { first: "values.second", second: "values.first" };
    const undeclared = { target: "values.missing" };
    assertIssue(
      () => compileHubConfig(configuration({ values: { ...cycle, ...undeclared } }, step)),
      "value dependency cycle includes first",
    );
    assertIssue(
      () => compileHubConfig(configuration({ values: { ...undeclared, ...cycle } }, step)),
      "value target references undeclared value missing",
    );
    assertIssue(
      () => compileHubConfig(configuration({}, step)),
      "step work agent references undeclared value unavailable",
      [...workPath, "agent"],
    );
  });
});

describe("authored contract precedence", () => {
  it("checks environment IDs before trigger IDs and step IDs", () => {
    const raw = configuration();
    const [environment] = raw.environments;
    const [trigger] = raw.triggers;
    assert.ok(environment && trigger);
    const repeated = { ...raw, triggers: [trigger, { ...trigger, steps: workflowSteps({}, {}) }] };
    assertIssue(
      () => compileHubConfig({ ...repeated, environments: [environment, environment] }),
      "duplicate environment id: runner",
    );
    assertIssue(() => compileHubConfig(repeated), "duplicate trigger id: run");
    assertIssue(
      () => compileHubConfig(configuration({ steps: workflowSteps({}, {}) })),
      "duplicate step id: work",
    );
    assertIssue(
      () => compileHubConfig({ ...repeated, environments: [{ ...environment, name: "Runner" }] }),
      "invalid environment name: Runner",
    );
  });

  it("checks idle timeout and structured output before required turn-end outputs", () => {
    const step = {
      complete_on_turn_end: true,
      allow_outputs: [{ type: "manual.reply", required: true }],
    };
    const output = { schema: { type: "object" } };
    assertIssue(
      () => compileHubConfig(configuration({}, { ...step, output, idle_timeout: "11m" })),
      "step work idle_timeout must not exceed max_runtime",
      ["triggers", "run", "steps", "work", "idle_timeout"],
    );
    assertIssue(
      () => compileHubConfig(configuration({}, { ...step, output })),
      "step work complete_on_turn_end cannot be combined with output.schema: a finished turn has no structured output",
      ["triggers", "run", "steps", "work", "complete_on_turn_end"],
    );
    assertIssue(
      () => compileHubConfig(configuration({}, step)),
      "step work complete_on_turn_end cannot be combined with a required output: the agent must emit it before it finishes",
      ["triggers", "run", "steps", "work", "complete_on_turn_end"],
    );
  });

  it.each([
    [[true], "choices do not match type"],
    [["elsewhere"], "default is not an allowed choice"],
  ] as const)("reports the first invalid input choice rule for %j", (choices, message) => {
    const raw = configuration({
      inputs: { target: { type: "string", default: "runner", choices } },
    });
    assertIssue(() => compileHubConfig(raw), `trigger run input target ${message}`, [
      "triggers",
      "run",
      "inputs",
    ]);
  });
});

const storedContractIssue = "active configuration contains an invalid compiled workflow contract";

function storedFixture() {
  const config = compileHubConfig(
    configuration({ inputs: { target: { type: "string", choices: ["runner"], required: true } } }),
  );
  const [environment] = config.environments;
  const [trigger] = config.triggers;
  const [step] = trigger?.steps ?? [];
  assert.ok(environment && trigger && step);
  return { environment, trigger, step };
}

function assertStoredIssue(value: unknown): void {
  assertIssue(() => parseCompiledHubConfig(value), storedContractIssue);
}

describe("stored workflow contracts", () => {
  it("rejects duplicate IDs and an invalid environment name", () => {
    const { environment, trigger, step } = storedFixture();
    assertStoredIssue({ environments: [environment, environment], triggers: [trigger] });
    assertStoredIssue({ environments: [environment], triggers: [trigger, trigger] });
    assertStoredIssue({
      environments: [environment],
      triggers: [{ ...trigger, steps: [step, step] }],
    });
    assertStoredIssue({ environments: [{ ...environment, name: "Runner" }], triggers: [trigger] });
  });

  it.each([
    ["no steps", { steps: [] }],
    ["an undeclared input filter", { filters: { inputs: { missing: "runner" } } }],
    ["a mistyped input filter", { filters: { inputs: { target: 1 } } }],
    ["a disallowed input filter choice", { filters: { inputs: { target: "elsewhere" } } }],
    [
      "mistyped input choices",
      { inputs: { target: { type: "string", required: true, choices: [1] } } },
    ],
  ] as const)("rejects %s", (_name, fields) => {
    const { environment, trigger } = storedFixture();
    assertStoredIssue({ environments: [environment], triggers: [{ ...trigger, ...fields }] });
  });

  it.each([
    ["idle greater than max", { idleTimeoutMs: 660_000 }],
    [
      "turn completion with an output",
      { completeOnTurnEnd: true, output: { schema: { type: "object" } } },
    ],
    ["an invalid binary condition", { condition: { kind: "binary", operator: "invalid" } }],
    [
      "an invalid input path",
      { condition: { kind: "path", value: { namespace: "paseo", path: ["inputs", 1] } } },
    ],
    [
      "an invalid execution path",
      { condition: { kind: "path", value: { namespace: "paseo", path: ["execution", "name"] } } },
    ],
    [
      "an invalid step output path",
      { condition: { kind: "path", value: { namespace: "steps", stepId: "work", path: [1] } } },
    ],
    [
      "an invalid value path",
      { condition: { kind: "path", value: { namespace: "values", name: 1 } } },
    ],
  ] as const)("rejects %s", (_name, fields) => {
    const { environment, trigger, step } = storedFixture();
    assertStoredIssue({
      environments: [environment],
      triggers: [{ ...trigger, steps: [{ ...step, ...fields }] }],
    });
  });
});
