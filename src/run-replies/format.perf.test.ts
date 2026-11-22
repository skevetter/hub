// Wall-clock checks for adversarial shapes. Run with HUB_REPLY_PERF=1 on a quiet machine:
//   HUB_REPLY_PERF=1 npx vitest run src/run-replies/format.perf.test.ts
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "vitest";
import { formatRunReply } from "./format.js";

const shapes: Array<[string, (size: number) => string]> = [
  ["repeated [a](", (n) => "[a](".repeat(Math.ceil(n / 4))],
  ["repeated [^a]", (n) => "[^a]".repeat(Math.ceil(n / 4))],
  ["repeated *a_", (n) => "*a_".repeat(Math.ceil(n / 3))],
  ["pipe table", (n) => "|".repeat(n)],
  ["pipe rows", (n) => "|a|b|\n".repeat(Math.ceil(n / 6))],
  ["setext flood", (n) => "a\n---\n".repeat(Math.ceil(n / 6))],
  ["- > chain", (n) => "- >".repeat(Math.ceil(n / 3))],
  [">- chain", (n) => ">- ".repeat(Math.ceil(n / 3))],
  ["> chain", (n) => ">".repeat(n)],
];

describe.skipIf(process.env["HUB_REPLY_PERF"] !== "1")("reply formatting time", () => {
  it.each(shapes)("stays under 100 ms warm for %s", (_name, build) => {
    for (const size of [16_384, 1_048_576]) {
      const text = build(size).slice(0, size);
      formatRunReply({ text, truncated: false }, []);
      const started = performance.now();
      formatRunReply({ text, truncated: false }, []);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 100, `${size} characters took ${elapsed.toFixed(1)} ms`);
    }
  });
});
