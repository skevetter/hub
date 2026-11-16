import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { hasPostgresText, isPostgresJson } from "./json-storage.js";

describe("PostgreSQL JSON text compatibility", () => {
  it("accepts scalar Unicode, including paired astral characters", () => {
    for (const value of [
      "",
      "plain text",
      "\u0001\t\n\r",
      "\u00e9\ud7ff\ue000\ufffd\uffff",
      "\ud800\udc00",
      "\udbff\udfff",
      "before\ud83d\ude00after",
      "\ud83d\ude00\ud83d\ude80",
    ]) {
      assert.equal(hasPostgresText(value), true);
      assert.equal(isPostgresJson(value), true);
      assert.equal(isPostgresJson({ [value]: [{ value }] }), true);
    }
  });

  it("rejects NUL and each unpaired surrogate in values and object keys at any nesting", () => {
    for (const value of [
      "\u0000",
      "before\u0000after",
      "\ud800",
      "\udbff",
      "\udc00",
      "\udfff",
      "\ud800x",
      "x\udc00",
      "\ud800\ud800",
      "\udc00\ud800",
      "\ud83d\ude00\ud800",
      "\udc00\ud83d\ude00",
    ]) {
      assert.equal(hasPostgresText(value), false);
      assert.equal(isPostgresJson(value), false);
      assert.equal(isPostgresJson({ value }), false);
      assert.equal(isPostgresJson({ nested: [null, { value }] }), false);
      assert.equal(isPostgresJson({ [value]: true }), false);
      assert.equal(isPostgresJson({ nested: [{ [value]: true }] }), false);
    }
  });

  it("requires JSON scalars and finite numbers", () => {
    for (const value of [null, true, false, 0, -1.25, Number.MAX_VALUE]) {
      assert.equal(isPostgresJson(value), true);
    }
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol("value"), () => null]) {
      assert.equal(isPostgresJson(value), false);
      assert.equal(isPostgresJson({ nested: [value] }), false);
    }
  });

  it("preserves optional container depth and per-object key boundaries", () => {
    const limits = { maxDepth: 20, maxKeysPerObject: 1000 };
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 20; depth += 1) nested = { nested };
    assert.equal(isPostgresJson(nested, limits), true);
    assert.equal(isPostgresJson({ nested }, limits), false);
    assert.equal(isPostgresJson({ nested }), true);
    assert.equal(isPostgresJson({ nested: [[true]] }, { maxDepth: 2 }), false);
    const object = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`k${index}`, 1]));
    assert.equal(isPostgresJson(object, limits), true);
    assert.equal(isPostgresJson({ ...object, extra: 1 }, limits), false);
    assert.equal(isPostgresJson({ nested: [{ ...object, extra: 1 }] }, limits), false);
    assert.equal(isPostgresJson({ ...object, extra: 1 }), true);
  });
});
