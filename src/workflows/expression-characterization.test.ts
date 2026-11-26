import { describe, expect, it } from "vitest";
import {
  evaluateExpression,
  parseExpression,
  renderExpressionTemplate,
  type ExpressionContext,
} from "./expression.js";

const context: ExpressionContext = {
  prompt: "ship it",
  context: { event: true },
  inputs: { one: 1 },
  values: { ready: { kind: "literal", value: true } },
  steps: {
    done: { status: "succeeded", output: { result: { count: 2 }, bad: Infinity } },
    failed: { status: "failed", output: null },
  },
};

function evaluate(source: string, evaluationContext = context) {
  return evaluateExpression(parseExpression(source), evaluationContext);
}

function expectEvaluationError(source: string, message: string, evaluationContext = context): void {
  try {
    evaluate(source, evaluationContext);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toBe(message);
    return;
  }
  throw new Error("expected expression evaluation to throw");
}

describe("workflow expression characterization", () => {
  const successes = [
    ["${{ true || false && false }}", true],
    ["false && values.missing", false],
    ["true || values.missing", true],
    ["0 ?? values.missing", 0],
    ["null ?? values.ready", true],
    ["!(1 == '1') && (2 != 3)", true],
    [
      "{'list': [false, null, -2.5e1], 'str': \"value\"}",
      { list: [false, null, -25], str: "value" },
    ],
    ["paseo.inputs.one == 1 && steps.done.outputs.result.count == 2", true],
    ["paseo.inputs.absent", null],
    ["paseo.prompt", "ship it"],
    ["paseo.context", { event: true }],
  ] as const;
  it.each(successes)("evaluates %s", (source, result) => {
    expect(evaluate(source)).toEqual(result);
  });

  const errors = [
    ["", "invalid workflow expression: expected a value"],
    ["${{ true", "invalid workflow expression: unterminated expression"],
    ["(true", "invalid workflow expression: missing ')'"],
    ["true false", "invalid workflow expression: unexpected token"],
    ["paseo.", "invalid workflow expression: expected path segment"],
    ["steps.done.result", "invalid workflow expression: unsupported path steps.done.result"],
    ["[1,]", "invalid workflow expression: trailing comma"],
    ["[1 2]", "invalid workflow expression: expected ',' or ']'"],
    [
      "[values.ready]",
      "invalid workflow expression: JSON literals cannot contain paths or operators",
    ],
    ["{1: true}", "invalid workflow expression: object keys must be strings"],
    ["{'k' true}", "invalid workflow expression: expected ':'"],
    ["{'k': true,}", "invalid workflow expression: trailing comma"],
    ["{'k': true false}", "invalid workflow expression: expected ',' or '}'"],
    ["foo()", "invalid workflow expression: unsupported path foo"],
    ["@", "invalid workflow expression: unexpected token @"],
    [
      "paseo.execution.id",
      "workflow expression could not be evaluated: execution ID is unavailable",
    ],
    ["values.missing", "workflow expression could not be evaluated: value missing is unavailable"],
    [
      "steps.failed.outputs.result",
      "workflow expression could not be evaluated: output from step failed is unavailable",
    ],
    [
      "steps.done.outputs.result.missing",
      "workflow expression could not be evaluated: output path steps.done.outputs.result.missing is missing",
    ],
    [
      "steps.done.outputs.bad",
      "workflow expression could not be evaluated: output contains a non-JSON value",
    ],
  ] as const;
  it.each(errors)("rejects %s", (source, message) => {
    expectEvaluationError(source, message);
  });

  it("renders JSON and strings without changing their representation", () => {
    expect(renderExpressionTemplate("a:${{ paseo.context }}:${{ paseo.prompt }}", context)).toBe(
      'a:{"event":true}:ship it',
    );
  });
});

describe("workflow context keys", () => {
  it.each(["constructor", "prototype", "__proto__"] as const)(
    "refuses input %s from an explicit AST",
    (key) => {
      expect(
        evaluateExpression(
          { kind: "path", value: { namespace: "paseo", path: ["inputs", key] } },
          context,
        ),
      ).toBe(null);
    },
  );

  it.each(["constructor", "prototype"])("refuses input %s from source", (key) => {
    expect(evaluate(`paseo.inputs.${key}`)).toBe(null);
  });

  it("renders a refused input as null", () => {
    expect(renderExpressionTemplate("${{ paseo.inputs.constructor }}", context)).toBe("null");
  });

  it("accepts an ordinary own input but refuses an own constructor", () => {
    const own = { ...context, inputs: { a: 1, constructor: 2 } };
    expect(evaluate("paseo.inputs.a", own)).toBe(1);
    expect(evaluate("paseo.inputs.constructor", own)).toBe(null);
  });

  it("reads inputs without an object prototype", () => {
    const empty: unknown = Object.create(null);
    if (typeof empty !== "object" || empty === null) throw new Error("expected an object");
    const inputs = Object.assign(empty, { a: 1 });
    expect(evaluate("paseo.inputs.a", { ...context, inputs })).toBe(1);
    expect(evaluate("paseo.inputs.missing", { ...context, inputs })).toBe(null);
  });

  it.each([
    ["values.constructor", "value constructor is unavailable"],
    ["steps.constructor.outputs.result", "output from step constructor is unavailable"],
  ] as const)("reports %s as unavailable", (source, message) => {
    expectEvaluationError(source, `workflow expression could not be evaluated: ${message}`);
  });

  it.each(["constructor", "prototype"])("refuses own value and step named %s", (key) => {
    const own: ExpressionContext = {
      ...context,
      values: { [key]: { kind: "literal", value: 1 } },
      steps: { [key]: { status: "succeeded", output: { result: 2 } } },
    };
    const prefix = "workflow expression could not be evaluated:";
    expectEvaluationError(`values.${key}`, `${prefix} value ${key} is unavailable`, own);
    expectEvaluationError(
      `steps.${key}.outputs.result`,
      `${prefix} output from step ${key} is unavailable`,
      own,
    );
  });

  it.each([
    [
      "paseo.inputs.constructor.constructor",
      "unsupported path paseo.inputs.constructor.constructor",
    ],
    ["paseo.inputs.__proto__", "unexpected token _"],
    ["steps.toString.outputs.result", "unexpected token S"],
  ] as const)("rejects invalid source path %s", (source, message) => {
    expectEvaluationError(source, `invalid workflow expression: ${message}`);
  });
});

function withPollutedPrototype(check: () => void): void {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "polluted");
  expect(
    Reflect.defineProperty(Object.prototype, "polluted", {
      configurable: true,
      value: { kind: "literal", value: "inherited", status: "succeeded", output: { result: 5 } },
    }),
  ).toBe(true);
  try {
    check();
  } finally {
    const restored =
      original === undefined
        ? Reflect.deleteProperty(Object.prototype, "polluted")
        : Reflect.defineProperty(Object.prototype, "polluted", original);
    expect(restored).toBe(true);
  }
}

describe("workflow inherited context keys", () => {
  it("does not read an inherited input", () => {
    withPollutedPrototype(() => expect(evaluate("paseo.inputs.polluted")).toBe(null));
  });

  it.each([
    ["values.polluted", "value polluted is unavailable"],
    ["steps.polluted.outputs.result", "output from step polluted is unavailable"],
  ] as const)("does not read %s", (source, message) => {
    withPollutedPrototype(() =>
      expectEvaluationError(source, `workflow expression could not be evaluated: ${message}`),
    );
  });
});
