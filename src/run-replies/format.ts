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
const MAX_CONTAINER_DEPTH = 24;
const DEEP_LINE_DEPTH = 8;
const MAX_DEEP_LINES = 200;
// Ten times the most any of 500 realistic answers reaches (604), rounded up.
const MAX_CONTAINER_WEIGHT = 6_500;
const URL_START = /https?:\/\/|www\.|(?<![\w-])linear\.app\.?(?=[:/])/giu;
const URL_RUN = /[^\s<>()[\]"'`]*/uy;
const LINEAR_HOST_PATH = /linear\.app\.?(?::\d{1,5})?(\/[^\s<>()[\]"'`\\?#]*)/giu;
const LINEAR_MENTION_PATH = /\/(?:profiles|users|agents)(?:\/|$)/iu;
const MENTION_SIGN = /[@\uFF20]|&(?:#0*64|#x0*40|commat);/giu;
const USER_TAG = /(?:<|&lt;)\/?user\b[^<>\r\n]*?(?:>|&gt;|$)/gimu;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;

export interface FormatOptions {
  now?: () => number;
  // Called once per reply that took the plain-text path. Carries no content.
  onFallback?: (reason: "structure" | "budget") => void;
}

interface RenderState {
  limit: number;
  truncated: boolean;
  plainText: boolean;
  defang: boolean;
}

interface RenderContext {
  deadline: number;
  now: () => number;
  report: NonNullable<FormatOptions["onFallback"]>;
  redact: ReturnType<typeof createAssistantTextRedactor>;
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
  const truncated = answer.truncated || text.length > MAX_REPLY_CHARS;
  const state = {
    truncated,
    limit: truncated ? TRUNCATED_TEXT_LIMIT - RAW_TRUNCATION_MARGIN : MAX_REPLY_CHARS,
    plainText: false,
    defang: false,
  };
  const context = { deadline, now, report, redact };
  for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
    const result = renderAttempt(text, state, context);
    if (result !== undefined) return result;
  }
  return renderLastResort(text, state.limit, context);
}

function renderAttempt(
  text: string,
  state: RenderState,
  context: RenderContext,
): string | undefined {
  const { deadline, now, report, redact } = context;
  const prefix = text.length <= state.limit ? text : clipSource(text, state.limit);
  const [redacted] = redact.redact([prefix], state.truncated);
  const source = cleanSource(redacted);
  const markdown = state.plainText ? undefined : renderMarkdown(source, deadline, now, report);
  state.plainText = markdown === undefined;
  const safe = markdown ?? renderPlainText(source, state.defang);
  if (safe === "") return safe;
  const whole = !state.truncated && safe.length <= MAX_REPLY_CHARS;
  if (whole || safe.length <= TRUNCATED_TEXT_LIMIT)
    return finishAttempt(safe, whole, state, report);
  state.truncated = true;
  state.limit = Math.floor(
    (prefix.length * (TRUNCATED_TEXT_LIMIT - RAW_TRUNCATION_MARGIN)) / safe.length,
  );
  return undefined;
}

function finishAttempt(
  safe: string,
  whole: boolean,
  state: RenderState,
  report: RenderContext["report"],
): string | undefined {
  // Parsing is superlinear on escape-heavy text, so only the reply that will post is checked.
  if (!hasUnsafeNode(safe)) return whole ? safe : safe + TRUNCATION;
  if (state.plainText && state.defang)
    throw new Error("Linear reply contains an unsafe link after rendering");
  state.defang = state.plainText;
  state.plainText = true;
  report("structure");
  return undefined;
}

function renderLastResort(text: string, limit: number, { redact, report }: RenderContext): string {
  report("structure");
  const [redacted] = redact.redact([text.slice(0, Math.min(limit, SHORT_PLAIN_PREFIX))], true);
  const safe = renderPlainText(cleanSource(redacted), true);
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

function cleanSource(text: string | undefined): string {
  if (text === undefined)
    throw new TypeError("Cannot read properties of undefined (reading 'replaceAll')");
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
  if (!boundedStructure(source) || nestingTooDeep(source)) {
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

interface Fence {
  char: string;
  size: number;
  info: string;
}

function readFence(match: RegExpExecArray | null): Fence | undefined {
  const ticks = match?.[1];
  const info = match?.[2];
  if (ticks === undefined || info === undefined) return undefined;
  const char = ticks.charAt(0);
  // An info string after a backtick fence cannot hold a backtick.
  return char === "`" && info.includes("`") ? undefined : { char, info, size: ticks.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const ticks = FENCE_CLOSE.exec(line)?.[1];
  return ticks !== undefined && ticks[0] === fence.char && ticks.length >= fence.size;
}

// Estimated container depth of every line outside a fence: its markers, with or without a space
// between them, plus one level per 2 columns of indentation after the mandatory single space of a
// marker (a tab is up to 4 columns, and indentation counts after every marker, not only before the
// first). micromark nests one container per level and recurses on it, so an answer whose lines
// run deep, on one line or carried across lines, goes to the plain path. A second bound counts
// marker characters and indentation in the first 40 columns of every line, fences or not, so a
// fence trick cannot hide a deep document. The decision depends on the text only, never on timing.
export function nestingTooDeep(source: string): boolean {
  let fence: Fence | undefined;
  let deepLines = 0;
  let weight = 0;
  for (const line of source.split(/\r\n|\r|\n/u)) {
    weight += containerWeight(line);
    if (weight > MAX_CONTAINER_WEIGHT) return true;
    const marks = FENCE_OPEN.exec(line);
    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    fence = readFence(marks);
    if (fence !== undefined) continue;
    const depth = lineDepth(line);
    if (
      depth > MAX_CONTAINER_DEPTH ||
      (depth > DEEP_LINE_DEPTH && (deepLines += 1) > MAX_DEEP_LINES)
    )
      return true;
  }
  return false;
}

function containerWeight(line: string): number {
  let weight = 0;
  let column = 0;
  for (let index = 0; index < line.length && column < 40; index += 1) {
    const char = line[index];
    if (char === "\t") {
      weight += 4 - (column % 4);
      column += 4 - (column % 4);
      continue;
    }
    column += 1;
    if (char === " " || char === ">" || char === "-" || char === "+" || char === "*") weight += 1;
  }
  return weight;
}

function lineDepth(line: string): number {
  let markers = 0;
  let spaces = 0;
  let column = 0;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === " " || char === "\t") {
      const width = char === "\t" ? 4 - (column % 4) : 1;
      column += width;
      spaces += width;
      index += 1;
      continue;
    }
    const length = markerLength(line, index);
    if (length === 0) break;
    markers += 1;
    column += length;
    index += length;
  }
  return markers + Math.floor(Math.max(0, spaces - markers) / 2);
}

function markerLength(line: string, index: number): number {
  const char = line.charAt(index);
  if (char === ">") return 1;
  if (char === "-" || char === "+" || char === "*") return markerEnds(line, index + 1);
  return isDigit(char) ? numberedMarkerLength(line, index) : 0;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function numberedMarkerLength(line: string, index: number): number {
  let digits = index;
  while (isDigit(line.charAt(digits))) digits += 1;
  if (digits - index > 9 || (line[digits] !== "." && line[digits] !== ")")) return 0;
  return markerEnds(line, digits + 1) === 0 ? 0 : digits + 1 - index;
}

// A list marker needs a space, a tab or the end of the line after it.
function markerEnds(line: string, next: number): number {
  return next >= line.length || line[next] === " " || line[next] === "\t" ? 1 : 0;
}

// Limits on the shapes that make micromark slow, not on punctuation in general: ordinary
// answers are full of brackets, parentheses and underscores.
function boundedStructure(source: string): boolean {
  if (OPENER_RUN.test(source)) return false;
  const { square, round, emphasis, footnotes, rows, pipes } = countDelimiters(source);
  return (
    square <= MAX_UNMATCHED_BRACKETS &&
    round <= MAX_UNMATCHED_BRACKETS &&
    emphasis <= MAX_EMPHASIS_CHARS &&
    footnotes <= MAX_FOOTNOTE_LABELS &&
    rows <= MAX_TABLE_ROWS &&
    pipes <= MAX_PIPES
  );
}

function startsRow(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === "\n";
}

function countDelimiters(source: string) {
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
        footnotes += Number(source[index + 1] === "^");
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
        rows += Number(startsRow(source, index));
        break;
      case undefined:
        break;
    }
  }
  return { square, round, emphasis, footnotes, rows, pipes };
}

interface PlainTextState {
  out: string[];
  fence?: Fence | undefined;
  code: string[];
  inList: boolean;
}

// Keeps fenced code verbatim and the line structure of the rest, and escapes inline Markdown
// outside fences. Only mention and link text is rewritten.
function renderPlainText(source: string, defang: boolean): string {
  const state: PlainTextState = { out: [], code: [], inList: false };
  for (const line of source.split(/\r\n|\r|\n/u)) {
    renderPlainLine(line, state, defang);
  }
  flushFence(state);
  const result = state.out.join("\n").trim();
  if (!hasSafeProse(result)) throw new Error("Linear reply contains unsafe text after rendering");
  return result;
}

function flushFence(state: PlainTextState): void {
  const { fence, code, out } = state;
  if (fence === undefined) return;
  const longest = Math.max(0, ...[...code.join("\n").matchAll(/`+/gu)].map((run) => run[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  out.push(ticks + fence.info, ...code, ticks);
  state.fence = undefined;
  state.code = [];
}

function renderPlainLine(line: string, state: PlainTextState, defang: boolean): void {
  if (state.fence !== undefined) {
    if (closesFence(line, state.fence)) flushFence(state);
    else state.code.push(neutralizeCode(line));
    return;
  }
  const open = readFence(FENCE_OPEN.exec(line));
  if (open !== undefined) {
    open.info = /^[\w+#.-]{1,20}/u.exec(open.info.trim())?.[0] ?? "";
    state.fence = open;
    return;
  }
  renderProseLine(line, state, defang);
}

function renderProseLine(line: string, state: PlainTextState, defang: boolean): void {
  const item = /^( *)([-*+]|\d{1,9}[.)])( +)(.*)$/u.exec(line);
  const indent = /^ */u.exec(line)?.[0].length ?? 0;
  if (item) {
    state.inList = true;
    state.out.push(renderListItem(item, defang));
  } else if (line.trim() === "") {
    state.out.push("");
  } else {
    // Deep indentation outside a list would become code, where escapes show as backslashes.
    const kept = state.inList && indent >= 4 ? Math.min(indent, MAX_LIST_INDENT) : 0;
    if (indent === 0) state.inList = false;
    state.out.push(" ".repeat(kept) + escapeInline(line.trim(), defang));
  }
}

function renderListItem(item: RegExpExecArray, defang: boolean): string {
  const kept = Math.min(item[1]?.length ?? 0, MAX_LIST_INDENT);
  return `${" ".repeat(kept)}${item[2]} ${escapeInline(item[4] ?? "", defang)}`;
}

// Code is not decoded by Markdown, but the final check reads the whole reply once decoded, so an
// entity that would decode into a mention keeps its ampersand literal.
function neutralizeCode(line: string): string {
  const value = neutralizeMentions(line);
  const decoded = cleanSource(decodeString(value));
  return neutralizeMentions(decoded) === decoded ? value : value.replaceAll("&", "&amp;");
}

// GFM links "https://" and "www." in decoded text even when every character is escaped. A zero
// width space after the scheme, or between "www" and its dot, stops the autolink from forming
// when the checks cannot parse the URL it would build.
function escapeInline(text: string, defang: boolean): string {
  const neutral = neutralizeMentions(text);
  const spaced = defang ? neutral.replace(/https?:\/\/|www(?=\.)/giu, "$&\u200B") : neutral;
  return spaced.replace(/[!-/:-@[-`{-~]/gu, "\\$&");
}

// Escaping can expose a link the source did not have, so the final text is parsed again and
// every link, image and HTML node GFM would build is checked. Failing closed beats guessing a
// repair: autolink literals carry no source position.
function hasUnsafeNode(text: string): boolean {
  try {
    const pending: Array<Root | RootContent> = [parseMarkdown(text)];
    for (const node of pending) {
      if (node.type !== "root" && removeNode(node, true)) return true;
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
    sanitizeChildren(parent, labels, pending);
  }
  // Removing an image, tag or user tag can leave an empty "~~~~" or "****", which re-parses as a
  // fence or a thematic break. Children come after their parents in the list, so walk it backwards.
  for (const parent of pending.toReversed()) {
    parent.children = parent.children.filter(
      (child) =>
        !(
          (child.type === "text" && child.value === "") ||
          ((child.type === "delete" || child.type === "emphasis" || child.type === "strong") &&
            child.children.length === 0)
        ),
    );
  }
}

function sanitizeChildren(parent: Parents, labels: Map<string, string>, pending: Parents[]): void {
  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const node = parent.children[index];
    if (node === undefined)
      throw new TypeError("Cannot read properties of undefined (reading 'type')");
    if (node.type === "link" && (!safeLink(node.url) || node.url.includes("[redacted]"))) {
      // Keep the label; a redacted or unsafe destination is not worth the whole sentence.
      parent.children.splice(index, 1, ...node.children);
      index += node.children.length;
      continue;
    }
    if (removeNode(node)) {
      parent.children.splice(index, 1);
      continue;
    }
    sanitizeNode(node, labels);
    if ("children" in node) pending.push(node);
  }
}

function sanitizeNode(node: RootContent, labels: Map<string, string>): void {
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
}

function removeNode(node: RootContent, tolerateUnparseable = false): boolean {
  if (node.type === "image" || node.type === "imageReference" || node.type === "html") return true;
  return (
    (node.type === "link" || node.type === "definition") && !safeLink(node.url, tolerateUnparseable)
  );
}

// GFM links a "www." or scheme at any punctuation boundary, including inside a longer URL that
// starts after a word character, so every start is checked and not only the outer match.
function removeUnsafeUrls(value: string): string {
  const unsafe: [number, number][] = [];
  for (const start of value.matchAll(URL_START)) {
    URL_RUN.lastIndex = start.index;
    const match = URL_RUN.exec(value);
    if (match === null) throw new TypeError("Cannot read properties of null (reading '0')");
    const run = match[0];
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

function safeLink(value: string, tolerateUnparseable = false): boolean {
  if (value.replace(MENTION_SIGN, "") !== value) return false;
  const url = URL.parse(value);
  // A destination no URL parser accepts cannot be a profile link unless it spells one out.
  if (url === null) return tolerateUnparseable && !spellsMentionLink(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.replace(/\.$/u, "");
  if (host !== "linear.app" && !host.endsWith(".linear.app")) return true;
  return !isLinearMentionPath(url.pathname);
}

function spellsMentionLink(value: string): boolean {
  let text = cleanSource(decodeString(value));
  try {
    text = decodeURIComponent(text);
  } catch {}
  return /linear\.app.*\/(?:profiles|users|agents)(?:\/|$)/iu.test(text.normalize("NFKC"));
}

function isLinearMentionPath(path: string): boolean {
  try {
    return LINEAR_MENTION_PATH.test(decodeURIComponent(path).normalize("NFKC"));
  } catch {
    return true;
  }
}
