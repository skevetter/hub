import { readFileSync } from "node:fs";
import { diffPaths, shaPattern } from "./git.mjs";

const unsafe = [
  /\b(?:drop|rename)\s+\b/iu,
  /\balter\b[^;]*\b(?:type|set\s+not\s+null)\s*\b/iu,
  /\b(?:update\s+(?!cascade\b|restrict\b|no\s+action\b|set\s+null\b|set\s+default\b)|delete\s+from\s+)[^;]+/iu,
];

export function needsRollbackReview(sql) {
  const statements = sql.replaceAll(/--[^\n]*|\/\*[\s\S]*?\*\//gu, " ");
  return unsafe.some((pattern) => pattern.test(statements));
}

if (import.meta.main && process.env.ROLLBACK_UNSAFE !== "true") {
  const base = process.env.BASE_SHA ?? "";
  if (!shaPattern.test(base)) throw new Error("Missing migration comparison base");
  const changed = diffPaths(base, "AM").filter((path) => /^drizzle\/[^/]+\.sql$/u.test(path));
  for (const file of changed) {
    const sql = readFileSync(file, "utf8");
    if (!needsRollbackReview(sql)) continue;
    console.error(`${JSON.stringify(file)} needs rollback review and the rollback-unsafe label`);
    process.exitCode = 1;
  }
}
