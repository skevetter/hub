import type { JsonPrimitive, JsonValue } from "../config/compiler.js";

export type ExpressionPath =
  | {
      namespace: "paseo";
      path: "prompt" | "context" | ["inputs", string] | ["execution", "id"];
    }
  | { namespace: "steps"; stepId: string; path: readonly string[] }
  | { namespace: "values"; name: string };

export type Expression =
  | { kind: "literal"; value: JsonValue }
  | { kind: "path"; value: ExpressionPath }
  | { kind: "not"; value: Expression }
  | {
      kind: "binary";
      operator: "==" | "!=" | "&&" | "||" | "??";
      left: Expression;
      right: Expression;
    };

export interface ExpressionContext {
  prompt: string;
  context: JsonValue;
  inputs: Readonly<Record<string, JsonPrimitive>>;
  steps: Readonly<Record<string, { status: string; output: unknown }>>;
  values: Readonly<Record<string, Expression>>;
  executionId?: string;
}

export class ExpressionSyntaxError extends Error {
  constructor(message: string) {
    super(`invalid workflow expression: ${message}`);
    this.name = "ExpressionSyntaxError";
  }
}

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(`workflow expression could not be evaluated: ${message}`);
    this.name = "ExpressionEvaluationError";
  }
}

type Token =
  | { kind: "literal"; value: JsonValue }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: "!" | "==" | "!=" | "&&" | "||" | "??" }
  | { kind: "dot" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "array-left" }
  | { kind: "array-right" }
  | { kind: "object-left" }
  | { kind: "object-right" }
  | { kind: "comma" }
  | { kind: "colon" }
  | { kind: "end" };

type BinaryOperator = "==" | "!=" | "&&" | "||" | "??";
type Operator = "!" | BinaryOperator;

const TOKEN =
  /\s*(?:(true|false|null)|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([a-z][a-z0-9_-]*)|(!=|==|&&|\|\||\?\?|!)|(\.)|(\()|(\))|(\[)|(\])|(\{)|(\})|(,)|(:)|(.))/gy;

export function parseExpression(source: string): Expression {
  return new ExpressionParser(tokenize(unwrapExpression(source))).read();
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  read(): Expression {
    const result = this.parse();
    if (this.tokens[this.index]?.kind !== "end") {
      throw new ExpressionSyntaxError("unexpected token");
    }
    return result;
  }

  private parse(minimumPrecedence = 0): Expression {
    let left = this.parsePrefix();
    while (true) {
      const token = this.tokens[this.index];
      if (token?.kind !== "operator") break;
      if (token.value === "!") break;
      const operator = token.value;
      const precedence = operatorPrecedence(operator);
      if (precedence < minimumPrecedence) break;
      this.index += 1;
      const right = this.parse(precedence + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  }

  private parsePrefix(): Expression {
    const token = this.readToken();
    if (token.kind === "literal") return { kind: "literal", value: token.value };
    if (token.kind === "operator" && token.value === "!") {
      return { kind: "not", value: this.parsePrefix() };
    }
    if (token.kind === "left") {
      const value = this.parse();
      if (this.tokens[this.index]?.kind !== "right") throw new ExpressionSyntaxError("missing ')'");
      this.index += 1;
      return value;
    }
    if (token.kind === "array-left") return this.parseArrayLiteral();
    if (token.kind === "object-left") return this.parseObjectLiteral();
    if (token.kind !== "identifier") throw new ExpressionSyntaxError("expected a value");
    return pathExpression(this.readPathParts(token.value));
  }

  private readToken(): Token {
    const token = this.tokens[this.index++];
    if (token === undefined) throw new ExpressionSyntaxError("expression ended unexpectedly");
    return token;
  }

  private readPathParts(first: string): string[] {
    const parts = [first];
    while (this.tokens[this.index]?.kind === "dot") {
      this.index += 1;
      const next = this.tokens[this.index++];
      if (next?.kind !== "identifier") throw new ExpressionSyntaxError("expected path segment");
      parts.push(next.value);
    }
    return parts;
  }

  private parseArrayLiteral(): Expression {
    const values: JsonValue[] = [];
    if (this.tokens[this.index]?.kind === "array-right") {
      this.index += 1;
      return { kind: "literal", value: values };
    }
    while (true) {
      values.push(this.readJsonLiteral());
      const separator = this.tokens[this.index++];
      if (separator?.kind === "array-right") break;
      if (separator?.kind !== "comma") throw new ExpressionSyntaxError("expected ',' or ']'");
      if (this.tokens[this.index]?.kind === "array-right")
        throw new ExpressionSyntaxError("trailing comma");
    }
    return { kind: "literal", value: values };
  }

  private parseObjectLiteral(): Expression {
    const value: Record<string, JsonValue> = {};
    if (this.tokens[this.index]?.kind === "object-right") {
      this.index += 1;
      return { kind: "literal", value };
    }
    while (true) {
      const key = this.readObjectKey();
      value[key] = this.readJsonLiteral();
      const separator = this.tokens[this.index++];
      if (separator?.kind === "object-right") break;
      if (separator?.kind !== "comma") throw new ExpressionSyntaxError("expected ',' or '}'");
      if (this.tokens[this.index]?.kind === "object-right")
        throw new ExpressionSyntaxError("trailing comma");
    }
    return { kind: "literal", value };
  }

  private readObjectKey(): string {
    const key = this.tokens[this.index++];
    if (key?.kind !== "literal" || typeof key.value !== "string") {
      throw new ExpressionSyntaxError("object keys must be strings");
    }
    if (this.tokens[this.index++]?.kind !== "colon")
      throw new ExpressionSyntaxError("expected ':'");
    return key.value;
  }

  private readJsonLiteral(): JsonValue {
    const expression = this.parsePrefix();
    if (expression.kind !== "literal") {
      throw new ExpressionSyntaxError("JSON literals cannot contain paths or operators");
    }
    return expression.value;
  }
}

function pathExpression(parts: readonly string[]): Expression {
  const [namespace, name, field] = parts;
  if (namespace === "paseo") return parsePaseoPath(parts);
  if (namespace === "steps" && parts.length >= 4 && field === "outputs" && name !== undefined) {
    return {
      kind: "path",
      value: { namespace: "steps", stepId: name, path: parts.slice(3) },
    };
  }
  if (namespace === "values" && parts.length === 2 && name !== undefined) {
    return { kind: "path", value: { namespace: "values", name } };
  }
  throw new ExpressionSyntaxError(`unsupported path ${parts.join(".")}`);
}

function parsePaseoPath(parts: readonly string[]): Expression {
  const [, member, key] = parts;
  if (parts.length === 2) {
    if (member === "prompt") return { kind: "path", value: { namespace: "paseo", path: "prompt" } };
    if (member === "context")
      return { kind: "path", value: { namespace: "paseo", path: "context" } };
  }
  if (parts.length === 3) {
    if (member === "inputs" && key !== undefined) {
      return { kind: "path", value: { namespace: "paseo", path: ["inputs", key] } };
    }
    if (member === "execution" && key === "id") {
      return { kind: "path", value: { namespace: "paseo", path: ["execution", "id"] } };
    }
  }
  throw new ExpressionSyntaxError(`unsupported path ${parts.join(".")}`);
}

export function expressionPaths(expression: Expression): ExpressionPath[] {
  switch (expression.kind) {
    case "literal":
      return [];
    case "path":
      return [expression.value];
    case "not":
      return expressionPaths(expression.value);
    case "binary":
      return [...expressionPaths(expression.left), ...expressionPaths(expression.right)];
  }
  throw new Error("unreachable expression node");
}

export function evaluateExpression(expression: Expression, context: ExpressionContext): JsonValue {
  switch (expression.kind) {
    case "literal":
      return expression.value;
    case "path":
      return readPath(expression.value, context);
    case "not":
      return !truthy(evaluateExpression(expression.value, context));
    case "binary": {
      const left = evaluateExpression(expression.left, context);
      const selection = selectBinaryResult(expression, left);
      if (selection === "left") return left;
      const right = evaluateExpression(expression.right, context);
      if (selection === "right") return right;
      return expression.operator === "=="
        ? sameJsonValue(left, right)
        : !sameJsonValue(left, right);
    }
  }
  throw new Error("unreachable expression node");
}

function selectBinaryResult(
  expression: Extract<Expression, { kind: "binary" }>,
  left: JsonValue,
): "left" | "right" | "compare" {
  if (expression.operator === "&&") return truthy(left) ? "right" : "left";
  if (expression.operator === "||") return truthy(left) ? "left" : "right";
  if (expression.operator === "??") return left === null ? "right" : "left";
  return "compare";
}

export function renderExpressionTemplate(template: string, context: ExpressionContext): string {
  let cursor = 0;
  let result = "";
  while (cursor < template.length) {
    const start = template.indexOf("${{", cursor);
    if (start < 0) {
      result += template.slice(cursor);
      break;
    }
    result += template.slice(cursor, start);
    const end = template.indexOf("}}", start + 3);
    if (end < 0) throw new ExpressionSyntaxError("unterminated interpolation");
    result += formatInterpolatedValue(
      evaluateExpression(parseExpression(template.slice(start + 3, end)), context),
    );
    cursor = end + 2;
  }
  return result;
}

export function renderExecutionTemplate(template: string, executionId: string): string {
  validateExecutionTemplate(template);
  return renderExpressionTemplate(template, {
    prompt: "",
    context: null,
    inputs: {},
    steps: {},
    values: {},
    executionId,
  });
}

export function validateExecutionTemplate(template: string): void {
  for (const path of expressionPathsInTemplate(template)) {
    if (
      path.namespace !== "paseo" ||
      !Array.isArray(path.path) ||
      path.path[0] !== "execution" ||
      path.path[1] !== "id"
    ) {
      throw new ExpressionSyntaxError("execution templates support only paseo.execution.id paths");
    }
  }
}

export function expressionPathsInTemplate(template: string): ExpressionPath[] {
  const paths: ExpressionPath[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("${{", cursor);
    if (start < 0) break;
    const end = template.indexOf("}}", start + 3);
    if (end < 0) throw new ExpressionSyntaxError("unterminated interpolation");
    paths.push(...expressionPaths(parseExpression(template.slice(start + 3, end))));
    cursor = end + 2;
  }
  return paths;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const match = TOKEN.exec(source);
    if (match === null) throw new ExpressionSyntaxError("unexpected character");
    const token = tokenFromMatch(match);
    if (token !== undefined) tokens.push(token);
  }
  tokens.push({ kind: "end" });
  return tokens;
}

function tokenFromMatch(match: RegExpExecArray): Token | undefined {
  const [raw, , , , , , , , , , , , , , , other] = match;
  if (other !== undefined) throw new ExpressionSyntaxError(`unexpected token ${other}`);
  const token = scalarToken(match) ?? punctuationToken(match);
  if (token !== undefined) return token;
  if (raw.trim() === "") return undefined;
  throw new ExpressionSyntaxError("unexpected token");
}

function scalarToken(match: RegExpExecArray): Token | undefined {
  const [, word, number, string, identifier, operator] = match;
  if (word !== undefined) {
    let value: JsonValue = null;
    if (word === "true") value = true;
    else if (word === "false") value = false;
    return { kind: "literal", value };
  }
  if (number !== undefined) return { kind: "literal", value: Number(number) };
  if (string !== undefined) return { kind: "literal", value: parseStringLiteral(string) };
  if (identifier !== undefined) return { kind: "identifier", value: identifier };
  if (operator !== undefined && isOperator(operator)) return { kind: "operator", value: operator };
  return undefined;
}

function punctuationToken(match: RegExpExecArray): Token | undefined {
  const [
    ,
    ,
    ,
    ,
    ,
    ,
    dot,
    left,
    right,
    arrayLeft,
    arrayRight,
    objectLeft,
    objectRight,
    comma,
    colon,
  ] = match;
  if (dot !== undefined) return { kind: "dot" };
  if (left !== undefined) return { kind: "left" };
  if (right !== undefined) return { kind: "right" };
  if (arrayLeft !== undefined) return { kind: "array-left" };
  if (arrayRight !== undefined) return { kind: "array-right" };
  if (objectLeft !== undefined) return { kind: "object-left" };
  if (objectRight !== undefined) return { kind: "object-right" };
  if (comma !== undefined) return { kind: "comma" };
  if (colon !== undefined) return { kind: "colon" };
  return undefined;
}

function parseStringLiteral(value: string): string {
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string") throw new ExpressionSyntaxError("invalid string literal");
    return parsed;
  }
  return value.slice(1, -1).replace(/\\([\\'])/gu, "$1");
}

function isOperator(value: string): value is Operator {
  return (
    value === "!" ||
    value === "==" ||
    value === "!=" ||
    value === "&&" ||
    value === "||" ||
    value === "??"
  );
}

function unwrapExpression(source: string): string {
  const trimmed = source.trim();
  if (!trimmed.startsWith("${{")) return trimmed;
  if (!trimmed.endsWith("}}")) throw new ExpressionSyntaxError("unterminated expression");
  return trimmed.slice(3, -2).trim();
}

function operatorPrecedence(operator: BinaryOperator): number {
  if (operator === "??") return 1;
  if (operator === "||") return 2;
  if (operator === "&&") return 3;
  return 4;
}

const FORBIDDEN_CONTEXT_KEYS = new Set(["constructor", "prototype", "__proto__"]);

export function isReservedContextKey(key: string): boolean {
  return FORBIDDEN_CONTEXT_KEYS.has(key);
}

function readOwnContextKey<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  if (FORBIDDEN_CONTEXT_KEYS.has(key) || !Object.hasOwn(record, key)) return undefined;
  return record[key];
}

function readPath(path: ExpressionPath, context: ExpressionContext): JsonValue {
  if (path.namespace === "paseo") return readPaseoPath(path.path, context);
  if (path.namespace === "values") {
    const expression = readOwnContextKey(context.values, path.name);
    if (expression === undefined)
      throw new ExpressionEvaluationError(`value ${path.name} is unavailable`);
    return evaluateExpression(expression, context);
  }
  return readStepOutput(path, context);
}

function readStepOutput(
  path: Extract<ExpressionPath, { namespace: "steps" }>,
  context: ExpressionContext,
): JsonValue {
  const step = readOwnContextKey(context.steps, path.stepId);
  if (step === undefined || step.status !== "succeeded") {
    throw new ExpressionEvaluationError(`output from step ${path.stepId} is unavailable`);
  }
  let value: unknown = step.output;
  for (const segment of path.path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment)) {
      throw new ExpressionEvaluationError(
        `output path steps.${path.stepId}.outputs.${path.path.join(".")} is missing`,
      );
    }
    value = Reflect.get(value, segment);
  }
  if (!isJsonValue(value)) throw new ExpressionEvaluationError("output contains a non-JSON value");
  return value;
}

function readPaseoPath(
  path: Extract<ExpressionPath, { namespace: "paseo" }>["path"],
  context: ExpressionContext,
): JsonValue {
  if (path === "prompt") return context.prompt;
  if (path === "context") return context.context;
  if (path[0] === "execution") {
    if (context.executionId === undefined) {
      throw new ExpressionEvaluationError("execution ID is unavailable");
    }
    return context.executionId;
  }
  return readOwnContextKey(context.inputs, path[1]) ?? null;
}

function truthy(value: JsonValue): boolean {
  return value !== false && value !== null && value !== 0 && value !== "";
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (typeof left !== typeof right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatInterpolatedValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}
