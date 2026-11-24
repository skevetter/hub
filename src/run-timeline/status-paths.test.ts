import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

function isAssignmentTerminator(token: string | undefined): boolean {
  return (
    token === "where" || token === "from" || token === "returning" || token === ";" || token === ")"
  );
}

function assignmentDepth(token: string | undefined, depth: number): number {
  if (token === "(") depth += 1;
  if (token === ")") depth -= 1;
  return depth;
}

function hasStatusAssignment(tokens: string[], cursor: number): boolean {
  let depth = 0;
  let assignment = true;
  for (; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (depth === 0 && isAssignmentTerminator(token)) break;
    if (depth === 0 && assignment) {
      if (token === "status" && tokens[cursor + 1] === "=") return true;
      assignment = false;
    }
    depth = assignmentDepth(token, depth);
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

function statusProperties(object: ts.ObjectLiteralExpression): boolean {
  return object.properties.some(
    (property) => "name" in property && expressionName(property.name) === "status",
  );
}

function drizzleUpdateTable(update: ts.Expression): string | undefined {
  if (
    !ts.isCallExpression(update) ||
    !ts.isPropertyAccessExpression(update.expression) ||
    update.expression.name.text !== "update"
  )
    return undefined;
  return expressionName(update.arguments[0])?.replace(
    /[A-Z]/g,
    (letter) => `_${letter.toLowerCase()}`,
  );
}

function drizzleStatusTable(node: ts.CallExpression): string | undefined {
  if (
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== "set" ||
    !node.arguments[0] ||
    !ts.isObjectLiteralExpression(node.arguments[0])
  )
    return undefined;
  const table = drizzleUpdateTable(node.expression.expression);
  if (table && TABLES[table] === true && statusProperties(node.arguments[0])) return table;
  return undefined;
}

function sqlUpdateStatusTable(tokens: string[], cursor: number): string | undefined {
  if (tokens[cursor] === "only") cursor += 1;
  let table = tokens[cursor++];
  while (tokens[cursor] === ".") {
    table = tokens[cursor + 1];
    cursor += 2;
  }
  if (table === undefined || TABLES[table] !== true) return undefined;
  if (tokens[cursor] === "as") cursor += 2;
  else if (tokens[cursor] !== "set") cursor += 1;
  if (tokens[cursor++] !== "set") return undefined;
  return hasStatusAssignment(tokens, cursor) ? table : undefined;
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
    const table = sqlUpdateStatusTable(tokens, i + 1);
    if (table !== undefined) tables.push(table);
  }
  return tables;
}

function postgresStatusTables(node: ts.Node): string[] {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
    const sql = ts.isTemplateExpression(node)
      ? node.head.text +
        node.templateSpans.map((span) => ` <expression> ${span.literal.text}`).join("")
      : node.text;
    return sqlStatusTables(sql);
  }
  if (ts.isCallExpression(node)) {
    const table = drizzleStatusTable(node);
    return table === undefined ? [] : [table];
  }
  return [];
}

function statusDeclarationTables(declaration: ts.Declaration): string[] {
  const parent = declaration.parent;
  if (!ts.isInterfaceDeclaration(parent)) return [];
  if (parent.name.text === "WorkflowStepRunRecord") return ["workflow_step_runs"];
  if (
    parent.name.text === "AcceptedTriggerRunRecord" ||
    parent.name.text === "RejectedTriggerRunRecord"
  )
    return ["trigger_runs"];
  return [];
}

function namedRecordTables(name: string | undefined): string[] | undefined {
  if (name === "WorkflowStepRunRecord") return ["workflow_step_runs"];
  if (
    name === "TriggerRunRecord" ||
    name === "AcceptedTriggerRunRecord" ||
    name === "RejectedTriggerRunRecord"
  )
    return ["trigger_runs"];
  return undefined;
}

function recordTypeTables(type: ts.Type): string[] {
  if (type.isUnion()) return type.types.flatMap(recordTypeTables);
  const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
  const tables = namedRecordTables(name);
  if (tables !== undefined) return tables;
  const status = type.getProperty("status");
  return (status?.declarations ?? []).flatMap(statusDeclarationTables);
}

function statusAssignmentTarget(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
  ) {
    const name = ts.isPropertyAccessExpression(node.left)
      ? node.left.name.text
      : expressionName(node.left.argumentExpression);
    if (name === "status") return node.left.expression;
  }
  return undefined;
}

function objectAssignStatusTarget(node: ts.Node): ts.Expression | undefined {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    node.expression.name.text === "assign" &&
    node.arguments[0] &&
    node.arguments
      .slice(1)
      .some((argument) => ts.isObjectLiteralExpression(argument) && statusProperties(argument))
  )
    return node.arguments[0];
  return undefined;
}

function memoryStatusTables(node: ts.Node, checker: ts.TypeChecker): string[] {
  function recordTables(expression: ts.Expression): string[] {
    const recordType = checker.getTypeAtLocation(expression);
    return [...new Set(recordTypeTables(recordType))];
  }
  const assignment = statusAssignmentTarget(node);
  if (assignment !== undefined) return recordTables(assignment);
  if (ts.isObjectLiteralExpression(node) && statusProperties(node)) {
    return [
      ...new Set(
        node.properties.flatMap((property) =>
          ts.isSpreadAssignment(property) ? recordTables(property.expression) : [],
        ),
      ),
    ];
  }
  const target = objectAssignStatusTarget(node);
  return target === undefined ? [] : recordTables(target);
}

function memorySourceFile(source: string): { file: ts.SourceFile; checker: ts.TypeChecker } {
  const path = fileURLToPath(new URL("../db/memory.ts", import.meta.url));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === path
      ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([path], options, host);
  const file = program.getSourceFile(path);
  assert.ok(file);
  return { file, checker: program.getTypeChecker() };
}

function functionVariableName(node: ts.Node): string | undefined {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  )
    return node.name.text;
  return undefined;
}

function ownerDeclaration(node: ts.Node, className: string | undefined) {
  if (
    ts.isMethodDeclaration(node) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    const root = !node.modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    );
    return { name: node.name.text, root, className };
  }
  if (ts.isFunctionDeclaration(node)) {
    return { name: node.name?.text, root: false, className: undefined };
  }
  return { name: functionVariableName(node), root: false, className };
}

function discoverOwners(file: ts.SourceFile) {
  const owners = new Map<string, Owner>();
  const declarations = new Map<ts.Node, Owner>();
  function discover(node: ts.Node, className?: string): void {
    if (ts.isClassDeclaration(node)) className = node.name?.text ?? "<anonymous>";
    const declaration = ownerDeclaration(node, className);
    const { name, root } = declaration;
    className = declaration.className;
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
  return { owners, declarations };
}

function recordOwnerCall(owner: Owner, node: ts.CallExpression): void {
  if (ts.isIdentifier(node.expression)) owner.calls.add(node.expression.text);
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    owner.calls.add(`${owner.className}.${node.expression.name.text}`);
  }
}

function analyzeStatusPaths(
  source: string,
  backend: "postgres" | "memory" = "postgres",
): { writes: StatusWrite[]; uncovered: string[] } {
  const memory = backend === "memory" ? memorySourceFile(source) : undefined;
  const file =
    memory?.file ??
    ts.createSourceFile("pg.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const { owners, declarations } = discoverOwners(file);
  const writes: StatusWrite[] = [];
  function inspect(node: ts.Node, parentOwner?: Owner): void {
    const owner = declarations.get(node) ?? parentOwner;
    const tables = memory ? memoryStatusTables(node, memory.checker) : postgresStatusTables(node);
    for (const table of tables) writes.push({ owner: owner?.id ?? "<unowned>", table, roots: [] });
    if (owner && ts.isCallExpression(node)) recordOwnerCall(owner, node);
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
    assert.ok(
      writes.some(
        (write) =>
          write.owner === "markWorkflowStepExecutionStarted" &&
          write.roots.includes("createWorkflowStepExecution"),
      ),
    );
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

  it("covers every memory status mutation and every public root reaching its helpers", async () => {
    const source = await readFile(new URL("../db/memory.ts", import.meta.url), "utf8");
    const { writes, uncovered } = analyzeStatusPaths(source, "memory");
    for (const method of OBSERVED_DATABASE_METHODS) {
      assert.ok(
        writes.some((write) => write.roots.includes(method)),
        `memory status inventory did not reach ${method}`,
      );
    }
    for (const helper of ["timeoutWorkflowRun", "timeoutWorkflowStep", "finishWorkflowStep"]) {
      for (const table of ["workflow_step_runs", "trigger_runs"]) {
        assert.ok(
          writes.some(
            (write) =>
              write.owner === `MemoryDatabase.${helper}` &&
              write.table === table &&
              write.roots.includes("completeWorkflowAgentExecution") &&
              write.roots.includes("completeWorkflowStep"),
          ),
          `memory status inventory missed ${helper}: ${table}`,
        );
      }
    }
    assert.deepEqual(uncovered, []);
  });

  it("rejects an unobserved memory-only public status writer inserted into the actual source", async () => {
    const source = await readFile(new URL("../db/memory.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("memory.ts", source, ts.ScriptTarget.Latest, true);
    const database = file.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === "MemoryDatabase",
    );
    assert.ok(database);
    const insertion = database.end - 1;
    const mutated = `${source.slice(0, insertion)}
      unobservedMemoryStatusWrite(stepRunId: string) {
        const step = this.workflowStepRuns.get(stepRunId);
        if (step !== undefined) step.status = "failed";
      }
    ${source.slice(insertion)}`;
    const { writes, uncovered } = analyzeStatusPaths(mutated, "memory");
    assert.ok(
      writes.some(
        (write) =>
          write.owner === "MemoryDatabase.unobservedMemoryStatusWrite" &&
          write.table === "workflow_step_runs",
      ),
    );
    assert.deepEqual(uncovered, [
      "unobservedMemoryStatusWrite -> MemoryDatabase.unobservedMemoryStatusWrite: workflow_step_runs",
    ]);
  });

  it("tracks typed memory aliases, replacements, helper callers and orphan helpers without treating other records or initial inserts as mutations", async () => {
    const source = await readFile(new URL("../db/memory.ts", import.meta.url), "utf8");
    const result = analyzeStatusPaths(
      `${source}
      class MemoryInventoryProbe {
        private readonly arbitrarySteps = new Map<string, WorkflowStepRunRecord>();
        private readonly arbitraryRuns = new Map<string, TriggerRunRecord>();
        createWorkflowStepExecution() { this.changeStep(); }
        addedCaller() { this.changeStep(); }
        private changeStep() {
          const original = this.arbitrarySteps.get("step");
          if (original === undefined) return;
          const renamed = original;
          renamed["status"] = "failed";
          Object.assign(renamed, { status: "failed" });
          this.arbitrarySteps.set(renamed.id, { ...renamed, status: "failed" });
          this.arbitrarySteps.set(renamed.id, { ...renamed, output: { status: "failed" } });
          const unrelated = { status: "running" };
          unrelated.status = "failed";
          const fresh: WorkflowStepRunRecord = { status: "pending" } as WorkflowStepRunRecord;
          this.arbitrarySteps.set("fresh", fresh);
        }
        addedRunWriter() {
          for (const branch of this.arbitraryRuns.values()) {
            branch.status = "failed";
            this.arbitraryRuns.set(branch.id, { ...branch, status: "failed" });
          }
        }
      }
      function orphanMemoryWriter(step: WorkflowStepRunRecord) {
        step.status = "failed";
      }
    `,
      "memory",
    );
    const probeWrites = result.writes.filter((write) =>
      write.owner.startsWith("MemoryInventoryProbe."),
    );
    assert.deepEqual(
      probeWrites.map((write) => [write.owner, write.table]),
      [
        ["MemoryInventoryProbe.changeStep", "workflow_step_runs"],
        ["MemoryInventoryProbe.changeStep", "workflow_step_runs"],
        ["MemoryInventoryProbe.changeStep", "workflow_step_runs"],
        ["MemoryInventoryProbe.addedRunWriter", "trigger_runs"],
        ["MemoryInventoryProbe.addedRunWriter", "trigger_runs"],
      ],
    );
    assert.deepEqual(result.uncovered, [
      "addedCaller -> MemoryInventoryProbe.changeStep: workflow_step_runs",
      "addedCaller -> MemoryInventoryProbe.changeStep: workflow_step_runs",
      "addedCaller -> MemoryInventoryProbe.changeStep: workflow_step_runs",
      "addedRunWriter -> MemoryInventoryProbe.addedRunWriter: trigger_runs",
      "addedRunWriter -> MemoryInventoryProbe.addedRunWriter: trigger_runs",
      "orphanMemoryWriter: workflow_step_runs has no public entry root",
    ]);
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
