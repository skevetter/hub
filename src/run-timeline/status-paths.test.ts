import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, it } from "vitest";
import { OBSERVED_DATABASE_METHODS } from "./observed-database.js";

interface Owner {
  id: string;
  name: string;
  className?: string;
  root: boolean;
  calls: Set<string>;
}

interface StatusWrite {
  owner: string;
  table: string;
  roots: string[];
}

const TABLES: Record<string, true | undefined> = { workflow_step_runs: true, trigger_runs: true };

function hasStatusAssignment(tokens: string[], cursor: number): boolean {
  let depth = 0;
  let assignment = true;
  for (; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (
      depth === 0 &&
      (token === "where" ||
        token === "from" ||
        token === "returning" ||
        token === ";" ||
        token === ")")
    )
      break;
    if (depth === 0 && assignment) {
      if (token === "status" && tokens[cursor + 1] === "=") return true;
      assignment = false;
    }
    if (token === "(") depth += 1;
    if (token === ")") depth -= 1;
    if (depth === 0 && token === ",") assignment = true;
  }
  return false;
}

function expressionName(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return undefined;
}

function drizzleStatusTable(node: ts.CallExpression): string | undefined {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "set" ||
    !node.arguments[0] ||
    !ts.isObjectLiteralExpression(node.arguments[0])
  )
    return undefined;
  const update = node.expression.expression;
  if (
    !ts.isCallExpression(update) ||
    !ts.isPropertyAccessExpression(update.expression) ||
    update.expression.name.text !== "update"
  )
    return undefined;
  const table = expressionName(update.arguments[0])?.replace(
    /[A-Z]/g,
    (letter) => `_${letter.toLowerCase()}`,
  );
  if (
    table &&
    TABLES[table] === true &&
    node.arguments[0].properties.some(
      (property) => "name" in property && expressionName(property.name) === "status",
    )
  )
    return table;
  return undefined;
}

function sqlStatusTables(sql: string): string[] {
  const tokens = (
    sql.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9$]*|[^\s]/gi,
    ) ?? []
  )
    .filter((token) => !token.startsWith("--") && !token.startsWith("/*"))
    .map((token) =>
      token.startsWith("'") ? "<literal>" : token.replace(/^"|"$/g, "").toLowerCase(),
    );
  const tables: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== "update") continue;
    let cursor = i + 1;
    if (tokens[cursor] === "only") cursor += 1;
    let table = tokens[cursor++];
    while (tokens[cursor] === ".") {
      table = tokens[cursor + 1];
      cursor += 2;
    }
    if (table === undefined || TABLES[table] !== true) continue;
    if (tokens[cursor] === "as") cursor += 2;
    else if (tokens[cursor] !== "set") cursor += 1;
    if (tokens[cursor++] !== "set") continue;
    if (hasStatusAssignment(tokens, cursor)) tables.push(table);
  }
  return tables;
}

function analyzeStatusPaths(source: string): { writes: StatusWrite[]; uncovered: string[] } {
  const file = ts.createSourceFile("pg.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const owners = new Map<string, Owner>();
  const declarations = new Map<ts.Node, Owner>();
  function discover(node: ts.Node, className?: string): void {
    if (ts.isClassDeclaration(node)) className = node.name?.text ?? "<anonymous>";
    let name: string | undefined;
    let root = false;
    if (
      ts.isMethodDeclaration(node) &&
      node.name &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      name = node.name.text;
      root = !node.modifiers?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword ||
          modifier.kind === ts.SyntaxKind.ProtectedKeyword,
      );
    } else if (ts.isFunctionDeclaration(node)) {
      name = node.name?.text;
      className = undefined;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
    }
    if (name !== undefined) {
      const id = className === undefined ? name : `${className}.${name}`;
      const owner: Owner = {
        id,
        name,
        root,
        calls: new Set(),
        ...(className === undefined ? {} : { className }),
      };
      owners.set(id, owner);
      declarations.set(node, owner);
    }
    ts.forEachChild(node, (child) => discover(child, className));
  }
  discover(file);
  const writes: StatusWrite[] = [];
  function inspect(node: ts.Node, parentOwner?: Owner): void {
    const owner = declarations.get(node) ?? parentOwner;
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const sql = ts.isTemplateExpression(node)
        ? node.head.text +
          node.templateSpans.map((span) => ` <expression> ${span.literal.text}`).join("")
        : node.text;
      for (const table of sqlStatusTables(sql))
        writes.push({ owner: owner?.id ?? "<unowned>", table, roots: [] });
    }
    if (ts.isCallExpression(node)) {
      const table = drizzleStatusTable(node);
      if (table) writes.push({ owner: owner?.id ?? "<unowned>", table, roots: [] });
    }
    if (owner && ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) owner.calls.add(node.expression.text);
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        owner.calls.add(`${owner.className}.${node.expression.name.text}`);
      }
    }
    ts.forEachChild(node, (child) => inspect(child, owner));
  }
  inspect(file);
  for (const root of owners.values()) {
    if (!root.root) continue;
    const visited = new Set<string>();
    function reach(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      for (const write of writes) if (write.owner === id) write.roots.push(root.name);
      for (const call of owners.get(id)?.calls ?? []) reach(call);
    }
    reach(root.id);
  }
  const uncovered = writes.flatMap((write) =>
    write.roots.length === 0
      ? [`${write.owner}: ${write.table} has no public entry root`]
      : write.roots
          .filter((root) => !OBSERVED_DATABASE_METHODS.some((method) => method === root))
          .map((root) => `${root} -> ${write.owner}: ${write.table}`),
  );
  return { writes, uncovered };
}

describe("workflow status persistence observation", () => {
  it("covers every PostgreSQL status statement and every public root reaching its helpers", async () => {
    const source = await readFile(new URL("../db/pg.ts", import.meta.url), "utf8");
    const { writes, uncovered } = analyzeStatusPaths(source);
    assert.ok(writes.some((write) => write.owner.endsWith(".createWorkflowStepExecution")));
    for (const helper of [
      "timeoutWorkflowRunOnClient",
      "timeoutWorkflowStepOnClient",
      "finishWorkflowStepAndRun",
    ]) {
      assert.ok(
        writes.some(
          (write) =>
            write.owner === helper &&
            write.roots.includes("completeWorkflowAgentExecution") &&
            write.roots.includes("completeWorkflowStep"),
        ),
      );
    }
    assert.deepEqual(uncovered, []);
  });

  it("detects new unobserved writers, indirect helper callers and orphan helpers", () => {
    const source = `
      class Database {
        createWorkflowStepExecution() { helper(); }
        addedWriter() { helper(); }
        addedDirect() { query(\`with changed as (update public."trigger_runs" as r set "status" = 'failed' returning *) select * from changed\`); }
      }
      function helper() { query('update workflow_step_runs s set status = $1 where s.id = $2'); }
      function orphan() { query('update trigger_runs set status = $1'); }
    `;
    const result = analyzeStatusPaths(source);
    assert.ok(result.uncovered.some((path) => path.startsWith("addedWriter -> helper:")));
    assert.ok(
      result.uncovered.some((path) => path.startsWith("addedDirect -> Database.addedDirect:")),
    );
    assert.ok(result.uncovered.some((path) => path.startsWith("orphan:")));
    assert.equal(
      result.uncovered.some((path) => path.startsWith("createWorkflowStepExecution ->")),
      false,
    );
  });

  it("recognizes aliases, CTEs and quoted tables without mistaking other updates for status writes", () => {
    const result = analyzeStatusPaths(`class Database {
      updateWorkflowScriptStep() {
        query(\`with first as (update workflow_step_runs s set output = 'status = failed' where s.status = 'running' returning *)
          update public."trigger_runs" as r set values = $1, "status" = 'failed' where r.id = $2\`);
        query('update workflow_step_runs set output = case when status = $1 then $2 else $3 end where status = $4');
        query('insert into workflow_step_runs (status) values ($1) on conflict do update set output = $2');
      }
    }`);
    assert.deepEqual(
      result.writes.map((write) => write.table),
      ["trigger_runs"],
    );
    assert.deepEqual(result.uncovered, []);
  });

  it("detects future Drizzle status setters and ignores non-status setters", () => {
    const result = analyzeStatusPaths(`class Database {
      addedWriter() { db.update(schema.workflowStepRuns).set({ status: 'failed' }); }
      setOutput() { db.update(schema.workflowStepRuns).set({ output: { status: 'failed' } }); }
    }`);
    assert.equal(result.writes.length, 1);
    assert.deepEqual(result.uncovered, ["addedWriter -> Database.addedWriter: workflow_step_runs"]);
  });
});
