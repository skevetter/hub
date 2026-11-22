import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isEntrypoint, printRunContext, repositoryFor } from "./test-context.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const sourceFile = /\.[cm]?[jt]sx?$/u;
const readMethods = /^(?:readFile|readdir|opendir|readlink|glob)(?:Sync)?$|^createReadStream$/u;

// These reads cross a function boundary or consume generated files.
const dynamicInputs = {
  "src/provider-applications/evidence-contract.test.ts": {
    path: ["e2e/apps.spec.ts", "e2e/apps-mobile.spec.ts"],
  },
  "src/run-stream/test-utils/compiled-runtime.ts": { original: [".output/server/"] },
  "src/run-timeline/failures.test.ts": { directory: ["src/"] },
  "src/run-timeline/secrets.test.ts": { directory: ["src/"], path: ["src/"] },
  "src/test-utils/current-project-configuration.ts": {
    path: ["src/config/fixtures/current-project/"],
  },
  "src/triggers/configuration/legacy-migration.matrix.test.ts": {
    root: ["src/config/fixtures/current-project/"],
    path: ["src/config/fixtures/current-project/"],
  },
  "src/typography-policy.test.ts": { directory: ["src/"], path: ["src/"] },
};

function walk(ts, node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(ts, child, visit));
}

function staticPath(ts, node, file, bindings, seen = new Set()) {
  if (!node) return undefined;
  if (node.getText() === "import.meta.url") return `/${file}`;

  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) {
    if (node.text === "__dirname") return posix.dirname(`/${file}`);
    if (node.text === "__filename") return `/${file}`;
    if (seen.has(node.text)) return undefined;
    return staticPath(ts, bindings.get(node.text), file, bindings, new Set([...seen, node.text]));
  }
  if (ts.isNewExpression(node) && node.expression.getText() === "URL") {
    const [path, base] = node.arguments ?? [];
    const value = staticPath(ts, path, file, bindings, seen);
    if (value !== undefined && base?.getText() === "import.meta.url") {
      return fileURLToPath(new URL(value, pathToFileURL(`/${file}`)));
    }
  }
  if (!ts.isCallExpression(node)) return undefined;
  const method = node.expression.getText();
  if (method === "process.cwd") return "/";
  const parts = node.arguments.map((arg) => staticPath(ts, arg, file, bindings, seen));
  if (method === "fileURLToPath") return parts[0];
  if (method === "dirname" && parts[0] !== undefined) return posix.dirname(parts[0]);
  if (!["join", "resolve"].includes(method) || parts[0] === undefined) return undefined;
  const unknown = parts.indexOf(undefined);
  if (unknown === -1) return posix[method]("/", ...parts);
  return `${posix[method]("/", ...parts.slice(0, unknown)).replace(/\/$/u, "")}/`;
}

export function readRuntimeInputs(ts, file, source, directory = root) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = new Map();
  const readers = new Map();
  const fsNamespaces = new Set();
  for (const statement of ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !/^(?:node:)?fs(?:\/promises)?$/u.test(statement.moduleSpecifier.text)
    )
      continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) fsNamespaces.add(clause.name.text);
    const names = clause.namedBindings;
    if (names && ts.isNamespaceImport(names)) fsNamespaces.add(names.name.text);
    if (names && ts.isNamedImports(names)) {
      for (const item of names.elements) {
        const imported = (item.propertyName ?? item.name).text;
        if (readMethods.test(imported)) readers.set(item.name.text, imported);
        if (imported === "promises") fsNamespaces.add(item.name.text);
      }
    }
  }
  if (!readers.size && !fsNamespaces.size) return [];
  walk(ts, ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
  });
  const inputs = new Set();
  walk(ts, ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = node.expression.getText();
    const [namespace, ...properties] = name.split(".");
    const method =
      readers.get(name) ?? (fsNamespaces.has(namespace) ? properties.at(-1) : undefined);
    if (!method || !readMethods.test(method)) return;
    const arg = node.arguments[0];
    const value = staticPath(ts, arg, file, bindings);
    if (value === undefined) {
      const fallback = dynamicInputs[file]?.[arg?.getText()];
      if (!fallback) throw new Error(`Unmapped runtime read in ${file}: ${node.getText()}`);
      for (const path of fallback) inputs.add(path);
      return;
    }
    const path = value.replace(/^\//u, "");
    if (!path || path.startsWith("../"))
      throw new Error(`Unmapped runtime directory in ${file}: ${value}`);
    const folder =
      /^(?:readdir|opendir|glob)/u.test(method) ||
      statSync(join(directory, path), { throwIfNoEntry: false })?.isDirectory();
    const migrationRoot = ["drizzle/", "src/db/migrations/"].find((prefix) =>
      path.startsWith(prefix),
    );
    inputs.add(migrationRoot ?? (folder && !path.endsWith("/") ? `${path}/` : path));
  });
  return [...inputs].sort();
}

export function generateRuntimeMap(directory = root) {
  const ts = createRequire(join(directory, "package.json"))("typescript");
  const files = readdirSync(join(directory, "src"), { recursive: true })
    .map((name) => `src/${name.split("\\").join("/")}`)
    .filter((name) => sourceFile.test(name));
  const known = new Set(files);
  const parents = new Map();
  const inputs = new Map();
  for (const file of files) {
    const source = readFileSync(join(directory, file), "utf8");
    if (testFile.test(file) || file.includes("/test-utils/")) {
      inputs.set(file, readRuntimeInputs(ts, file, source, directory));
    }
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const path = posix.join(posix.dirname(file), fileName);
      const stem = path.replace(/\.[cm]?js$/u, "");
      const dependency = [path, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find((id) =>
        known.has(id),
      );
      if (!dependency) continue;
      if (!parents.has(dependency)) parents.set(dependency, []);
      parents.get(dependency).push(file);
    }
  }
  const map = new Map();
  for (const [file, paths] of inputs) {
    if (!paths.length) continue;
    const readers = new Set([file]);
    for (const reader of readers) {
      if (!testFile.test(reader))
        for (const parent of parents.get(reader) ?? []) readers.add(parent);
    }
    for (const path of paths) {
      if (!map.has(path)) map.set(path, new Set());
      for (const reader of readers) if (testFile.test(reader)) map.get(path).add(reader);
    }
  }
  return Object.fromEntries(
    [...map.keys()].sort().map((path) => [path, [...map.get(path)].sort()]),
  );
}

if (isEntrypoint(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { root: { type: "string" } } });
    const directory = repositoryFor(import.meta.url, values.root);
    printRunContext(directory, "generate scripts/test-runtime-files.json");
    const output = join(directory, "scripts/test-runtime-files.json");
    writeFileSync(output, `${JSON.stringify(generateRuntimeMap(directory), null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
