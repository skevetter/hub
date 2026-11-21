import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import type { Parents, RootContent } from "mdast";
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

export function formatRunReply(answer: FinalReplyAnswer, secrets: readonly string[]): string {
  const bounded = answer.text.slice(0, MAX_REPLY_INPUT_CHARS);
  const truncated = answer.truncated || bounded.length < answer.text.length;
  const [redacted] = createAssistantTextRedactor(secrets).redact([bounded], truncated);
  const source = redacted!
    .replaceAll("\0", "")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
  const markdown = fromMarkdown(source);
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
      if ("children" in node) pending.push(node);
    }
  }
  const safe = toMarkdown(markdown).trim();
  if (safe === "" || (!truncated && safe.length <= MAX_REPLY_CHARS)) return safe;
  const prefix = safe.slice(0, MAX_REPLY_CHARS - TRUNCATION.length);
  const paragraph = prefix.lastIndexOf("\n\n");
  const line = prefix.lastIndexOf("\n");
  const boundary = paragraph > prefix.length - 300 ? paragraph : line;
  const clipped = boundary > 0 && prefix.length < safe.length ? prefix.slice(0, boundary) : prefix;
  return clipped.replace(/[\uD800-\uDBFF]$/u, "").trimEnd() + TRUNCATION;
}

function removeNode(node: RootContent): boolean {
  if (node.type === "image" || node.type === "imageReference" || node.type === "html") return true;
  return (node.type === "link" || node.type === "definition") && !safeLink(node.url);
}

function neutralizeMentions(value: string): string {
  return value
    .replace(URL_IN_PROSE, (text) => {
      const absolute = text.includes("://") ? text : `https://${text}`;
      return safeLink(absolute) ? text : "[Link removed]";
    })
    .replace(/[@\uFF20]/gu, "[at]");
}

function safeLink(value: string): boolean {
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

export function linearRunReplyMarker(commentId: string): string {
  return `Paseo reply ${commentId}`;
}

export function hasLinearRunReplyMarker(body: string, commentId: string): boolean {
  const marker = linearRunReplyMarker(commentId);
  return body.split("\n").some((line) => line.trim() === marker);
}
