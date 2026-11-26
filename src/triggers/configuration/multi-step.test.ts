import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentStep, isScriptStep, type CompiledAgentStep } from "../../config/compiler.js";
import { parseProjectConfiguration } from "../../configuration/store.js";
import type { ProjectConfigurationRevisionRecord } from "../../db/types.js";
import { describeTriggerYaml } from "./describe.js";
import { projectTriggerForm } from "./editor.js";
import {
  compileTriggerDocument,
  parseTriggerDocument,
  serializeTriggerDocument,
  TriggerDocumentError,
} from "./index.js";

const ON = `on:
  slack.mention:
    connection: acme-slack
    filters:
      from_users: [U0BNGPZEXT2]
`;

const SHORTHAND = `name: build-review
${ON}run:
  target: { daemon: devbox, cwd: /workspace/app }
  agent: { provider: codex }
  prompt: Review it.
`;

const MIXED = `name: build-review
${ON}target: { daemon: devbox, cwd: /workspace/app }
max_runtime: 3h
steps:
  - id: build
    script: npm ci && npm run build
    max_runtime: 15m
  - id: review
    agent: { provider: codex }
    prompt: Review it.
    continuation: { mode: key, key: review-thread }
    output:
      schema:
        type: object
        properties:
          verdict: { enum: [ok, fix] }
        required: [verdict]
        additionalProperties: false
  - id: fix
    if: "\${{ steps.review.outputs.verdict == 'fix' }}"
    agent: { provider: codex }
    prompt: Fix it.
`;

function issuesOf(yaml: string): { path: string; message: string }[] {
  try {
    compileTriggerDocument(yaml);
  } catch (error) {
    if (error instanceof TriggerDocumentError) {
      return error.issues.map(({ path, message }) => ({ path: path.join("."), message }));
    }
    throw error;
  }
  return [];
}

function outputTypes(step: CompiledAgentStep): string[] {
  return step.allowOutputs.map(({ type }) => type);
}

function agentSteps(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `  - id: s${String(index)}\n    agent: { provider: codex }\n    prompt: Go\n`,
  ).join("");
}

function manualDocument(steps: string): string {
  return `name: many\non:\n  manual.run: {}\ntarget: { daemon: devbox, cwd: /workspace/app }\nsteps:\n${steps}`;
}

function listDocument(steps: string): string {
  return `name: many\n${ON}target: { daemon: devbox, cwd: /workspace/app }\nsteps:\n${steps}`;
}

describe("existing run documents", () => {
  it("keep their hash, their shorthand form and the step id run", () => {
    const compiled = compileTriggerDocument(SHORTHAND);
    expect(compiled.authoredHash).toBe(createHash("sha256").update(SHORTHAND).digest("hex"));
    expect(compiled.events[0]?.steps.map((step) => step.id)).toEqual(["run"]);
    const exported = serializeTriggerDocument(compiled.authored);
    expect(exported).toContain("run:");
    expect(exported).not.toContain("steps:");
  });

  it("compile exactly like the same single step written as a list", () => {
    const listed = `name: build-review
${ON}target: { daemon: devbox, cwd: /workspace/app }
steps:
  - id: run
    agent: { provider: codex }
    prompt: Review it.
    continuation: { mode: conversation }
`;
    const shorthand = compileTriggerDocument(SHORTHAND);
    const list = compileTriggerDocument(listed);
    expect(list.events).toEqual(shorthand.events);
    expect(list.environment).toEqual(shorthand.environment);
  });
});

describe("a document with steps", () => {
  it("compiles mixed step kinds in order with per-step continuation and if", () => {
    const [event] = compileTriggerDocument(MIXED).events;
    const steps = event?.steps ?? [];
    expect(steps.map((step) => step.id)).toEqual(["build", "review", "fix"]);
    expect(steps.map(isScriptStep)).toEqual([true, false, false]);
    expect(agentStep(steps[1]).continuation).toEqual({ mode: "key", key: "review-thread" });
    expect(agentStep(steps[2]).continuation).toEqual({ mode: "new" });
    expect(agentStep(steps[2]).condition).toBeDefined();
    expect(agentStep(steps[1]).condition).toBeUndefined();
    expect(event?.maxRuntimeMs).toBe(3 * 3_600_000);
  });

  it("gives the run the sum of its step deadlines when the document sets none", () => {
    const [event] = compileTriggerDocument(MIXED.replace("max_runtime: 3h\n", "")).events;
    expect(event?.maxRuntimeMs).toBe(15 * 60_000 + 2 * 2 * 3_600_000);
  });

  it("puts the automatic reply output on the last agent step only", () => {
    const steps = compileTriggerDocument(MIXED).events[0]?.steps ?? [];
    const replies = steps.map((step) => (isScriptStep(step) ? [] : outputTypes(step)));
    expect(replies).toEqual([[], [], ["slack.reply"]]);
  });

  it("starts a new agent for a step without continuation, unlike run", () => {
    const listed = compileTriggerDocument(listDocument(agentSteps(1)));
    expect(agentStep(listed.events[0]?.steps[0]).continuation).toEqual({ mode: "new" });
    const shorthand = compileTriggerDocument(SHORTHAND);
    expect(agentStep(shorthand.events[0]?.steps[0]).continuation).toEqual({ mode: "conversation" });
  });

  it("refuses steps that continue one conversation but could not share a session", () => {
    const step = (id: string, model: string, key = "shared") =>
      `  - id: ${id}\n    continuation: { mode: key, key: ${key} }\n    agent: { provider: codex, model: ${model} }\n    prompt: Go\n`;
    expect(issuesOf(manualDocument(step("a", "m1") + step("b", "m1")))).toEqual([]);
    expect(issuesOf(manualDocument(step("a", "m1") + step("b", "m2", "other")))).toEqual([]);
    const [issue] = issuesOf(manualDocument(step("a", "m1") + step("b", "m2")));
    expect(issue?.path).toBe("steps.1.continuation");
    expect(issue?.message).toContain('Step "b" continues the same conversation as step "a"');
    expect(issue?.message).toContain("differs in agent");
  });

  it("compares background, treats an empty env as none, and sees through a literal template key", () => {
    const step = (id: string, key: string, extra = "") =>
      `  - id: ${id}\n    continuation: { mode: key, key: "${key}" }\n    agent: { provider: codex }\n    prompt: Go\n${extra}`;
    const [background] = issuesOf(
      manualDocument(step("a", "k") + step("b", "k", "    background: true\n")),
    );
    expect(background?.message).toContain("differs in background");
    expect(issuesOf(manualDocument(step("a", "k") + step("b", "k", "    env: {}\n")))).toEqual([]);
    const [templated] = issuesOf(
      manualDocument(step("a", "shared") + step("b", "${{ 'shared' }}", "    background: true\n")),
    );
    expect(templated?.path).toBe("steps.1.continuation");
  });

  it("compares a keyed step across the events of the trigger", () => {
    const yaml = `name: both\non:\n  manual.run: {}\n  linear.comment_created:\n    connection: linear\n    filters: { from_users: [alice] }\ntarget: { daemon: devbox, cwd: /workspace/app }\nsteps:\n  - id: a\n    continuation: { mode: key, key: shared }\n    agent: { provider: codex }\n    prompt: Go\n`;
    const [issue] = issuesOf(yaml);
    expect(issue?.message).toContain("differs in allowed outputs");
    expect(issue?.message).toContain("on linear.comment_created");
  });

  it("puts an invalid output schema or idle timeout on the step", () => {
    const step = (extra: string) =>
      `  - id: a\n    agent: { provider: codex }\n    prompt: Go\n${extra}`;
    const [schema] = issuesOf(listDocument(step("    output:\n      schema: { type: bogus }\n")));
    expect(schema?.path).toBe("steps.0.output.schema");
    expect(issuesOf(listDocument(step("    idle_timeout: 3h\n")))).toEqual([
      { path: "steps.0.idle_timeout", message: "step a idle_timeout must not exceed max_runtime" },
    ]);
  });

  it("counts the automatic reply output as a difference for conversation steps on a chat event", () => {
    const step = (id: string) =>
      `  - id: ${id}\n    continuation: { mode: conversation }\n    agent: { provider: codex }\n    prompt: Go\n`;
    const [issue] = issuesOf(listDocument(step("a") + step("b")));
    expect(issue?.message).toContain("allowed outputs");
    expect(issuesOf(manualDocument(step("a") + step("b")))).toEqual([]);
  });

  it("round trips through serialization as steps", () => {
    const exported = serializeTriggerDocument(parseTriggerDocument(MIXED));
    expect(exported).toContain("steps:");
    expect(compileTriggerDocument(exported).events).toEqual(compileTriggerDocument(MIXED).events);
  });

  it("accepts 20 steps and refuses 21 at steps", () => {
    expect(issuesOf(listDocument(agentSteps(20)))).toEqual([]);
    const [event] = compileTriggerDocument(listDocument(agentSteps(20))).events;
    expect(event?.maxRuntimeMs).toBe(24 * 3_600_000);
    expect(issuesOf(listDocument(agentSteps(21)))).toEqual([
      { path: "steps", message: "A trigger can have at most 20 steps." },
    ]);
  });

  it("refuses an if that reads a later step or a step without an output schema", () => {
    const later = listDocument(
      `  - id: a\n    if: "\${{ steps.b.outputs.x == 'y' }}"\n    agent: { provider: codex }\n    prompt: Go\n` +
        `  - id: b\n    agent: { provider: codex }\n    prompt: Go\n`,
    );
    expect(issuesOf(later)).toEqual([
      { path: "steps.0.if", message: "step a if cannot reference forward step b" },
    ]);
    const unshaped = listDocument(
      `  - id: a\n    agent: { provider: codex }\n    prompt: Go\n` +
        `  - id: b\n    if: "\${{ steps.a.outputs.x == 'y' }}"\n    agent: { provider: codex }\n    prompt: Go\n`,
    );
    expect(issuesOf(unshaped)).toEqual([
      {
        path: "steps.1.if",
        message: "step b if references output from step a without an output schema",
      },
    ]);
  });

  it("puts compiler errors on the authored step, and a deadline error on max_runtime", () => {
    const step = (id: string, extra = "") =>
      `  - id: ${id}\n    agent: { provider: codex }\n    prompt: Go\n${extra}`;
    expect(issuesOf(listDocument(step("a") + step("b", '    if: "${{ ( }}"\n')))).toEqual([
      { path: "steps.1.if", message: "invalid workflow expression: expected a value" },
    ]);
    expect(issuesOf(listDocument(`  - id: a\n    script: ""\n` + step("b")))).toEqual([
      { path: "steps.0.script", message: "script must not be blank" },
    ]);
    expect(issuesOf(listDocument(step("a", "    max_runtime: 25h\n") + step("b")))).toEqual([
      { path: "steps.0.max_runtime", message: "step a max_runtime must not exceed 24h" },
    ]);
    const [deadline] = issuesOf(`${listDocument(step("a"))}max_runtime: 25h\n`);
    expect(deadline?.path).toBe("max_runtime");
  });

  it("refuses agent options that refer to themselves without overflowing the stack", () => {
    const choices = listDocument(
      "  - id: a\n    agent:\n      select: c\n      choices:\n        c: { provider: codex, options: &loop { again: *loop } }\n    prompt: Go\n",
    );
    const [issue] = issuesOf(choices);
    expect(issue?.path).toBe("steps.0.agent");
    expect(issue?.message).toContain("do not refer to themselves");
  });

  it("refuses a script step the same way a script run is refused", () => {
    const wildcard = MIXED.replace("from_users: [U0BNGPZEXT2]", "from_users: ['*']");
    const [issue] = issuesOf(wildcard);
    expect(issue?.message).toContain("needs filters.from_users that names the people allowed");
    expect(issue?.message).toContain("runs a script");
  });

  it("requires steps that choose between agents to list the same choices", () => {
    const step = (id: string, model: string) =>
      `  - id: ${id}\n    agent:\n      select: codex\n      choices:\n        codex: { provider: codex, model: ${model} }\n    prompt: Go\n`;
    expect(issuesOf(listDocument(step("a", "m1") + step("b", "m1")))).toEqual([]);
    expect(issuesOf(listDocument(step("a", "m1") + step("b", "m2")))).toEqual([
      {
        path: "steps.1.agent.choices",
        message:
          "Steps that choose between agents must list the same choices as the first step that does.",
      },
    ]);
  });
});

describe("tools that read a document with steps", () => {
  it("summarizes the steps by id", () => {
    expect(describeTriggerYaml(MIXED)).toContain("3 steps (build, review, and fix)");
    expect(describeTriggerYaml(SHORTHAND)).toContain("run codex on host devbox");
  });

  it("leaves the form to YAML", () => {
    expect(projectTriggerForm(MIXED)).toEqual({
      status: "yaml_only",
      reason: "Triggers with several steps can only be edited in YAML.",
    });
  });

  it("reads stored revisions with each step's own continuation", () => {
    const compiled = compileTriggerDocument(MIXED);
    const stored = structuredClone({
      environments: [{ ...compiled.environment, daemonId: "daemon" }],
      triggers: compiled.events,
    });
    for (const step of stored.triggers[0]?.steps ?? []) {
      if (!isScriptStep(step)) delete step.continuation;
    }
    const revision: ProjectConfigurationRevisionRecord = {
      id: "revision",
      projectId: "project",
      organizationId: "org",
      version: 1,
      sourceKind: "manual",
      sourceEvidence: { kind: "organization_trigger_adapter" },
      rawYaml: MIXED,
      normalizedConfiguration: stored,
      validationErrors: null,
      contentHash: "original",
      createdByUserId: "user",
      receivedAt: null,
      createdAt: new Date(),
      validatedAt: new Date(),
    };
    const steps = parseProjectConfiguration(revision).triggers[0]?.steps ?? [];
    expect(agentStep(steps[1]).continuation).toEqual({ mode: "key", key: "review-thread" });
    expect(agentStep(steps[2]).continuation).toEqual({ mode: "new" });
    expect(steps[0] !== undefined && isScriptStep(steps[0])).toBe(true);
  });
});
