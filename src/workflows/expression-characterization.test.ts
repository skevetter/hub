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

function evaluate(source: string) {
  return evaluateExpression(parseExpression(source), context);
}

function expectEvaluationError(source: string, message: string): void {
  try {
    evaluate(source);
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

describe("workflow input key characterization", () => {
  it.each([
    ["constructor", Object],
    ["__proto__", Object.prototype],
  ] as const)("reads inherited input %s from an explicit AST", (key, result: unknown) => {
    expect(
      evaluateExpression(
        { kind: "path", value: { namespace: "paseo", path: ["inputs", key] } },
        context,
      ),
    ).toBe(result);
  });

  it("reads the inherited constructor from source", () => {
    expect(evaluate("paseo.inputs.constructor")).toBe(Object);
  });

  it("rejects the leading underscore of __proto__ in source", () => {
    expectEvaluationError(
      "paseo.inputs.__proto__",
      "invalid workflow expression: unexpected token _",
    );
  });
});
