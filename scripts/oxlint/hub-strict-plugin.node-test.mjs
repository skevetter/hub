import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const oxlint = path.resolve(here, "..", "..", "node_modules", ".bin", "oxlint");
const dir = mkdtempSync(path.join(tmpdir(), "hub-strict-plugin-"));
after(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  path.join(dir, "oxlint.json"),
  JSON.stringify({
    jsPlugins: [path.join(here, "hub-strict-plugin.mjs")],
    rules: { "hub-strict/max-return-values": ["error", { max: 3 }] },
  }),
);

function lint(source) {
  const file = path.join(dir, "fixture.ts");
  writeFileSync(file, source);
  const result = spawnSync(oxlint, ["-c", "oxlint.json", "-f", "unix", "fixture.ts"], {
    cwd: dir,
    encoding: "utf8",
  });
  return result.stdout.split("\n").filter((line) => line.includes("max-return-values"));
}

test("flags a tuple return type over the limit", () => {
  assert.equal(
    lint("export function f(): [number, number, number, number] { return [1, 2, 3, 4]; }").length,
    1,
  );
});

test("flags a promised tuple over the limit", () => {
  const source =
    "export async function f(): Promise<[string, string, string, string]> { return ['a', 'b', 'c', 'd']; }";
  assert.equal(lint(source).length, 1);
});

test("flags function type signatures over the limit", () => {
  assert.equal(lint("export type F = () => [number, number, number, number];").length, 1);
});

test("flags positional const arrays over the limit", () => {
  assert.equal(lint("export const f = (a: number) => [a, a, a, a] as const;").length, 1);
  assert.equal(lint("export function f(a: number) { return [a, a, a, a] as const; }").length, 1);
});

test("flags readonly tuples over the limit", () => {
  assert.equal(
    lint("export function f(): readonly [1, 2, 3, 4] { return [1, 2, 3, 4]; }").length,
    1,
  );
  const source =
    "export async function f(): Promise<readonly [1, 2, 3, 4]> { return [1, 2, 3, 4]; }";
  assert.equal(lint(source).length, 1);
});

test("allows three values", () => {
  assert.deepEqual(lint("export function f(): [number, number, number] { return [1, 2, 3]; }"), []);
});

test("allows tagged query keys and plain arrays", () => {
  assert.deepEqual(
    lint("export const key = (id: string) => ['runs', id, 'page', { id }] as const;"),
    [],
  );
  assert.deepEqual(lint("export function f(): number[] { return [1, 2, 3, 4]; }"), []);
});
