import assert from "node:assert/strict";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, it } from "vitest";
import { formatRunReply, nestingTooDeep } from "./format.js";
import { realisticAnswers } from "./test-utils/answers.js";
import {
  checkFenceTrickDocuments,
  checkNestedDocuments,
  checkStackedDocuments,
  mentionLinks,
  random,
} from "./test-utils/nesting.js";

const hazards = ["[a](", "[^a]", "*a_"];

it.each(hazards)("bounds Markdown work for repeated %s", (shape) => {
  for (const length of [16_384, 1_048_576]) {
    const prefix = "Answer @bob https://linear.app/acme/profiles/bob\n\n";
    const text = (prefix + shape.repeat(Math.ceil(length / shape.length))).slice(0, length);
    const body = formatRunReply({ text, truncated: false }, []);
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
])("renders a %s within the limits", (_name, build) => {
  for (const length of [16_384, 1_048_576]) {
    const body = formatRunReply({ text: build(length).slice(0, length), truncated: false }, []);
    assert.ok(body.length > 0 && body.length <= 3_500);
  }
});

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

// 3,600 documents with HUB_REPLY_FUZZ=1; the default run keeps it short so a loaded host finishes.
it("leaves no autolink to a profile or mention across generated documents", () => {
  const perSeed = process.env["HUB_REPLY_FUZZ"] === "1" ? 1_200 : 200;
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
    for (let index = 0; index < perSeed; index += 1) {
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
  return parts.join("").replace(/\s+/gu, "");
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

it.each(chains)("renders a stacked %j chain within the limits", (unit) => {
  const body = formatRunReply({ text: unit.repeat(16_384).slice(0, 16_384), truncated: false }, []);
  assert.ok(body.length > 0 && body.length <= 3_500);
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

it("renders generated stacked-container documents safely", () => {
  checkStackedDocuments({ seed: 7_001, count: 400 });
});

it("renders generated cross-line nesting the same way on every call", () => {
  checkNestedDocuments({ seed: 8_001, count: 400 });
});

it.each([
  "see https://e.com[^x] now",
  "see www.example.com[^y] now",
  "[a](https://e.com[^team-x) now",
])("posts plain text when GFM builds an unparseable autolink from %j", (text) => {
  const body = formatRunReply({ text, truncated: false }, [], { now: plainClock() });
  assert.match(body, /now/u);
  assert.deepEqual(mentionLinks(body), []);
});

describe("long URLs keep their visible text", () => {
  const post = (text: string) => formatRunReply({ text, truncated: false }, []);

  it("keeps the label of a Linear issue link", () => {
    const out = post(
      "Tracked in [the Linear issue](https://linear.app/acme/issue/ENG-1423/fix-login-redirect-loop).",
    );
    assert.match(out, /Tracked in the Linear issue\./u);
  });

  it("keeps the label of a GitHub Actions run link", () => {
    const out = post(
      "CI: [run 412](https://github.com/getpaseo/hub/actions/runs/19283746501/job/54839201) failed.",
    );
    assert.match(out, /CI: run 412 failed\./u);
  });

  it("keeps a readable form of a bare long Linear issue URL", () => {
    const out = post("Bare https://linear.app/acme/issue/ENG-1423/fix-login-redirect-loop here");
    assert.match(out, /^Bare .*linear.* here$/u);
    assert.doesNotMatch(out, /^Bare \\?\] here$/u);
  });

  it("keeps the label of 40 generated long-path links", () => {
    for (let index = 1; index <= 40; index += 1) {
      const label = `issue ${index} on Linear`;
      const text = `Fixed in [${label}](https://linear.app/acme/issue/ENG-${index}/fix-login-redirect-loop?comment=xyz) and tested.`;
      assert.match(post(text), new RegExp(`Fixed in ${label} and tested\\.`, "u"), text);
    }
  });
});

// Each line indents into the deepest item of the line above and opens 32 more items, so no line
// has more than 32 markers while the nesting reaches hundreds of levels.
function indentedChain(unit: string, columns: number): string {
  let text = "";
  let column = 0;
  for (;;) {
    const line = `${unit.repeat(column / columns)}${"- ".repeat(32)}x\n`;
    if (text.length + line.length > 3_300) return text;
    text += line;
    column += 64;
  }
}

it.each([
  ["tabs", "\t", 4],
  ["spaces", "  ", 2],
])("sends nesting carried across lines by %s to plain text every time", (_name, unit, columns) => {
  const text = indentedChain(unit, columns);
  const outcomes = new Set<string>();
  for (let call = 0; call < 5; call += 1) {
    const reasons: string[] = [];
    formatRunReply({ text, truncated: false }, [], {
      onFallback: (reason) => reasons.push(reason),
    });
    outcomes.add(reasons.join());
  }
  assert.deepEqual([...outcomes], ["structure"]);
});

it("keeps a realistic nested list as Markdown", () => {
  const text = [
    "- one",
    "  - two",
    "    - three",
    "      - four",
    "        1. five",
    "           - six",
    "```ts",
    "                        deeply.indented(code);",
    "```",
  ].join("\n");
  const reasons: string[] = [];
  formatRunReply({ text, truncated: false }, [], { onFallback: (reason) => reasons.push(reason) });
  assert.deepEqual(reasons, []);
});

it.each([
  "~~![x](https://e.com/i.png)~~",
  "**<b></b>**",
  "~~&lt;user id=bob&gt;~~",
  "**&lt;user id=bob&gt;**",
  "*<img src=x>*",
  "[![x](https://e.com/i.png)](https://e.com)",
])("does not leave an empty marker run behind after removing the content of %j", (inline) => {
  const body = formatRunReply(
    { text: `before ${inline}\n\n${inline}\n\nafter`, truncated: false },
    [],
  );
  assert.doesNotMatch(body, /^[~*_`]{3,}$/mu);
  assert.match(body, /after$/u);
  const tree = fromMarkdown(`${body}\n\nPaseo reply marker`, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  assert.equal(tree.children.at(-1)?.type, "paragraph");
});

describe("nesting the estimate must see", () => {
  const fakeFence = `\`\`\`x\`\n${"- >".repeat(1_130)}\n`;
  const quoteTabs = ((): string => {
    let text = "";
    for (let line = 0; ; line += 1) {
      const next = `>\t${"\t".repeat(Math.floor((46 * line) / 4))}${"- ".repeat(23)}x\n`;
      if (text.length + next.length > 3_400) return text;
      text += next;
    }
  })();

  it.each([
    ["a backtick opener with a backtick in its info string", fakeFence],
    ["a quote prefix before the indentation", quoteTabs],
    [
      "a chain after a tilde fence that backticks did not close and tildes did",
      `~~~
\`\`\`
~~~
${"- >".repeat(1_130)}
`,
    ],
    ["markers after tabs after markers", `${"-\t>\t".repeat(600)}x`],
  ])("sends %s to plain text before parsing", (_name, text) => {
    assert.equal(nestingTooDeep(text), true);
  });

  it.each([
    ["a real backtick fence", "```ts\n    - > - > - > - >\n```\n- one\n  - two"],
    ["a real tilde fence", "~~~\n    - > - > - > - >\n~~~\n- one"],
    ["an indented real fence", "   ```\n\t\t\t\t\t\t\t\t- >\n   ```"],
    ["a longer closing fence", "```\n\t\t\t\t- >\n`````\ntext"],
  ])("still skips lines inside %s", (_name, text) => {
    assert.equal(nestingTooDeep(text), false);
  });

  it("sends a fenced document over the container weight cap to plain text", () => {
    const code = "\t\t\t\t\t\t\t\t\t\tx\n".repeat(300);
    assert.equal(nestingTooDeep(`\`\`\`\n${code}\`\`\``), true);
  });

  it("keeps every realistic answer far below the weight cap", () => {
    for (const text of realisticAnswers(200)) assert.equal(nestingTooDeep(text), false);
  });

  it("renders generated fence tricks the same way every call", () => {
    checkFenceTrickDocuments({ seed: 9_001, count: 400 });
  });
});
