import { readFileSync } from "node:fs";
import { diffPaths, git, releaseTag, shaPattern } from "./git.mjs";

const quotedIdentifier = String.raw`"(?:[^"]|"")*"`;
const identifier = String.raw`(?:${quotedIdentifier}|[\w$]+)`;
const tableName = String.raw`(?:${identifier}\s*\.\s*)?${identifier}`;
const unsafe = [
  /^\s*do\b/iu,
  /\b(?:truncate|drop|rename)\s+/iu,
  /\balter\s+(?:column\s+)?(?:"(?:[^"]|"")+"|[\w$]+)\s+(?:set\s+data\s+)?type\b/iu,
  /\bset\s+not\s+null\b/iu,
  /\balter\s+type\b[^;]*\badd\s+value\b/iu,
  /\b(?:insert\s+into|delete\s+from)\s+/iu,
  new RegExp(
    String.raw`\bupdate\s+(?:only\s+)?${tableName}(?:\s+(?:as\s+)?${identifier})?\s+set\b`,
    "iu",
  ),
];

const createTable = new RegExp(String.raw`^\s*create\s+table\s+(${tableName})\s*\(`, "iu");
const alterTable = new RegExp(String.raw`^\s*alter\s+table\s+(?:only\s+)?(${tableName})\s+`, "iu");
const addedConstraint = new RegExp(
  String.raw`\badd\s+(?:constraint\s+${identifier}\s+)?(?:unique|foreign\s+key|check)\b`,
  "iu",
);
const uniqueIndex = new RegExp(
  String.raw`^\s*create\s+unique\s+index\b[^;]*?\bon\s+(?:only\s+)?(${tableName})`,
  "iu",
);

const sqlTokens =
  /"(?:[^"]|"")*"|(?<![\w$])[eE]'|'(?:[^'\\]|'')*\\|'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|(?<![\w$])(\$(?:[a-zA-Z_]\w*)?\$)[\s\S]*?\1|;/gu;

function ambiguousString(token) {
  return /^[eE]'/u.test(token) || (token.startsWith("'") && token.endsWith("\\"));
}

function canonicalTable(name) {
  const parts = name.match(new RegExp(identifier, "gu"));
  return JSON.stringify(
    parts.map((part) =>
      part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.toLowerCase(),
    ),
  );
}

function isUnsafe(statement, newTables, existingTables) {
  if (unsafe.some((pattern) => pattern.test(statement))) return true;
  const created = createTable.exec(statement);
  if (created) {
    const table = canonicalTable(created[1]);
    if (!existingTables.has(table)) newTables.add(table);
  }

  const added = statement
    .split(/,\s*(?=(?:add|alter|drop|rename)\b)/iu)
    .filter((clause) =>
      /\badd\s+(?!constraint\b|unique\b|check\b|foreign\b|primary\b)/iu.test(clause),
    );
  if (added.some((column) => /\bnot\s+null\b/iu.test(column) && !/\bdefault\b/iu.test(column))) {
    return true;
  }
  const index = uniqueIndex.exec(statement);
  if (index) return !newTables.has(canonicalTable(index[1]));
  const alter = alterTable.exec(statement);
  return Boolean(
    alter &&
    addedConstraint.test(statement.slice(alter[0].length)) &&
    !newTables.has(canonicalTable(alter[1])),
  );
}

function statements(sql) {
  const result = [];
  let statement = "";
  let offset = 0;
  for (const match of sql.matchAll(sqlTokens)) {
    const token = match[0];
    if (ambiguousString(token)) return null;
    statement += sql.slice(offset, match.index);
    offset = match.index + token.length;
    if (token === ";") {
      result.push(statement);
      statement = "";
    } else {
      statement += token.startsWith('"') ? token : " ";
    }
  }
  result.push(statement + sql.slice(offset));
  return result;
}

export function needsRollbackReview(sql, newTables = new Set(), existingTables = new Set()) {
  const parsed = statements(sql);
  return !parsed || parsed.some((statement) => isUnsafe(statement, newTables, existingTables));
}

function migrationPaths(base, filter) {
  const paths = base ? diffPaths(base, filter) : git("ls-files", "-z", "--", "drizzle").split("\0");
  return paths.filter((path) => /^drizzle\/[^/]+\.sql$/u.test(path)).sort();
}

function previouslyCreated(base) {
  if (!base) return new Set();
  const found = new Set();
  for (const file of migrationPaths(base, "M")) {
    const parsed = statements(git("show", `${base}:${file}`));
    if (!parsed) return null;
    for (const sql of parsed) {
      const created = createTable.exec(sql);
      if (created) found.add(canonicalTable(created[1]));
    }
  }
  return found;
}

if (import.meta.main && process.env.ROLLBACK_UNSAFE !== "true") {
  const release = process.argv[2] === "--release";
  const base = process.env.BASE_SHA ?? "";
  if (!shaPattern.test(base) && !(release && (!base || releaseTag.test(base)))) {
    throw new Error("Invalid migration comparison base");
  }
  const newTables = new Set();
  const existingTables = previouslyCreated(base);
  for (const file of migrationPaths(base, "AM")) {
    const sql = readFileSync(file, "utf8");
    if (existingTables && !needsRollbackReview(sql, newTables, existingTables)) continue;
    if (release) {
      console.log("true");
      process.exit(0);
    }
    console.error(`${JSON.stringify(file)} needs rollback review and the rollback-unsafe label`);
    process.exitCode = 1;
  }
  if (release) console.log("false");
}
