import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { it } from "vitest";
import { formatRunReply } from "./format.js";
import { realisticAnswers } from "./test-utils/answers.js";

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

it.each(["> ", "- ", "1. "])("renders deeply nested %s containers within the limits", (marker) => {
  const body = formatRunReply({ text: `${marker.repeat(2_000)}Answer @bob`, truncated: false }, []);
  assert.ok(body.length <= 3_500);
  assert.ok(body.length > 0);
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

function mentionLinks(markdown: string): string[] {
  const found: string[] = [];
  const pending: Array<Root | RootContent> = [
    fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
  ];
  for (const node of pending) {
    if (node.type === "link" || node.type === "definition") {
      const url = URL.parse(node.url);
      const host = url?.hostname.replace(/\.$/u, "") ?? "";
      const path = decodeURIComponent(url?.pathname ?? "").normalize("NFKC");
      const linear = host === "linear.app" || host.endsWith(".linear.app");
      if (
        (linear && /\/(?:profiles|users|agents)(?:\/|$)/iu.test(path)) ||
        /[@\uFF20]/u.test(node.url)
      )
        found.push(node.url);
    }
    if ("children" in node) pending.push(...node.children);
  }
  return found;
}

// Reads 0, then past the budget: the reply takes the plain-text path.
function plainClock() {
  let reads = 0;
  return () => (++reads > 1 ? 10_000 : 0);
}

it.each(["www.linear%2Eapp", "www.\uFF4C\uFF49\uFF4E\uFF45\uFF41\uFF52\uFF0E\uFF41\uFF50\uFF50"])(
  "plain text does not expose a profile link behind a word-adjacent scheme (%s)",
  (host) => {
    const text = `Seehttps://example.com/?u=${host}/acme/profiles/bob now.`;
    for (const clock of [{ now: plainClock() }, {}]) {
      const body = formatRunReply({ text, truncated: false }, [], clock);
      assert.deepEqual(mentionLinks(body), []);
      assert.match(body, /now/u);
    }
  },
);

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it("leaves no autolink to a profile or mention across 3,600 generated documents", () => {
  const hosts = [
    "linear.app",
    "www.linear.app",
    "www.linear%2Eapp",
    "www.linear.app.",
    "www.\uFF4C\uFF49\uFF4E\uFF45\uFF41\uFF52\uFF0E\uFF41\uFF50\uFF50",
    "www.linear&#46;app",
    "WWW.LINEAR.APP",
    "www.xn--linear-app",
  ];
  const paths = ["/acme/profiles/bob", "/a/users/b", "/a/agents/c", "/acme/%70rofiles/bob"];
  const lead = ["", "See", "x", "(", "<", "[a](", "[t]: ", "u=", "&amp;", "\\", " "];
  const wrap = [
    (u: string) => u,
    (u: string) => `https://example.com/?u=${u}`,
    (u: string) => `<${u}>`,
    (u: string) => `[x](${u})`,
    (u: string) => `[x]: ${u}`,
    (u: string) => `\`${u}\``,
    (u: string) => `*${u}*`,
    (u: string) => `| ${u} |`,
    (u: string) => `ops@${u}`,
  ];
  for (const seed of [4101, 4202, 4303]) {
    const next = random(seed);
    const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
    for (let index = 0; index < 1_200; index += 1) {
      const url = `${pick(["https://", "http://", "", "www."])}${pick(hosts)}${pick(paths)}`;
      const text = `${pick(lead)}${pick(wrap)(url)} ${pick(wrap)(url)}${"`x` ".repeat(Math.floor(next() * 120))}\n\nend`;
      for (const clock of [{ now: plainClock() }, {}]) {
        const body = formatRunReply({ text, truncated: next() < 0.2 }, [], clock);
        assert.deepEqual(mentionLinks(body), [], JSON.stringify({ seed, index, text, body }));
      }
    }
  }
});

function contentOf(markdown: string): string {
  const parts: string[] = [];
  const walk = (node: Root | RootContent) => {
    if (node.type === "text" || node.type === "inlineCode" || node.type === "code")
      parts.push(node.value);
    if ("children" in node) for (const child of node.children) walk(child);
    if (node.type !== "text" && node.type !== "inlineCode") parts.push("\n");
  };
  walk(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return parts.join(" ").replace(/\s+/gu, " ").trim();
}

it("keeps Markdown and every non-mention word of 80 realistic answers", () => {
  const answers = realisticAnswers(80);
  assert.equal(answers.length, 80);
  for (const [index, text] of answers.entries()) {
    const reasons: string[] = [];
    const body = formatRunReply({ text, truncated: false }, [], {
      onFallback: (reason) => reasons.push(reason),
    });
    assert.deepEqual(reasons, [], `answer ${index} (${text.length} chars) took the fallback`);
    assert.equal(
      contentOf(body),
      contentOf(text).replaceAll("@", "[at]"),
      `answer ${index} lost content`,
    );
  }
});

it("keeps an ordinary 2,136-character answer as Markdown", () => {
  const unit =
    "### `src/retry.ts`\n\n```ts\nexport async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n" +
    "  for (let i = 0; i < attempts; i++) {\n    try {\n      return await fn();\n    } catch (error) {\n" +
    '      if (i === attempts - 1) throw error;\n    }\n  }\n  throw new Error("unreachable");\n}\n```\n\n' +
    "- Wraps `fn` and retries **3** times.\n- Rethrows the last `error`.\n- See [retry docs](https://example.com/retry).\n\n";
  const text = `I added a retry helper and used it in the reply writer.\n\n${unit.repeat(5)}`;
  const body = formatRunReply({ text, truncated: false }, []);
  assert.ok(body.includes("```ts"));
  assert.ok(body.includes("retry<T>(fn: () => Promise<T>"));
  assert.ok(body.includes("\n    try {"));
});

it("keeps fences, generics, indentation and list markers when it falls back", () => {
  const text = [
    "Result for @bob:",
    "",
    "```ts @team",
    "export function pick<T>(items: T[], at = 0): T {",
    "  return items[at]; // ping @bob",
    "}",
    "```",
    "",
    "- first *item*",
    "  - nested [link](https://example.com)",
    "2. second",
    "",
    "Plain line with <T> and a_b.",
  ].join("\n");
  const reasons: string[] = [];
  const body = formatRunReply({ text, truncated: false }, [], {
    now: plainClock(),
    onFallback: (reason) => reasons.push(reason),
  });
  assert.deepEqual(reasons, ["budget"]);
  assert.ok(
    body.includes("```ts\nexport function pick<T>(items: T[], at = 0): T {\n  return items["),
  );
  assert.ok(body.includes("\n```\n"));
  assert.doesNotMatch(body, /@/u);
  assert.ok(body.includes("\n- first \\*item\\*\n  - nested \\[link\\]"));
  assert.ok(body.includes("\n2. second"));
  assert.ok(body.includes("Plain line with \\<T\\> and a\\_b\\."));
  assert.match(body, /^Result for \\\[at\\\]bob\\:/u);
});

it.each([
  ["a run of openers", "[".repeat(300)],
  ["unmatched parentheses", "[a](".repeat(700)],
  ["unmatched emphasis", "*a_".repeat(600)],
  ["footnote labels", "[^a]".repeat(150)],
  ["table cells", `a|b\n-|-\n${"|".repeat(700)}`],
])("takes the fallback for %s", (_name, text) => {
  const reasons: string[] = [];
  formatRunReply({ text, truncated: false }, [], { onFallback: (reason) => reasons.push(reason) });
  assert.deepEqual(reasons, ["structure"]);
});

it("keeps an entity inside fallback code from decoding into a mention", () => {
  const text = "```\nping &amp;#64;bob and pro&#102;iles\n```";
  const body = formatRunReply({ text, truncated: false }, [], { now: plainClock() });
  assert.ok(body.startsWith("```\nping "));
  assert.doesNotMatch(body, /@/u);
});

// Container markers with no space between them escape a space-only chain check.
const chains = ["- >", ">- ", "+ >", ">", "> -", "1.>", "-\t>"];

it.each(chains)("degrades a 400-deep %j chain instead of throwing", (unit) => {
  const text = `Summary of the fix.\n\n${unit.repeat(400)} q`;
  const body = formatRunReply({ text, truncated: false }, []);
  assert.match(body, /Summary of the fix/u);
});

it.each(chains)("renders a stacked %j chain in under 100 ms warm", (unit) => {
  const text = unit.repeat(16_384).slice(0, 16_384);
  formatRunReply({ text, truncated: false }, []);
  const started = performance.now();
  formatRunReply({ text, truncated: false }, []);
  assert.ok(performance.now() - started < 100);
});

it("falls back to plain text when the Markdown step throws", () => {
  const reasons: string[] = [];
  const body = formatRunReply({ text: "- > ".repeat(60), truncated: false }, [], {
    now: () => 0,
    onFallback: (reason) => reasons.push(reason),
  });
  assert.deepEqual(reasons, ["structure"]);
  assert.ok(body.length > 0);
});

it("always renders 2,000 generated stacked-container documents safely and fast", () => {
  const next = random(7_001);
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
  const markers = [
    ">",
    "> ",
    "- ",
    "+ ",
    "* ",
    "1. ",
    "2) ",
    "\t",
    " ",
    "  ",
    ">>",
    "-",
    "- >",
    ">- ",
  ];
  const tails = [
    "q",
    "@bob",
    "see https://linear.app/acme/profiles/bob",
    "| a | b |\n> | - | - |\n> | @x | www.linear%2Eapp/a/users/b |",
    "`code <T>`",
    "[x](https://linear.app/a/agents/c)",
  ];
  for (let index = 0; index < 2_000; index += 1) {
    const lines: string[] = [];
    const lineCount = 1 + Math.floor(next() * 6);
    for (let line = 0; line < lineCount; line += 1) {
      const unit = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(markers)).join("");
      lines.push(unit.repeat(1 + Math.floor(next() * 700)) + pick(tails));
    }
    const text = `Fixed it.\n\n${lines.join("\n")}`;
    const started = performance.now();
    const body = formatRunReply({ text, truncated: next() < 0.2 }, []);
    const elapsed = performance.now() - started;
    const context = JSON.stringify({ index, text: text.slice(0, 200) });
    assert.ok(elapsed < 100 || index < 20, `${elapsed.toFixed(0)} ms ${context}`);
    assert.ok(body.length > 0 && body.length <= 3_500, context);
    assert.deepEqual(mentionLinks(body), [], context);
    assert.doesNotMatch(body, /[@\uFF20]/u, context);
  }
});
