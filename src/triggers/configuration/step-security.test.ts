import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseCompiledHubConfig } from "../../config/compiler.js";
import { compileTriggerDocument, TriggerDocumentError } from "./index.js";
import { EDITOR_EVENTS, eventDefinition, type EditorEvent } from "./events.js";

const ACTOR_EVENTS = EDITOR_EVENTS.filter((event) => {
  const { audience } = eventDefinition(event);
  return audience !== "none" && event !== "manual.run";
});

function filterLines(event: EditorEvent, audience: string | undefined): string[] {
  const lines = audience === undefined ? [] : [`from_users: ${audience}`];
  if (event.startsWith("github.")) lines.push("repo: acme/webapp");
  if (event.endsWith("_label_added")) lines.push("label: ready");
  if (event === "linear.issue_entered_scope") lines.push("project: project-1");
  return lines;
}

function onBlock(event: EditorEvent, audience: string | undefined): string {
  const { provider } = eventDefinition(event);
  const connection = provider === "manual" ? "" : `    connection: acme-${provider}\n`;
  const lines = filterLines(event, audience).map((line) => `      ${line}\n`);
  const filters = lines.length === 0 ? "" : `    filters:\n${lines.join("")}`;
  return `  ${event}:\n${connection}${filters}`;
}

function multiStep(on: string): string {
  return `name: probe
on:
${on}target: { daemon: devbox, cwd: /workspace/app }
steps:
  - id: plan
    agent: { provider: codex, mode: full-access }
    prompt: Plan it.
  - id: build
    script: make
  - id: fix
    agent: { provider: codex, mode: full-access }
    prompt: Fix it.
`;
}

const STORED_REFUSAL = /invalid compiled workflow contract/u;

function storedConfig(yaml: string): string {
  const compiled = compileTriggerDocument(yaml);
  const environments = [{ ...compiled.environment, daemonId: "daemon-1" }];
  return JSON.stringify({ environments, triggers: compiled.events });
}

function refusal(yaml: string): string | undefined {
  try {
    compileTriggerDocument(yaml);
  } catch (error) {
    if (error instanceof TriggerDocumentError) return error.issues[0]?.message;
    throw error;
  }
  return undefined;
}

describe("a script step needs a named audience on every actor event", () => {
  it.each(ACTOR_EVENTS)("%s refuses a missing, empty or wildcard audience", (event) => {
    for (const audience of [undefined, "[]", '["*"]', '[alice, "*"]', '["*", alice]']) {
      assert.match(
        refusal(multiStep(onBlock(event, audience))) ?? "",
        /needs filters\.from_users that names the people allowed/u,
        `${event} with ${audience ?? "no audience"}`,
      );
    }
  });

  it.each(ACTOR_EVENTS)("%s accepts a named audience", (event) => {
    assert.equal(refusal(multiStep(onBlock(event, "[alice]"))), undefined);
  });

  it("refuses the same wildcard when the only script is the last step", () => {
    const yaml = multiStep(onBlock("slack.mention", '["*"]')).replace(/  - id: fix[\s\S]*$/u, "");
    assert.match(refusal(yaml) ?? "", /needs filters\.from_users/u);
  });

  it("refuses a stored contract whose audience was widened after compiling", () => {
    const stored = storedConfig(multiStep(onBlock("slack.mention", "[alice]")));
    assert.doesNotThrow(() => parseCompiledHubConfig(JSON.parse(stored)));
    for (const widened of ['["*"]', "[]", '["alice","*"]']) {
      const tampered = stored.replace('"from_users":["alice"]', `"from_users":${widened}`);
      assert.notEqual(tampered, stored);
      assert.throws(() => parseCompiledHubConfig(JSON.parse(tampered)), STORED_REFUSAL);
    }
  });
});

describe("step ids that expressions cannot read", () => {
  function withStep(id: string): string {
    return multiStep(onBlock("slack.mention", "[alice]")).replace("id: plan", `id: ${id}`);
  }

  it.each(["constructor", "prototype"])("refuses a step named %s", (id) => {
    assert.match(refusal(withStep(id)) ?? "", new RegExp(`step id ${id} is reserved`, "u"));
  });

  it("refuses a reference to a step that is not declared, even if it names an inherited key", () => {
    const yaml = multiStep(onBlock("slack.mention", "[alice]")).replace(
      "    prompt: Fix it.",
      '    prompt: Fix it.\n    if: "${{ steps.constructor.outputs.result }}"',
    );
    assert.match(refusal(yaml) ?? "", /unknown step constructor/u);
  });

  it("refuses a stored contract with a step named constructor", () => {
    const stored = storedConfig(withStep("planner"));
    const tampered = stored.replace('"id":"planner"', '"id":"constructor"');
    assert.notEqual(tampered, stored);
    assert.throws(() => parseCompiledHubConfig(JSON.parse(tampered)), STORED_REFUSAL);
  });

  it("still accepts an ordinary step id", () => {
    assert.equal(refusal(withStep("planner")), undefined);
  });
});

describe("input names that expressions cannot read", () => {
  const on = onBlock("slack.mention", "[alice]");

  function withInputs(names: readonly string[], base = multiStep(on)): string {
    const declared = names.map((name) => `  ${name}: { type: string }\n`).join("");
    return base.replace("target:", `inputs:\n${declared}target:`);
  }

  it.each(["constructor", "prototype"])("still declares an input named %s", (name) => {
    assert.equal(refusal(withInputs([name])), undefined);
  });

  it.each(["constructor", "prototype"])("refuses an expression that reads input %s", (name) => {
    const yaml = withInputs([name]).replace(
      "    prompt: Fix it.",
      `    prompt: Fix it.\n    if: "\${{ paseo.inputs.${name} }}"`,
    );
    assert.match(refusal(yaml) ?? "", /which expressions cannot read/u);
  });

  it("refuses an undeclared reference that names an inherited key", () => {
    const yaml = multiStep(on).replace(
      "    prompt: Fix it.",
      '    prompt: Fix it.\n    if: "${{ paseo.inputs.constructor }}"',
    );
    assert.match(refusal(yaml) ?? "", /references undeclared input constructor/u);
  });

  it("refuses an input filter that names an inherited key", () => {
    const filtered = multiStep(
      on.replace(
        "      from_users: [alice]\n",
        "      from_users: [alice]\n      inputs: { constructor: x }\n",
      ),
    );
    assert.match(refusal(withInputs(["ticket"], filtered)) ?? "", /undeclared input constructor/u);
  });

  it("keeps a stored contract with an input named constructor", () => {
    const stored = storedConfig(withInputs(["ticket"]));
    const renamed = stored.replace('"inputs":{"ticket"', '"inputs":{"constructor"');
    assert.notEqual(renamed, stored);
    assert.doesNotThrow(() => parseCompiledHubConfig(JSON.parse(renamed)));
  });

  it("still accepts a declared input, a reference to it and a filter on it", () => {
    const yaml = multiStep(
      on.replace(
        "      from_users: [alice]\n",
        "      from_users: [alice]\n      inputs: { ticket: x }\n",
      ),
    ).replace("    prompt: Fix it.", '    prompt: Fix it.\n    if: "${{ paseo.inputs.ticket }}"');
    assert.equal(refusal(withInputs(["ticket"], yaml)), undefined);
  });
});
