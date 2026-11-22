import { performance } from "node:perf_hooks";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Parents, Root, RootContent } from "mdast";
import { gfm } from "micromark-extension-gfm";
import { decodeString } from "micromark-util-decode-string";
import { createAssistantTextRedactor } from "../assistant-text/redact.js";

export interface FinalReplyAnswer {
  text: string;
  truncated: boolean;
}

const MAX_REPLY_CHARS = 3_500;
export const MAX_REPLY_INPUT_CHARS = 16_384;
const TRUNCATION = "\n\n[Reply truncated]";
const TRUNCATED_TEXT_LIMIT = MAX_REPLY_CHARS - TRUNCATION.length;
const RAW_TRUNCATION_MARGIN = 48;
const MAX_RENDER_ATTEMPTS = 3;
const SHORT_PLAIN_PREFIX = 256;
const MARKDOWN_BUDGET_MS = 150;
const MAX_OPENER_RUN = 200;
const MAX_UNMATCHED_BRACKETS = 600;
const MAX_EMPHASIS_CHARS = 1_000;
const MAX_FOOTNOTE_LABELS = 100;
const MAX_TABLE_ROWS = 250;
const MAX_PIPES = 600;
const MAX_LIST_INDENT = 12;
const OPENER_RUN = new RegExp(`([[(*_~<])\\1{${MAX_OPENER_RUN - 1}}`, "u");
const MAX_CONTAINER_DEPTH = 32;
const URL_START = /https?:\/\/|www\.|(?<![\w-])linear\.app\.?(?=[:/])/giu;
const URL_RUN = /[^\s<>()[\]"'`]*/uy;
const LINEAR_HOST_PATH = /linear\.app\.?(?::\d{1,5})?(\/[^\s<>()[\]"'`\\?#]*)/giu;
const LINEAR_MENTION_PATH = /\/(?:profiles|users|agents)(?:\/|$)/iu;
const MENTION_SIGN = /[@\uFF20]|&(?:#0*64|#x0*40|commat);/giu;
const USER_TAG = /(?:<|&lt;)\/?user\b[^<>\r\n]*?(?:>|&gt;|$)/gimu;

export interface FormatOptions {
  now?: () => number;
  // Called once per reply that took the plain-text path. Carries no content.
  onFallback?: (reason: "structure" | "budget") => void;
}

export function formatRunReply(
  answer: FinalReplyAnswer,
  secrets: readonly string[],
  options: FormatOptions = {},
): string {
  const { text } = answer;
  const now = options.now ?? (() => performance.now());
  const deadline = now() + MARKDOWN_BUDGET_MS;
  let reported = false;
  const report = (reason: "structure" | "budget") => {
    if (!reported) options.onFallback?.(reason);
    reported = true;
  };
  const redact = createAssistantTextRedactor(secrets);
  let truncated = answer.truncated || text.length > MAX_REPLY_CHARS;
  let limit = truncated ? TRUNCATED_TEXT_LIMIT - RAW_TRUNCATION_MARGIN : MAX_REPLY_CHARS;
  let plainText = false;
  for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
    const prefix = text.length <= limit ? text : clipSource(text, limit);
    const [redacted] = redact.redact([prefix], truncated);
    const source = cleanSource(redacted!);
    const markdown: string | undefined = plainText
      ? undefined
      : renderMarkdown(source, deadline, now, report);
    plainText = markdown === undefined;
    const safe = markdown ?? renderPlainText(source);
    if (safe === "") return safe;
    const whole = !truncated && safe.length <= MAX_REPLY_CHARS;
    if (whole || safe.length <= TRUNCATED_TEXT_LIMIT) {
      // Parsing is superlinear on escape-heavy text, so only the reply that will post is checked.
      if (hasUnsafeNode(safe)) {
        if (plainText) throw new Error("Linear reply contains an unsafe link after rendering");
        plainText = true;
        report("structure");
        continue;
      }
      return whole ? safe : safe + TRUNCATION;
    }
    truncated = true;
    limit = Math.floor(
      (prefix.length * (TRUNCATED_TEXT_LIMIT - RAW_TRUNCATION_MARGIN)) / safe.length,
    );
  }
  report("structure");
  const [redacted] = redact.redact([text.slice(0, Math.min(limit, SHORT_PLAIN_PREFIX))], true);
  const safe = renderPlainText(cleanSource(redacted!));
  if (safe.length > TRUNCATED_TEXT_LIMIT)
    throw new Error("Linear reply exceeds the rendering limit");
  if (hasUnsafeNode(safe)) throw new Error("Linear reply contains an unsafe link after rendering");
  return safe === "" ? safe : safe + TRUNCATION;
}

function clipSource(text: string, limit: number): string {
  const line = Math.max(text.lastIndexOf("\n", limit - 1), text.lastIndexOf("\r", limit - 1));
  if (line >= limit - 240 && line > 0) return text.slice(0, line);
  const prefix = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "");
  const tail = prefix.slice(line + 1);
  if (/^ {0,3}`{3,}/u.test(tail)) return prefix;
  let opening: RegExpExecArray | undefined;
  for (const run of tail.matchAll(/\\[^\r\n]|`+/gu)) {
    if (!run[0].startsWith("`")) continue;
    if (opening === undefined) opening = run;
    else if (opening[0].length === run[0].length) opening = undefined;
  }
  return opening === undefined ? prefix : prefix.slice(0, line + 1 + opening.index);
}

function cleanSource(text: string): string {
  return text
    .replaceAll("\0", "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

function renderMarkdown(
  source: string,
  deadline: number,
  now: () => number,
  report: (reason: "structure" | "budget") => void,
): string | undefined {
  // Micromark is synchronous. Bound delimiter-heavy input before any parser runs.
  if (!boundedStructure(source) || containerDepth(source) > MAX_CONTAINER_DEPTH) {
    report("structure");
    return undefined;
  }
  const late = () => {
    if (now() < deadline) return false;
    report("budget");
    return true;
  };
  if (late()) return undefined;
  try {
    const markdown = parseMarkdown(source);
    if (late()) return undefined;
    sanitizeMarkdown(markdown);
    if (late()) return undefined;
    const result = toMarkdown(markdown, {
      extensions: [gfmToMarkdown({ tablePipeAlign: false })],
    }).trim();
    if (late()) return undefined;
    if (hasSafeProse(result)) return result;
  } catch {
    // A parser limit such as stack depth: the plain-text path is linear.
  }
  report("structure");
  return undefined;
}

// Most container markers on one line, with or without a space between them. micromark nests
// one container per marker and recurses on it, so depth is capped before parsing.
function containerDepth(source: string): number {
  let deepest = 0;
  for (const line of source.split(/\r\n|\r|\n/u)) {
    let depth = 0;
    let index = 0;
    while (index < line.length) {
      const char = line[index]!;
      if (char === " " || char === "\t") {
        index += 1;
        continue;
      }
      let length = 0;
      if (char === ">") length = 1;
      else if (char === "-" || char === "+" || char === "*") length = markerEnds(line, index + 1);
      else if (char >= "0" && char <= "9") {
        let digits = index;
        while (line[digits]! >= "0" && line[digits]! <= "9") digits += 1;
        if (digits - index <= 9 && (line[digits] === "." || line[digits] === ")"))
          length = markerEnds(line, digits + 1) === 0 ? 0 : digits + 1 - index;
      }
      if (length === 0) break;
      depth += 1;
      index += length;
    }
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

// A list marker needs a space, a tab or the end of the line after it.
function markerEnds(line: string, next: number): number {
  return next >= line.length || line[next] === " " || line[next] === "\t" ? 1 : 0;
}

// Limits on the shapes that make micromark slow, not on punctuation in general: ordinary
// answers are full of brackets, parentheses and underscores.
function boundedStructure(source: string): boolean {
  if (OPENER_RUN.test(source)) return false;
  let square = 0;
  let round = 0;
  let emphasis = 0;
  let footnotes = 0;
  let rows = 0;
  let pipes = 0;
  for (let index = 0; index < source.length; index += 1) {
    switch (source[index]) {
      case "[":
        square += 1;
        if (source[index + 1] === "^") footnotes += 1;
        break;
      case "]":
        square = Math.max(0, square - 1);
        break;
      case "(":
        round += 1;
        break;
      case ")":
        round = Math.max(0, round - 1);
        break;
      case "*":
      case "_":
        emphasis += 1;
        break;
      case "|":
        pipes += 1;
        if (index === 0 || source[index - 1] === "\n") rows += 1;
        break;
    }
  }
  return (
    square <= MAX_UNMATCHED_BRACKETS &&
    round <= MAX_UNMATCHED_BRACKETS &&
    emphasis <= MAX_EMPHASIS_CHARS &&
    footnotes <= MAX_FOOTNOTE_LABELS &&
    rows <= MAX_TABLE_ROWS &&
    pipes <= MAX_PIPES
  );
}

// Keeps fenced code verbatim and the line structure of the rest, and escapes inline Markdown
// outside fences. Only mention and link text is rewritten.
function renderPlainText(source: string): string {
  const out: string[] = [];
  let fence: { char: string; size: number; info: string } | undefined;
  let code: string[] = [];
  let inList = false;
  const flush = () => {
    if (fence === undefined) return;
    const longest = Math.max(
      0,
      ...[...code.join("\n").matchAll(/`+/gu)].map((run) => run[0].length),
    );
    const ticks = "`".repeat(Math.max(3, longest + 1));
    out.push(ticks + fence.info, ...code, ticks);
    fence = undefined;
    code = [];
  };
  for (const line of source.split(/\r\n|\r|\n/u)) {
    if (fence !== undefined) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.size) flush();
      else code.push(neutralizeCode(line));
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      const info = /^[\w+#.-]{1,20}/u.exec(open[2]!.trim())?.[0] ?? "";
      fence = { char: open[1]![0]!, size: open[1]!.length, info };
      continue;
    }
    const item = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/u.exec(line);
    const indent = /^ */u.exec(line)![0].length;
    if (item) {
      inList = true;
      const kept = Math.min(item[1]!.length, MAX_LIST_INDENT);
      out.push(`${" ".repeat(kept)}${item[2]} ${escapeInline(item[4]!)}`);
    } else if (line.trim() === "") {
      out.push("");
    } else {
      // Deep indentation outside a list would become code, where escapes show as backslashes.
      const kept = inList && indent >= 4 ? Math.min(indent, MAX_LIST_INDENT) : 0;
      if (indent === 0) inList = false;
      out.push(" ".repeat(kept) + escapeInline(line.trim()));
    }
  }
  flush();
  const result = out.join("\n").trim();
  if (!hasSafeProse(result)) throw new Error("Linear reply contains unsafe text after rendering");
  return result;
}

// Code is not decoded by Markdown, but the final check reads the whole reply once decoded, so an
// entity that would decode into a mention keeps its ampersand literal.
function neutralizeCode(line: string): string {
  const value = neutralizeMentions(line);
  const decoded = cleanSource(decodeString(value));
  return neutralizeMentions(decoded) === decoded ? value : value.replaceAll("&", "&amp;");
}

function escapeInline(text: string): string {
  return neutralizeMentions(text).replace(/[!-/:-@[-`{-~]/gu, "\\$&");
}

// Escaping can expose a link the source did not have, so the final text is parsed again and
// every link, image and HTML node GFM would build is checked. Failing closed beats guessing a
// repair: autolink literals carry no source position.
function hasUnsafeNode(text: string): boolean {
  try {
    const pending: Array<Root | RootContent> = [parseMarkdown(text)];
    for (const node of pending) {
      if (node.type !== "root" && removeNode(node)) return true;
      if ("children" in node) pending.push(...node.children);
    }
    return false;
  } catch {
    return true;
  }
}

function parseMarkdown(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

function sanitizeMarkdown(markdown: Root): void {
  // Preserve references without serializing their original identifiers.
  const labels = new Map<string, string>();
  const pending: Parents[] = [markdown];
  for (const parent of pending) {
    for (let index = parent.children.length - 1; index >= 0; index -= 1) {
      const node = parent.children[index]!;
      if (node.type === "link" && node.url.startsWith("mailto:") && node.children.length === 1) {
        const label = node.children[0];
        if (label?.type === "text") {
          parent.children.splice(index, 1, {
            type: "text",
            value: neutralizeMentions(label.value),
          });
          continue;
        }
      }
      if (removeNode(node)) {
        parent.children.splice(index, 1);
        continue;
      }
      if ("value" in node) node.value = neutralizeMentions(node.value);
      if ("title" in node && node.title != null) node.title = neutralizeMentions(node.title);
      if ("identifier" in node) {
        const label = labels.get(node.identifier) ?? `ref-${labels.size + 1}`;
        labels.set(node.identifier, label);
        node.identifier = label;
        node.label = label;
        if (node.type === "linkReference") node.referenceType = "full";
      }
      if (node.type === "code") {
        if (node.lang != null) node.lang = neutralizeMentions(node.lang);
        if (node.meta != null) node.meta = neutralizeMentions(node.meta);
      }
      if ("children" in node) pending.push(node);
    }
  }
}

function removeNode(node: RootContent): boolean {
  if (node.type === "image" || node.type === "imageReference" || node.type === "html") return true;
  return (node.type === "link" || node.type === "definition") && !safeLink(node.url);
}

// GFM links a "www." or scheme at any punctuation boundary, including inside a longer URL that
// starts after a word character, so every start is checked and not only the outer match.
function removeUnsafeUrls(value: string): string {
  const unsafe: [number, number][] = [];
  for (const start of value.matchAll(URL_START)) {
    URL_RUN.lastIndex = start.index;
    const run = URL_RUN.exec(value)![0];
    const absolute = run.includes("://") ? run : `https://${run}`;
    if (!safeLink(absolute)) unsafe.push([start.index, start.index + run.length]);
  }
  let result = "";
  let done = 0;
  for (const [from, to] of unsafe) {
    if (to <= done) continue;
    result += value.slice(done, Math.max(from, done)) + "[Link removed]";
    done = to;
  }
  return result + value.slice(done);
}

function neutralizeMentions(value: string): string {
  let stripped = value;
  for (let previous = ""; previous !== stripped; ) {
    previous = stripped;
    stripped = stripped.replace(USER_TAG, "");
  }
  return removeUnsafeUrls(stripped)
    .replace(LINEAR_HOST_PATH, (text, path: string) =>
      isLinearMentionPath(path) ? "[Link removed]" : text,
    )
    .replace(MENTION_SIGN, "[at]");
}

function hasSafeProse(serialized: string): boolean {
  // Serialization can join previously separate text nodes or escape part of a URL.
  const prose = cleanSource(decodeString(serialized));
  return neutralizeMentions(prose) === prose;
}

function safeLink(value: string): boolean {
  if (value.replace(MENTION_SIGN, "") !== value) return false;
  const url = URL.parse(value);
  if (url === null || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
    return false;
  const host = url.hostname.replace(/\.$/u, "");
  if (host !== "linear.app" && !host.endsWith(".linear.app")) return true;
  return !isLinearMentionPath(url.pathname);
}

function isLinearMentionPath(path: string): boolean {
  try {
    return LINEAR_MENTION_PATH.test(decodeURIComponent(path).normalize("NFKC"));
  } catch {
    return true;
  }
}
