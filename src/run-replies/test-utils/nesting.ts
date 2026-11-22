// Generated documents for the reply formatter. The unit run uses a few hundred; the opt-in fuzz
// run (format.fuzz.test.ts) uses thousands and also checks wall-clock time.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { formatRunReply } from "../format.js";

export function mentionLinks(markdown: string): string[] {
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

export function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DocumentRun {
  seed: number;
  count: number;
  timing?: boolean;
}

const tails = [
  "q",
  "@bob",
  "see https://linear.app/acme/profiles/bob",
  "| a | b |\n> | - | - |\n> | @x | www.linear%2Eapp/a/users/b |",
  "`code <T>`",
  "[x](https://linear.app/a/agents/c)",
];

function safeBody(text: string, truncated: boolean, context: string): string {
  const body = formatRunReply({ text, truncated }, []);
  assert.ok(body.length > 0 && body.length <= 3_500, context);
  assert.deepEqual(mentionLinks(body), [], context);
  assert.doesNotMatch(body, /[@\uFF20]/u, context);
  return body;
}

export function checkStackedDocuments({ seed, count }: DocumentRun): void {
  const next = random(seed);
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
  for (let index = 0; index < count; index += 1) {
    const lines: string[] = [];
    for (let line = 0, lineCount = 1 + Math.floor(next() * 6); line < lineCount; line += 1) {
      const unit = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(markers)).join("");
      lines.push(unit.repeat(1 + Math.floor(next() * 700)) + pick(tails));
    }
    const text = `Fixed it.\n\n${lines.join("\n")}`;
    safeBody(text, next() < 0.2, JSON.stringify({ index, text: text.slice(0, 200) }));
  }
}

// Nesting carried across lines by indentation (tabs, spaces, mixed) and by markers.
export function checkNestedDocuments({ seed, count, timing = false }: DocumentRun): void {
  const next = random(seed);
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
  const markers = ["- ", "* ", "+ ", "1. ", "2) ", "> ", "-\t", ">", "- > "];
  const indents = ["\t", "  ", " ", "    ", "\t  "];
  for (let index = 0; index < count; index += 1) {
    const perLine = 1 + Math.floor(next() * 40);
    const step = 1 + Math.floor(next() * 40);
    const unit = pick(indents);
    const marker = pick(markers);
    const lines: string[] = [];
    let size = 0;
    for (let line = 0; size < 3_300 && line < 400; line += 1) {
      const text =
        unit.repeat(line * step) +
        (next() < 0.8 ? marker : pick(markers)).repeat(perLine) +
        pick(tails);
      lines.push(text);
      size += text.length + 1;
    }
    const text = `Fixed it.\n\n${lines.join("\n")}`;
    const context = JSON.stringify({ index, perLine, step, unit, marker });
    checkOne(text, context, timing);
  }
}

// Lines that look like fences to a loose reader but are not, plus real ones, mixed with markers
// that carry nesting across lines.
export function checkFenceTrickDocuments({ seed, count, timing = false }: DocumentRun): void {
  const next = random(seed);
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
  const fences = [
    "```x`",
    "``` `",
    "~~~",
    "~~~~ a",
    "   ```",
    "    ```",
    "```",
    "``",
    "```\t`",
    "~~~x`",
  ];
  const markers = ["- >", ">- ", "> ", "- ", "1. ", ">\t", "-\t", "+ >", ">"];
  for (let index = 0; index < count; index += 1) {
    const lines: string[] = [];
    let size = 0;
    const unit = pick(markers);
    const tabs = Math.floor(next() * 12);
    for (let line = 0; size < 3_300 && line < 300; line += 1) {
      const text =
        next() < 0.15
          ? pick(fences)
          : `${pick(["", "\t", "  "]).repeat(line * tabs)}${unit.repeat(1 + Math.floor(next() * 40))}${pick(tails)}`;
      lines.push(text);
      size += text.length + 1;
    }
    const text = `Fixed it.\n\n${lines.join("\n")}`;
    checkOne(text, `fence trick ${JSON.stringify({ index, unit, tabs })}`, timing);
  }
}

// The same path and body on three calls, a warm render in time, and a safe reply.
function checkOne(text: string, context: string, timing: boolean): void {
  const reasons = new Set<string>();
  const bodies = new Set<string>();
  let slowest = 0;
  for (let call = 0; call < 3; call += 1) {
    let reason = "markdown";
    const started = performance.now();
    bodies.add(
      formatRunReply({ text, truncated: false }, [], {
        onFallback: (value) => {
          reason = value;
        },
      }),
    );
    if (call > 0) slowest = Math.max(slowest, performance.now() - started);
    reasons.add(reason);
  }
  assert.equal(reasons.size, 1, `${context} chose ${[...reasons].join(" and ")}`);
  assert.equal(bodies.size, 1, context);
  if (timing) assert.ok(slowest < 100, `${context} took ${slowest.toFixed(0)} ms`);
  safeBody(text, false, context);
}
