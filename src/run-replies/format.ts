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
const MARKDOWN_BUDGET_MS = 50;
const MAX_MARKDOWN_DELIMITERS = 192;
const MARKDOWN_DELIMITER = /[[\]()*_~`<>!&\\]+/gu;
const MARKDOWN_CONTAINER_CHAIN = /(?:(?:[-+*>]|\d{1,9}[.)])[ \t]+){33}/u;
const URL_IN_PROSE = /(?:https?:\/\/|www\.|(?<![\w-])linear\.app\.?(?=[:/]))[^\s<>()[\]"'`]+/giu;
const LINEAR_HOST_PATH = /linear\.app\.?(?::\d{1,5})?(\/[^\s<>()[\]"'`\\?#]*)/giu;
const LINEAR_MENTION_PATH = /\/(?:profiles|users|agents)(?:\/|$)/iu;
const MENTION_SIGN = /[@\uFF20]|&(?:#0*64|#x0*40|commat);/giu;
const USER_TAG = /(?:<|&lt;)\/?user\b[^<>\r\n]*?(?:>|&gt;|$)/gimu;
const HTML_MARKUP = /<!--[\s\S]*?(?:-->|$)|<\/?[a-zA-Z][^<>\r\n]*>/gu;

export function formatRunReply(answer: FinalReplyAnswer, secrets: readonly string[]): string {
  const { text } = answer;
  const deadline = performance.now() + MARKDOWN_BUDGET_MS;
  const redact = createAssistantTextRedactor(secrets);
  let truncated = answer.truncated || text.length > MAX_REPLY_CHARS;
  let limit = truncated ? TRUNCATED_TEXT_LIMIT - RAW_TRUNCATION_MARGIN : MAX_REPLY_CHARS;
  let plainText = false;
  for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
    const prefix = text.length <= limit ? text : clipSource(text, limit);
    const [redacted] = redact.redact([prefix], truncated);
    const source = cleanSource(redacted!);
    const markdown: string | undefined = plainText ? undefined : renderMarkdown(source, deadline);
    plainText = markdown === undefined;
    const safe = markdown ?? renderPlainText(source);
    if (safe === "") return safe;
    if (!truncated && safe.length <= MAX_REPLY_CHARS) return safe;
    if (safe.length <= TRUNCATED_TEXT_LIMIT) return safe + TRUNCATION;
    truncated = true;
    limit = Math.floor(
      (prefix.length * (TRUNCATED_TEXT_LIMIT - RAW_TRUNCATION_MARGIN)) / safe.length,
    );
  }
  const [redacted] = redact.redact([text.slice(0, Math.min(limit, SHORT_PLAIN_PREFIX))], true);
  const safe = renderPlainText(cleanSource(redacted!));
  if (safe.length > TRUNCATED_TEXT_LIMIT)
    throw new Error("Linear reply exceeds the rendering limit");
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

function renderMarkdown(source: string, deadline: number): string | undefined {
  // Micromark is synchronous. Bound delimiter-heavy input before any parser runs.
  if (tooManyDelimiters(source) || MARKDOWN_CONTAINER_CHAIN.test(source)) return undefined;
  if (performance.now() >= deadline) return undefined;
  const markdown = parseMarkdown(source);
  if (performance.now() >= deadline) return undefined;
  sanitizeMarkdown(markdown);
  if (performance.now() >= deadline) return undefined;
  const result = toMarkdown(markdown, {
    extensions: [gfmToMarkdown({ tablePipeAlign: false })],
  }).trim();
  return performance.now() < deadline && hasSafeProse(result) ? result : undefined;
}

function tooManyDelimiters(source: string): boolean {
  let count = 0;
  for (const run of source.matchAll(MARKDOWN_DELIMITER)) {
    count += run[0].length;
    if (count > MAX_MARKDOWN_DELIMITERS) return true;
  }
  return false;
}

function renderPlainText(source: string): string {
  const result = neutralizeMentions(source.replace(HTML_MARKUP, ""))
    .replace(/^[ \t]+/gmu, "")
    .replace(/[!-/:-@[-`{-~]/gu, "\\$&")
    .trim();
  if (!hasSafeProse(result)) throw new Error("Linear reply contains unsafe text after rendering");
  return result;
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

function neutralizeMentions(value: string): string {
  return value
    .replace(USER_TAG, "")
    .replace(URL_IN_PROSE, (text) => {
      const absolute = text.includes("://") ? text : `https://${text}`;
      return safeLink(absolute) ? text : "[Link removed]";
    })
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
