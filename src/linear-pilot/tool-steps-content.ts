import { isIP } from "node:net";
import { posix as path } from "node:path";
import { createAssistantTextRedactor } from "../assistant-text/redact.js";
import type { LinearAgentActivityContent } from "../providers/linear/agent.js";
import { toolName } from "../run-timeline/project.js";
import type { TimelineScrubber } from "../run-timeline/capture-types.js";
import { shapeShell } from "./tool-steps-shell.js";

const LIMIT = 2_048;
const HIDDEN = "[hidden]";
const SENSITIVE_LABEL = /pass|pwd|secret|token|key|auth|basic|bearer|cred|session|cookie|sig/iu;
const SENSITIVE_PATH =
  /^\.(env|ssh|aws|gnupg|npmrc|netrc|kube|docker|pypirc|git-credentials|boto)|\.(pem|p12|key|pfx|tfstate|tfvars|kdbx|jks|keystore|gpg|asc)$|^id_/iu;
const PRIVATE_HOST = /\.(localhost|local|internal|lan|home\.arpa|corp|test)$/iu;
const SEGMENT = /^[A-Za-z][A-Za-z0-9._-]{0,24}$/u;
const TOKENISH = /^(?:[a-f0-9]{16,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/iu;
const ENTITIES = new Map([
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
  ["sol", "/"],
  ["bsol", "\\"],
  ["colon", ":"],
  ["commat", "@"],
  ["percnt", "%"],
  ["lowbar", "_"],
  ["hyphen", "-"],
  ["equals", "="],
  ["tab", "\t"],
  ["newline", "\n"],
]);
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const ESCAPE = /\\(?:u\{([a-f0-9]{1,6})\}|u([a-f0-9]{4})|x([a-f0-9]{2}))/giu;
const redactor = createAssistantTextRedactor([]);

type Action = Extract<LinearAgentActivityContent, { type: "action" }>;
type Clean = (kind: "shell" | "path" | "url" | "name" | "mcp", value: string) => string;

export interface ToolCallItem {
  callId?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  detail?: unknown;
}

export function detailRecord(value: unknown): object | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value;
}

function ownValue(record: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function ownString(record: object, key: string): string | undefined {
  const value = ownValue(record, key);
  return typeof value === "string" ? value : undefined;
}

function decodeEntity(entity: string, numeric: string | undefined, name: string | undefined) {
  if (numeric) {
    const hex = /^x/iu.test(numeric);
    return String.fromCodePoint(Number.parseInt(hex ? numeric.slice(1) : numeric, hex ? 16 : 10));
  }
  return ENTITIES.get(name?.toLowerCase() ?? "") ?? entity;
}

function normalize(value: string): string {
  const decoded = value
    .replace(ESCAPE, (_match, ...parts: [string, string, string]) =>
      String.fromCodePoint(Number.parseInt(parts[0] || parts[1] || parts[2], 16)),
    )
    .replace(/(?:%[a-f0-9]{2})+/giu, (encoded) => decodeURIComponent(encoded))
    .replace(/&(?:#(x[0-9a-f]+|[0-9]+)|([a-z][a-z0-9]*));/giu, decodeEntity)
    .normalize("NFKC");
  const safe = decoded
    .replace(INVISIBLE, (character) => (/[\t\n]/u.test(character) ? " " : ""))
    .replace(/\s+/gu, " ")
    .trim();
  if (safe.length > LIMIT) throw new RangeError("Tool step argument too long");
  return safe;
}

function invalidPath(value: string) {
  return /^(?:~|file:|[a-z]:)|\\/iu.test(value);
}

function shapePath(raw: string, cwd: string | undefined) {
  if (invalidPath(raw)) return "outside workspace";
  const normalized = normalize(raw);
  if (!cwd || !path.isAbsolute(cwd) || invalidPath(normalized)) return "outside workspace";
  const resolved = path.resolve(cwd, normalized);
  const relative = path.relative(cwd.toLowerCase(), resolved.toLowerCase());
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "outside workspace";
  if (!relative) return ".";
  const segments = resolved.split("/").slice(-relative.split("/").length);
  if (segments.some((segment) => SENSITIVE_PATH.test(segment))) return HIDDEN;
  return (segments.length > 4 ? ".../" : "") + segments.slice(-4).join("/");
}

function digitLabel(value: string) {
  return value.length >= 8 && /\d/u.test(value);
}

function publicHost(host: string) {
  if (isIP(host.replace(/^\[|\]$/gu, "")) || PRIVATE_HOST.test(host)) return false;
  const labels = host.split(".");
  return (
    labels.length > 1 &&
    labels.every((label) => label.length > 0 && label.length < 20 && !digitLabel(label))
  );
}

function urlSegment(value: string) {
  const normalized = normalize(value);
  return SEGMENT.test(normalized) && !digitLabel(normalized) && !TOKENISH.test(normalized)
    ? normalized
    : "*";
}

function shapeUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return HIDDEN;
  const host = normalize(url.hostname).replace(/\.$/u, "");
  if (!publicHost(host)) return HIDDEN;
  return [
    host,
    ...url.pathname.slice(1).split("/").filter(Boolean).slice(0, 2).map(urlSegment),
  ].join("/");
}

function nameSuffix(value: string) {
  const separator = value.lastIndexOf("__");
  return separator < 0 ? value : value.slice(separator + 2);
}

function reshape(kind: Parameters<Clean>[0], value: string, cwd: string | undefined): string {
  switch (kind) {
    case "shell":
      return shapeShell(value, normalize);
    case "path":
      return shapePath(value, cwd);
    case "url":
      return shapeUrl(value);
    case "mcp":
      return nameSuffix(toolName(normalize(value), (name) => name));
    case "name":
      return toolName(normalize(value), (name) => name);
    default:
      return HIDDEN;
  }
}

function unchanged(value: string, scrub: TimelineScrubber) {
  return (
    scrub(value, 4096) === value &&
    redactor.redact([value], false)[0] === value &&
    !SENSITIVE_LABEL.test(value)
  );
}

function safeParameter(value: string, scrub: TimelineScrubber) {
  if (value === HIDDEN || !unchanged(value, scrub) || value.length > 200) return HIDDEN;
  const plain = value.replaceAll("`", "'").replace(/[<>[\]!|]/gu, "");
  return plain && (plain === value || unchanged(plain, scrub)) ? plain : HIDDEN;
}

function createCleaner(scrub: TimelineScrubber, cwd: string | undefined): Clean {
  return (kind, value) => {
    if (value.length > LIMIT) return HIDDEN;
    try {
      return safeParameter(reshape(kind, value, cwd), scrub);
    } catch {
      return HIDDEN;
    }
  };
}

function exitResult(detail: object) {
  const code = ownValue(detail, "exitCode");
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255
    ? { result: `exit ${code}` }
    : {};
}

function cleanField(
  detail: object,
  action: string,
  field: string,
  clean: (value: string) => string,
) {
  const value = ownString(detail, field);
  return value === undefined ? undefined : { action, parameter: clean(value) };
}

const FILE_ACTIONS = new Map([
  ["read", "Read"],
  ["write", "Wrote"],
  ["edit", "Edited"],
]);

function describeSearch(detail: object) {
  if (ownString(detail, "toolName") === undefined) return undefined;
  return cleanField(detail, "Searched", "query", () => "query");
}

function describeDetail(
  detail: object,
  name: string,
  clean: Clean,
): Omit<Action, "type"> | undefined {
  const kind = ownString(detail, "type") ?? "";
  const fileAction = FILE_ACTIONS.get(kind);
  if (fileAction)
    return cleanField(detail, fileAction, "filePath", (value) => clean("path", value));
  switch (kind) {
    case "shell": {
      const shell = cleanField(detail, "Ran command", "command", (value) => clean("shell", value));
      return shell && { ...shell, ...exitResult(detail) };
    }
    case "fetch":
      return cleanField(detail, "Fetched", "url", (value) => clean("url", value));
    case "search":
      return describeSearch(detail);
    case "sub_agent":
      return { action: "Started sub-agent", parameter: "sub-agent" };
    case "unknown":
    case "mcp":
      return { action: "Called tool", parameter: clean("mcp", name) };
    default:
      return undefined;
  }
}

export function createToolStepRenderer(scrub: TimelineScrubber, cwd: string | undefined) {
  const clean = createCleaner(scrub, cwd);
  return (item: ToolCallItem): Action => {
    const detail = detailRecord(item.detail);
    const name = item.name ?? "unnamed";
    const content = (detail && describeDetail(detail, name, clean)) ?? {
      action: "Used tool",
      parameter: clean("name", name),
    };
    const suffix =
      item.status === "failed" || item.status === "canceled" ? ` (${item.status})` : "";
    return { ...content, type: "action", action: content.action + suffix };
  };
}
