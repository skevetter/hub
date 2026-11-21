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

it("renders deeply nested blockquotes as escaped plain text", () => {
  const body = formatRunReply({ text: `${"> ".repeat(2_000)}Answer @bob`, truncated: false }, []);
  assert.match(body, /^\\> \\>/u);
  assert.ok(body.length <= 3_500);
  assert.doesNotMatch(body, /[@\uFF20]/u);
});
