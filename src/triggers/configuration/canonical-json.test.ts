import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { isBoundedJson } from "./canonical-json.js";

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < depth; level++) value = [value];
  return value;
}

describe("isBoundedJson", () => {
  it("accepts ordinary values and nesting up to the depth limit", () => {
    expect(isBoundedJson({ a: [1, { b: "c" }], d: null })).toBe(true);
    expect(isBoundedJson(nested(60))).toBe(true);
  });

  it("rejects nesting past the depth limit without overflowing the stack", () => {
    expect(isBoundedJson(nested(65))).toBe(false);
    expect(isBoundedJson(nested(50_000))).toBe(false);
  });

  it("rejects a long chain of YAML aliases as a value, not an error", () => {
    const lines = ["a0: &a0 [1]"];
    for (let index = 1; index < 3000; index++) {
      lines.push(`a${String(index)}: &a${String(index)} [*a${String(index - 1)}]`);
    }
    const parsed: unknown = parseDocument(lines.join("\n")).toJS({
      maxAliasCount: -1,
    });
    expect(() => isBoundedJson(parsed)).not.toThrow();
    expect(isBoundedJson(parsed)).toBe(false);
  });

  it("rejects a value that contains itself and an alias bomb", () => {
    const loop: unknown[] = [];
    loop.push(loop);
    expect(isBoundedJson(loop)).toBe(false);
    const wide = (n: number): unknown => (n === 0 ? [] : [wide(n - 1), wide(n - 1)]);
    expect(isBoundedJson(wide(14))).toBe(false);
  });
});
