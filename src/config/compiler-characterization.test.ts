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
