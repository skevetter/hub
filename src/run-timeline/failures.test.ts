import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { encodeEntitlementDenialFailureReason } from "../entitlements/denial.js";
import { failurePhrase } from "./failures.js";

const TABLE = [
  ["step_idle_timeout", "idle_timeout", "the agent was idle too long"],
  ["step_hard_timeout", "run_timeout", "the run reached its time limit"],
  ["workflow_timed_out", "run_timeout", "the run reached its time limit"],
  ["agent_interrupted", "agent_interrupted", "the agent stopped before it finished"],
  ["agent_execution_failed", "agent_failed", "the agent run failed"],
  ...["daemon_disconnected", "daemon_unreachable", "daemon_not_registered", "daemon_timeout"].map(
    (reason) => [reason, "host_unavailable", "the host could not be reached"] as const,
  ),
  ...["launch_failed", "workflow_environment_unavailable"].map(
    (reason) => [reason, "launch_failed", "the agent could not be started"] as const,
  ),
  ...[
    "execution_credentials_unavailable",
    "execution_authority_stopped",
    "tenant_authority_mismatch",
  ].map(
    (reason) =>
      [reason, "credentials_unavailable", "access for the run was not available"] as const,
  ),
  ...[
    "workflow_configuration_revision_required",
    "workflow_value_evaluation_failed",
    "workflow_condition_evaluation_failed",
  ].map(
    (reason) =>
      [reason, "configuration_error", "the trigger configuration could not be applied"] as const,
  ),
  [
    "script interrupted: Hub restarted while it was running",
    "script_interrupted",
    "the script was interrupted by a restart",
  ],
  [
    "This Hub cannot run scripts: it has no daemon terminal channel.",
    "script_unavailable",
    "this Hub cannot run scripts",
  ],
] as const;

const DELIBERATELY_GENERIC: Readonly<Record<string, true>> = {
  completion_auth_not_configured: true,
  completion_url_not_configured: true,
  timeout: true,
  idle_timeout: true,
  whole_run_timeout: true,
  internal: true,
  discord_trigger_unavailable: true,
  execution_terminal: true,
  github_authority_scope_invalid: true,
  github_authority_unavailable: true,
  github_integration_unavailable: true,
  github_trigger_unavailable: true,
  slack_trigger_unavailable: true,
  trigger_context_materializer_unavailable: true,
  trigger_context_unavailable: true,
  "required output capability unavailable": true,
  workflow_step_failed: true,
  workflow_step_timed_out: true,
  workflow_failed: true,
};

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["test-utils", "e2e"].includes(entry.name) ? [] : productionSources(path);
    return /\.tsx?$/u.test(entry.name) &&
      !/\.test\.tsx?$/u.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

function namedConstruction(node: ts.Node, name: string): ts.NewExpression | undefined {
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name)
    return node;
  return undefined;
}

function reasonInputs(node: ts.Node): readonly ts.Node[] {
  if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse];
  if (ts.isBinaryExpression(node)) return [node.left, node.right];
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return [node.expression];
  if (ts.isArrayLiteralExpression(node)) return node.elements;
  return namedConstruction(node, "Set")?.arguments ?? [];
}

function createReasonCollector(checker: ts.TypeChecker, reasons: Set<string>) {
  function collectIdentifier(node: ts.Identifier, seen: Set<ts.Node>): void {
    const symbol = checker.getSymbolAtLocation(node);
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
        collect(declaration.initializer, seen);
    }
  }

  function collectTemplate(node: ts.TemplateExpression): void {
    expect(
      node.getText(),
      "New dynamic failure templates need an explicit vocabulary decision",
    ).toBe("`workflow_step_${status}`");
    reasons.add("workflow_step_failed");
    reasons.add("workflow_step_timed_out");
  }

  function collect(node: ts.Node, seen = new Set<ts.Node>()): void {
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) {
      reasons.add(node.text);
    } else if (ts.isIdentifier(node)) {
      collectIdentifier(node, seen);
    } else if (ts.isTemplateExpression(node)) {
      collectTemplate(node);
    } else {
      for (const input of reasonInputs(node)) collect(input, seen);
    }
  }
  return collect;
}

function reasonArgumentIndex(method: string): number | undefined {
  if (method === "failWorkflowRun") return 2;
  if (method === "failAgentExecution") return 1;
  return undefined;
}

function enumerateReasonLiterals(): { reasons: Set<string>; sinks: number; constants: number } {
  const files = productionSources(fileURLToPath(new URL("../", import.meta.url)));
  const program = ts.createProgram(files, {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
  });
  const reasons = new Set<string>();
  const collect = createReasonCollector(program.getTypeChecker(), reasons);
  let sinks = 0;
  let constants = 0;
  function collectSink(node: ts.Node): void {
    const construction = namedConstruction(node, "DaemonDispatchFailure");
    if (construction !== undefined) {
      sinks += 1;
      const reason = construction.arguments?.[0];
      if (reason !== undefined) collect(reason);
    }
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const index = reasonArgumentIndex(node.expression.name.text);
    if (index === undefined) return;
    sinks += 1;
    const reason = node.arguments[index];
    if (reason !== undefined) collect(reason);
  }
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error("missing parsed production source");
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        (/(?:FAILURE_REASON|_REASON)$/u.test(node.name.text) ||
          node.name.text === "DISPATCH_PREPARATION_FAILURE_CODES")
      ) {
        constants += 1;
        collect(node.initializer);
      }
      collectSink(node);
      if (
        file.endsWith("/daemons/lifecycle.ts") &&
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "reason"
      )
        collect(node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { reasons, sinks, constants };
}

describe("closed failure vocabulary", () => {
  it.each(TABLE)(
    "maps exact reason %s to %s without copying the reason",
    (reason, code, phrase) => {
      expect(failurePhrase(reason)).toEqual({ code, phrase });
    },
  );

  it.each(["cap", "meter", "flag"] as const)(
    "decodes %s entitlement denials without copying the entitlement or numeric details",
    (kind) => {
      const reason = encodeEntitlementDenialFailureReason({
        error: "entitlement_denied",
        entitlement: "private entitlement @everyone",
        kind,
        limit: kind === "flag" ? null : 3,
        current: kind === "flag" ? null : 5,
      });
      expect(failurePhrase(reason)).toEqual({
        code: "limit_reached",
        phrase: "the organization's run limit was reached",
      });
    },
  );

  it("lets timed_out status override every known, unknown, absent or hostile reason", () => {
    for (const reason of [
      undefined,
      null,
      42,
      {},
      "script exited 3",
      "step_idle_timeout",
      "@everyone",
      "x".repeat(10000),
      ...TABLE.map(([literalReason]) => literalReason),
    ]) {
      expect(failurePhrase(reason, "timed_out")).toEqual({
        code: "run_timeout",
        phrase: "the run reached its time limit",
      });
    }
  });

  it("copies only a canonical numeric script exit code in 0..255 and uses fixed timeout prefix vocabulary", () => {
    for (let exit = 0; exit <= 255; exit += 1) {
      expect(failurePhrase(`script exited ${exit}`)).toEqual({
        code: "script_failed",
        phrase: `the script exited with code ${exit}`,
      });
    }
    expect(failurePhrase("script exited 003")).toEqual({
      code: "script_failed",
      phrase: "the script exited with code 3",
    });
    expect(failurePhrase("script exited 0000")).toEqual({
      code: "script_failed",
      phrase: "the script exited with code 0",
    });
    for (const reason of [
      "script timed out",
      "script timed out after 12ms: private details",
      "script timed out\n@everyone",
      "script timed out " + "x".repeat(10000),
    ]) {
      expect(failurePhrase(reason)).toEqual({
        code: "script_timeout",
        phrase: "the script reached its time limit",
      });
    }
  });

  it("maps dynamic errors, prototype keys, whitespace changes, malformed denials and nonnumeric or out-of-range exit suffixes to generic failure", () => {
    for (const reason of [
      undefined,
      null,
      3,
      {},
      new Error("step_idle_timeout"),
      "unknown",
      "has spaces",
      "x".repeat(10000),
      "__proto__",
      "constructor",
      "toString",
      " step_idle_timeout",
      "step_idle_timeout ",
      "script exited -1",
      "script exited +3",
      "script exited 3x",
      "script exited 3\n",
      "script exited 3.0",
      "script exited 256",
      "script exited 999",
      "script exited 1000",
      "script exited 000256",
      "script exited \u0663",
      "script exited ",
      "script exited NaN",
      "script exited 3 @everyone",
      "script timed ou",
      "SCRIPT TIMED OUT",
      "script interrupted: Hub restarted while it was running; private cleanup detail",
      '{"error":"entitlement_denied"}',
      '{"error":"boom"}',
    ]) {
      expect(failurePhrase(reason)).toEqual({ code: "failed", phrase: "the run failed" });
    }
  });

  it("requires every production reason constant, dispatch failure and workflow failure literal to be mapped or deliberately generic", () => {
    const { reasons, sinks, constants } = enumerateReasonLiterals();
    expect(sinks).toBeGreaterThanOrEqual(20);
    expect(constants).toBeGreaterThanOrEqual(3);
    expect(reasons.has("completion_auth_not_configured")).toBe(true);
    expect(reasons.has("trigger_context_materializer_unavailable")).toBe(true);
    expect(reasons.has("trigger_context_unavailable")).toBe(true);
    expect(reasons.has("script interrupted: Hub restarted while it was running")).toBe(true);
    for (const reason of reasons) {
      expect(
        failurePhrase(reason).code !== "failed" || Object.hasOwn(DELIBERATELY_GENERIC, reason),
        `Unreviewed production failure reason: ${reason}`,
      ).toBe(true);
    }
    for (const reason of Object.keys(DELIBERATELY_GENERIC))
      expect(failurePhrase(reason).code).toBe("failed");
  });

  it("never reflects collaborator or daemon strings, including markup and secrets, across a deterministic hostile corpus", () => {
    const forbidden = [
      "@everyone",
      "<!channel>",
      "# heading",
      "[private](https://private.test)",
      ["gh", "p_", "privatecollaboratorvalue0192837465"].join(""),
    ];
    for (let index = 0; index < 500; index += 1) {
      const input = `${index} ${forbidden[index % forbidden.length]} private failure ${index * 31}`;
      const value = failurePhrase(input, index % 4 === 0 ? "timed_out" : "failed");
      expect(value).toEqual(
        index % 4 === 0
          ? { code: "run_timeout", phrase: "the run reached its time limit" }
          : { code: "failed", phrase: "the run failed" },
      );
      for (const text of forbidden) expect(JSON.stringify(value)).not.toContain(text);
    }
  });
});
