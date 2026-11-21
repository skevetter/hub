import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Parents, Root, RootContent } from "mdast";
import { gfm } from "micromark-extension-gfm";
import { createAssistantTextRedactor } from "../assistant-text/redact.js";

export interface FinalReplyAnswer {
  text: string;
  truncated: boolean;
}

const MAX_REPLY_CHARS = 3_500;
export const MAX_REPLY_INPUT_CHARS = 16_384;
const TRUNCATION = "\n\n[Reply truncated]";
const URL_IN_PROSE = /\b(?:https?:\/\/|www\.|linear\.app\/)[^\s<>()[\]"']+/giu;
const LINEAR_MENTION_PATH = /\/(?:profiles|users|agents)(?:\/|$)/iu;
const MENTION_SIGN = /[@\uFF20]|&(?:#0*64|#x0*40|commat);/giu;
const USER_TAG = /(?:<|&lt;)\/?user\b[^<>]*?(?:>|&gt;)/giu;

export function formatRunReply(answer: FinalReplyAnswer, secrets: readonly string[]): string {
  const bounded = answer.text.slice(0, MAX_REPLY_INPUT_CHARS);
  const truncated = answer.truncated || bounded.length < answer.text.length;
  const [redacted] = createAssistantTextRedactor(secrets).redact([bounded], truncated);
  const source = redacted!
    .replaceAll("\0", "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  const markdown = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  sanitizeMarkdown(markdown);
  const safe = toMarkdown(markdown, { extensions: [gfmToMarkdown()] }).trim();
  if (safe === "" || (!truncated && safe.length <= MAX_REPLY_CHARS)) return safe;
  const prefix = safe.slice(0, MAX_REPLY_CHARS - TRUNCATION.length);
  const paragraph = prefix.lastIndexOf("\n\n");
  const line = prefix.lastIndexOf("\n");
  const boundary = paragraph > prefix.length - 300 ? paragraph : line;
  const clipped = boundary > 0 && prefix.length < safe.length ? prefix.slice(0, boundary) : prefix;
  return clipped.replace(/[\uD800-\uDBFF]$/u, "").trimEnd() + TRUNCATION;
}

function sanitizeMarkdown(markdown: Root): void {
  // Preserve references without serializing their original identifiers.
  const labels = new Map<string, string>();
  const pending: Parents[] = [markdown];
  for (const parent of pending) {
    for (let index = parent.children.length - 1; index >= 0; index -= 1) {
      const node = parent.children[index]!;
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
    .replace(MENTION_SIGN, "[at]");
}

function safeLink(value: string): boolean {
  if (value.replace(MENTION_SIGN, "") !== value) return false;
  const url = URL.parse(value);
  if (url === null || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
    return false;
  const host = url.hostname.replace(/\.$/u, "");
  if (host !== "linear.app" && !host.endsWith(".linear.app")) return true;
  try {
    const path = decodeURIComponent(url.pathname).normalize("NFKC");
    return !LINEAR_MENTION_PATH.test(path);
  } catch {
    return false;
  }
}
