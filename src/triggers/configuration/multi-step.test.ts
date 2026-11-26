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
    expect(agentStep(steps[2]).continuation).toEqual({ mode: "conversation" });
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
    expect(issuesOf(later)).not.toEqual([]);
    const unshaped = listDocument(
      `  - id: a\n    agent: { provider: codex }\n    prompt: Go\n` +
        `  - id: b\n    if: "\${{ steps.a.outputs.x == 'y' }}"\n    agent: { provider: codex }\n    prompt: Go\n`,
    );
    expect(issuesOf(unshaped)).not.toEqual([]);
  });

  it("refuses a script step the same way a script run is refused", () => {
    const wildcard = MIXED.replace("from_users: [U0BNGPZEXT2]", "from_users: ['*']");
    expect(issuesOf(wildcard)).not.toEqual([]);
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
    expect(agentStep(steps[2]).continuation).toEqual({ mode: "conversation" });
    expect(steps[0] !== undefined && isScriptStep(steps[0])).toBe(true);
  });
});
