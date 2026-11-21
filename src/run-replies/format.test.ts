import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
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
