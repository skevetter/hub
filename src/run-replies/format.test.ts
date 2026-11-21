import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { it } from "vitest";
import { formatRunReply } from "./format.js";

const hazards = ["[a](", "[^a]", "*a_"];

it.each(hazards)("bounds Markdown work for repeated %s", (shape) => {
  for (const [index, length] of [16_384, 16_384, 1_048_576].entries()) {
    const prefix = "Answer @bob https://linear.app/acme/profiles/bob\n\n";
    const text = (prefix + shape.repeat(Math.ceil(length / shape.length))).slice(0, length);
    const started = performance.now();
    const body = formatRunReply({ text, truncated: false }, []);
    const elapsed = performance.now() - started;
    const limit = index === 0 ? 250 : 100;
    assert.ok(
      elapsed < limit,
      `${length} characters took ${elapsed.toFixed(1)} ms (limit ${limit})`,
    );
    assert.ok(body.length <= 3_500);
    assert.match(body, /^Answer /u);
    assert.match(body, /\\[[*]/u);
    assert.match(body, /\n\n\[Reply truncated\]$/u);
    assert.doesNotMatch(body, /[@\uFF20]|linear\.app\/acme\/profiles\/bob/iu);
  }
});

it.each([
  ["> ", "\\> "],
  ["- ", "\\- "],
  ["1. ", "1\\. "],
])("renders deeply nested %s containers as escaped plain text", (marker, escaped) => {
  const body = formatRunReply({ text: `${marker.repeat(2_000)}Answer @bob`, truncated: false }, []);
  assert.ok(body.startsWith(escaped.repeat(2)));
  assert.ok(body.length <= 3_500);
  assert.doesNotMatch(body, /[@\uFF20]/u);
});

const table = `| File | Change |\n| --- | --- |\n${"| src/a.ts | Added guard |\n".repeat(120)}`;

it("renders Markdown whenever the clock stays inside the budget", () => {
  const reasons: string[] = [];
  const body = formatRunReply({ text: table, truncated: false }, [], {
    now: () => 0,
    onFallback: (reason) => reasons.push(reason),
  });
  assert.match(body, /^\| File \| Change \|/u);
  assert.deepEqual(reasons, []);
});

it.each([2, 3, 4, 5])(
  "falls back and reports it when the clock passes the budget at read %i",
  (read) => {
    let reads = 0;
    const reasons: string[] = [];
    const body = formatRunReply({ text: `${table}\nAnswer @bob`, truncated: false }, [], {
      now: () => (++reads >= read ? 10_000 : 0),
      onFallback: (reason) => reasons.push(reason),
    });
    assert.deepEqual(reasons, ["budget"]);
    assert.doesNotMatch(body, /@/u);
    assert.match(body, /\\\|/u);
  },
);

it.each([
  ["pipe table", (n: number) => "|".repeat(n)],
  ["pipe rows", (n: number) => "|a|b|\n".repeat(Math.ceil(n / 6))],
  ["setext flood", (n: number) => "a\n---\n".repeat(Math.ceil(n / 6))],
])("stays under 100 ms warm for a %s", (_name, build) => {
  for (const length of [16_384, 1_048_576]) {
    const text = build(length).slice(0, length);
    formatRunReply({ text, truncated: false }, []);
    const started = performance.now();
    formatRunReply({ text, truncated: false }, []);
    assert.ok(performance.now() - started < 100);
  }
});
