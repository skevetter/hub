import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  matchesInputFilters,
  parseInvocation,
  parseStructuredInvocation,
  type InvocationInputDefinitions,
} from "./invocation.js";

const inputs = {
  repo: { type: "string" as const, choices: ["paseo", "hub"] },
  agent: { type: "string" as const, default: "codex", choices: ["codex", "opus"] },
  count: { type: "number" as const },
};

const requiredInputs = {
  ...inputs,
  dry: { type: "boolean" as const, required: true },
};

describe("provider-neutral message invocation parser", () => {
  it.each([
    {
      name: "parses after the mention without changing the prompt",
      message: "  @Paseo   repo=hub investigate",
      mention: "@Paseo",
      expected: {
        prompt: "  @Paseo   repo=hub investigate",
        inputs: { repo: "hub", agent: "codex" },
      },
    },
    {
      name: "accepts zero inputs",
      message: "investigate the failed sync",
      expected: {
        prompt: "investigate the failed sync",
        inputs: { agent: "codex" },
      },
    },
    {
      name: "accepts multiple consecutive inputs",
      message: "repo=hub agent=opus investigate",
      expected: {
        prompt: "repo=hub agent=opus investigate",
        inputs: { repo: "hub", agent: "opus" },
      },
    },
    {
      name: "preserves whitespace in the prompt remainder",
      message: "repo=hub   investigate   the sync  ",
      expected: {
        prompt: "repo=hub   investigate   the sync  ",
        inputs: { repo: "hub", agent: "codex" },
      },
    },
    {
      name: "requires a mention boundary before removing the provider mention",
      message: "@PaseoBot repo=hub investigate",
      mention: "@Paseo",
      expected: {
        prompt: "@PaseoBot repo=hub investigate",
        inputs: { agent: "codex" },
      },
    },
    {
      name: "does not remove an embedded provider mention",
      message: "request @Paseo repo=hub investigate",
      mention: "@Paseo",
      expected: {
        prompt: "request @Paseo repo=hub investigate",
        inputs: { agent: "codex" },
      },
    },
    {
      name: "stops at an undeclared key and preserves the entire remainder",
      message: "unknown=value repo=hub investigate",
      expected: {
        prompt: "unknown=value repo=hub investigate",
        inputs: { agent: "codex" },
      },
    },
  ])("$name", ({ message, mention, expected }) => {
    assert.deepEqual(parseInvocation(message, inputs, mention), {
      status: "accepted",
      ...expected,
    });
  });

  it.each([
    {
      name: "invalid choice",
      message: "repo=unknown investigate",
      expectedPrompt: "repo=unknown investigate",
      reason: /repo.*choice/iu,
    },
    {
      name: "duplicate key",
      message: "repo=hub repo=paseo investigate",
      expectedPrompt: "repo=hub repo=paseo investigate",
      reason: /duplicate.*repo/iu,
    },
  ])("preserves the complete prompt after a $name control-token rejection", (example) => {
    const result = parseInvocation(example.message, inputs);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.prompt, example.expectedPrompt);
      assert.match(result.reason, example.reason);
      assert.equal(typeof result.rejection.code, "string");
    }
  });

  it.each([
    ["required", "repo=hub investigate", "repo=hub investigate", /required input.*dry/iu],
    ["invalid choice", "repo=other investigate", "repo=other investigate", /repo.*choice/iu],
    [
      "invalid number",
      "count=not-a-number investigate",
      "count=not-a-number investigate",
      /count.*number/iu,
    ],
    ["invalid boolean", "dry=sometimes investigate", "dry=sometimes investigate", /dry.*boolean/iu],
    [
      "duplicate key",
      "repo=hub repo=paseo investigate",
      "repo=hub repo=paseo investigate",
      /duplicate.*repo/iu,
    ],
  ] as const)("rejects %s values before execution", (_name, message, expectedPrompt, error) => {
    const result = parseInvocation(
      message,
      _name === "required" || _name === "invalid boolean" ? requiredInputs : inputs,
    );
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.match(result.reason, error);
      assert.equal(result.prompt, expectedPrompt);
    }
  });

  it("does not implement a delimiter grammar", () => {
    assert.deepEqual(parseInvocation("-- repo=hub investigate", inputs), {
      status: "accepted",
      prompt: "-- repo=hub investigate",
      inputs: { agent: "codex" },
    });
  });
});

describe("structured invocation parser", () => {
  it("maps only declared fields without interpreting the prompt as headers", () => {
    const prompt = "repo=paseo count=99  investigate\n";
    const data = {
      repo: "hub",
      count: 2.5,
      dry: false,
      extra: { nested: ["untrusted", { agent: "opus" }] },
    };
    const original = structuredClone(data);
    const result = parseStructuredInvocation(prompt, data, requiredInputs);
    assert.deepEqual(result, {
      status: "accepted",
      prompt,
      inputs: { repo: "hub", count: 2.5, dry: false, agent: "codex" },
    });
    assert.ok(Object.isFrozen(result.inputs));
    assert.deepEqual(data, original);
  });

  it.each([
    ["string", 1],
    ["string", true],
    ["string", null],
    ["string", {}],
    ["string", []],
    ["number", "1"],
    ["number", true],
    ["number", null],
    ["number", Number.NaN],
    ["number", Number.POSITIVE_INFINITY],
    ["number", Number.NEGATIVE_INFINITY],
    ["boolean", "true"],
    ["boolean", 1],
    ["boolean", null],
  ] as const)("rejects a non-%s value without coercion", (type, value) => {
    const result = parseStructuredInvocation("unchanged", { field: value }, { field: { type } });
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") throw new Error("expected input rejection");
    assert.equal(result.prompt, "unchanged");
    assert.deepEqual(result.rejection, {
      code: "invalid_type",
      inputName: "field",
      expectedType: type,
    });
  });

  it.each([
    ["string", ""],
    ["number", 0],
    ["number", -2.5e10],
    ["boolean", false],
  ] as const)("accepts a strict %s value", (type, value) => {
    assert.deepEqual(parseStructuredInvocation("", { field: value }, { field: { type } }), {
      status: "accepted",
      prompt: "",
      inputs: { field: value },
    });
  });

  it("applies defaults before checking required inputs", () => {
    const definitions = {
      repo: { type: "string", required: true, default: "hub", choices: ["hub"] },
      count: { type: "number", default: 0 },
      dry: { type: "boolean", default: false },
    } satisfies InvocationInputDefinitions;
    assert.deepEqual(parseStructuredInvocation("request", {}, definitions), {
      status: "accepted",
      prompt: "request",
      inputs: { repo: "hub", count: 0, dry: false },
    });
    const missing = parseStructuredInvocation("request", {}, requiredInputs);
    assert.equal(missing.status, "rejected");
    if (missing.status === "rejected") {
      assert.deepEqual(missing.rejection, { code: "missing_required", inputName: "dry" });
    }
  });

  it.each([
    {
      definition: { type: "number", default: "1" },
      code: "invalid_default_type",
    },
    {
      definition: { type: "number", default: Number.POSITIVE_INFINITY },
      code: "invalid_default_type",
    },
    {
      definition: { type: "string", default: "opus", choices: ["codex"] },
      code: "invalid_default_choice",
    },
  ] as const)("rejects an invalid default with $code", ({ definition, code }) => {
    const result = parseStructuredInvocation("request", {}, { field: definition });
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.rejection.code, code);
      assert.equal(result.rejection.inputName, "field");
    }
  });

  it("enforces typed choices and never falls back from an explicit null to a default", () => {
    const choice = parseStructuredInvocation("request", { repo: "other" }, inputs);
    assert.equal(choice.status, "rejected");
    if (choice.status === "rejected") {
      assert.deepEqual(choice.rejection, {
        code: "invalid_choice",
        inputName: "repo",
        value: "other",
        choices: ["paseo", "hub"],
      });
    }
    const result = parseStructuredInvocation("request", { agent: null }, inputs);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.deepEqual(result.rejection, {
        code: "invalid_type",
        inputName: "agent",
        expectedType: "string",
      });
    }
  });

  it("ignores inherited data and inherited definitions", () => {
    const data: Record<string, unknown> = { agent: "opus" };
    Object.setPrototypeOf(data, { repo: "hub" });
    const definitions: Record<string, { type: "string"; required?: boolean }> = {
      repo: { type: "string", required: true },
    };
    Object.setPrototypeOf(definitions, { agent: { type: "string" } });
    const result = parseStructuredInvocation("request", data, definitions);
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.inputs, {});
    if (result.status === "rejected") {
      assert.deepEqual(result.rejection, { code: "missing_required", inputName: "repo" });
    }
  });

  it("keeps an own declared prototype-named field as data without changing prototypes", () => {
    const data = { ["__proto__"]: "value", constructor: "ignored" };
    const definitions = { ["__proto__"]: { type: "string" as const, required: true } };
    const result = parseStructuredInvocation("", data, definitions);
    assert.equal(result.status, "accepted");
    assert.equal(Object.getPrototypeOf(result.inputs), Object.prototype);
    assert.equal(Object.hasOwn(result.inputs, "__proto__"), true);
    assert.equal(result.inputs["__proto__"], "value");
    assert.equal(Object.hasOwn(result.inputs, "constructor"), false);
  });
});

describe("inherited object keys are not declared inputs", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf"])(
    "treats %s=x as ordinary text",
    (name) => {
      const result = parseInvocation(`${name}=x investigate`, inputs);
      assert.equal(result.status, "accepted");
      assert.deepEqual(result.inputs, { agent: "codex" });
    },
  );

  it("still parses declared inputs that precede an inherited name", () => {
    const result = parseInvocation("repo=hub constructor=x investigate", inputs);
    assert.equal(result.status, "accepted");
    assert.deepEqual(result.inputs, { repo: "hub", agent: "codex" });
  });

  it("does not match an input filter against an inherited key", () => {
    const inherited: Record<string, string> = {};
    Object.setPrototypeOf(inherited, { repo: "hub" });
    assert.equal(matchesInputFilters(inherited, { repo: "hub" }), false);
    assert.equal(matchesInputFilters({}, { constructor: "x" }), false);
    assert.equal(matchesInputFilters({ repo: "hub" }, { repo: "hub" }), true);
  });
});
