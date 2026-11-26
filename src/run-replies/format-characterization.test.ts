import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "vitest";
import { formatRunReply, nestingTooDeep, type FinalReplyAnswer } from "./format.js";
import { random } from "./test-utils/nesting.js";

const syntax = [
  "",
  "a\u0000b\u200Ec\uD800d \u{1F642} \uFF20bob",
  "line\r\nline\rline\n",
  "([x]) [^a] *x* _x_ |",
  "| column |\n| --- |\n| row |",
  "```ts @bob\nconst x = `value`;\n````",
  "```bad`\n~~~js\n```\n~~~",
  "- list\n      child\n\nplain\n    indent",
  "1) list\n\t> quote\n- next",
  '[label][private] and [private]\n\n[private]: https://example.com "@title"',
  "[^private]\n\n[^private]: @body",
  "[**safe** *label*](https://linear.app/a/users/b)",
  "[[nested](https://example.com)](https://linear.app/a/agents/b)",
  "[label](https://example.com/private-fragment)",
  "~~![x](https://example.com/i.png)~~ **<b></b>**",
  "See https://linear.app/a/profiles/bob www.example.com[^x] now",
  "`&amp;#64;bob` &lt;user id=bob&gt; @user private-fragment",
];

function* answers(): Generator<FinalReplyAnswer> {
  const next = random(39_154);
  for (const text of syntax) yield { text, truncated: false };
  for (let index = 0; index < 192; index += 1) {
    const text = Array.from(
      { length: 1 + Math.floor(next() * 12) },
      () => syntax[Math.floor(next() * syntax.length)] ?? "",
    ).join(next() < 0.5 ? "\n" : " ");
    yield { text, truncated: next() < 0.25 };
  }
  for (const length of [3_499, 3_500, 3_501, 16_384, 1_048_576]) {
    yield {
      text: "plain words ".repeat(Math.ceil(length / 12)).slice(0, length),
      truncated: false,
    };
    yield { text: "[^x]".repeat(Math.ceil(length / 4)).slice(0, length), truncated: true };
  }
  yield { text: `${"x ".repeat(1_715)}\u{1F642} ${"next ".repeat(30)}`, truncated: false };
  yield { text: `${"x ".repeat(1_716)}\`unfinished ${"next ".repeat(30)}`, truncated: false };
  yield { text: `${"x ".repeat(1_699)}\n${"next ".repeat(30)}`, truncated: false };
}

function render(answer: FinalReplyAnswer, expireAt?: number) {
  let reads = 0;
  const reasons: string[] = [];
  const text = formatRunReply(answer, ["private-fragment"], {
    now: () => (++reads >= (expireAt ?? Infinity) ? 10_000 : 0),
    onFallback: (reason) => reasons.push(reason),
  });
  return { text, reasons, reads };
}

it("preserves exact rendering and fallback behavior across seeded reply shapes", () => {
  const digest = createHash("sha256");
  for (const answer of answers()) {
    const depth = nestingTooDeep(answer.text);
    for (const expireAt of [undefined, 2, 3, 4, 5]) {
      digest.update(JSON.stringify([depth, render(answer, expireAt)]) + "\n");
    }
  }
  assert.equal(
    digest.digest("hex"),
    "a7ea9dbf47423b500bc6d7a3c4f3c7f54338e82f59153ea45b29588fba854f9e",
  );
});
