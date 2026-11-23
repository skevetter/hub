import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import type { Nodes, Root } from "mdast";
import { gfm } from "micromark-extension-gfm";
import { LINEAR_PILOT_ID, type LinearPilotConfig } from "./config.js";

/** Longest prompt or comment text the pilot accepts. Longer text is refused, never truncated. */
export const MAX_PILOT_MESSAGE_CHARS = 20_000;
/** Longest comment body handed to the Markdown parser, which is quadratic on adversarial input. */
export const MAX_PILOT_PARSE_CHARS = 2_048;
const MAX_HANDLE_CHARS = 64;

/** Installation facts read from the connection the signed organization resolved to. */
export interface LinearPilotInstallation {
  /** Hub organization that owns the connection. */
  readonly organizationId: string;
  /** Linear organization (workspace) of the connection. */
  readonly workspaceId: string;
  readonly applicationId: string;
  readonly appUserId: string;
  /** OAuth client ID of the Linear app, as registered for the connection. */
  readonly oauthClientId: string;
}

export type DelegationFallback =
  | "comment_missing"
  | "comment_id_mismatch"
  | "comment_issue_mismatch"
  | "comment_author_missing"
  | "source_mismatch";

export interface LinearPilotEvent {
  kind: "created" | "prompted" | "stop";
  workspaceId: string;
  applicationId: string;
  appUserId: string;
  nativeSessionId: string;
  humanId: string;
  issueId: string;
  teamId?: string;
  activityId?: string;
  message?: string;
  pendingDelegation?: true;
  delegationFallback?: DelegationFallback;
  /**
   * Stop only. Epoch ms of the signed `agentActivity.createdAt`, present only when that field is
   * a strict UTC ISO-8601 timestamp. Absent means the time evidence is unusable: the caller must
   * not interrupt, since the Stop cannot be ordered against the daemon's turn start.
   */
  stopCreatedAtMs?: number;
}

export type LinearPilotRefusal =
  | "malformed"
  | "unsupported_event"
  | "unsupported_action"
  | "installation_mismatch"
  | "workspace_mismatch"
  | "app_mismatch"
  | "session_mismatch"
  | "missing_creator"
  | "not_owner"
  | "origin_unproven"
  | "activity_mismatch"
  | "unsupported_signal"
  | "unqualified_content"
  | "oversized";

export type LinearPilotIntakeResult =
  | { readonly ok: true; readonly event: LinearPilotEvent }
  | { readonly ok: false; readonly reason: LinearPilotRefusal };

type Record_ = Readonly<Record<string, unknown>>;

interface Scope {
  config: LinearPilotConfig;
  installation: LinearPilotInstallation;
  top: Record_;
  session: Record_;
  sessionId: string;
  issueId: string;
  teamId: string | undefined;
}

const refuse = (reason: LinearPilotRefusal): LinearPilotIntakeResult => ({ ok: false, reason });

/**
 * Pure intake for a webhook that already passed the HMAC and signed timestamp checks. Only the
 * configured owner can produce an event, and the result carries ids and bounded text, never the
 * raw payload. Nothing here reads credentials, logs, or calls out.
 */
export function verifyLinearPilotIntake(input: {
  config: LinearPilotConfig;
  installation: LinearPilotInstallation;
  payload: unknown;
}): LinearPilotIntakeResult {
  const { config, installation } = input;
  const top = plain(input.payload);
  if (top === undefined) return refuse("malformed");
  if (field(top, "type") !== "AgentSessionEvent") return refuse("unsupported_event");
  const action = field(top, "action");
  if (action !== "created" && action !== "prompted") return refuse("unsupported_action");
  if (
    installation.organizationId !== config.hubOrganizationId ||
    installation.workspaceId !== config.linearOrganizationId
  ) {
    return refuse("installation_mismatch");
  }
  const scope = readScope(config, installation, top);
  if ("ok" in scope) return scope;
  return action === "created" ? readCreated(scope) : readPrompted(scope);
}

export type LinearPilotScopeVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "unsupported" | "workspace_mismatch" | "not_owner";
    };

/**
 * Cheapest possible admission test on an already HMAC-verified payload: the signed workspace
 * and the one human who could have caused the event. It reads a few fields, touches no
 * connection, credential or store, and a refusal here means nothing else needs to run. It
 * proves nothing alone: `verifyLinearPilotIntake` still decides acceptance.
 */
export function precheckLinearPilotScope(input: {
  config: LinearPilotConfig;
  payload: unknown;
}): LinearPilotScopeVerdict {
  const { config, payload: top } = input;
  if (!isPlainRecord(top)) return { ok: false, reason: "malformed" };
  const action = field(top, "action");
  if (
    field(top, "type") !== "AgentSessionEvent" ||
    (action !== "created" && action !== "prompted")
  ) {
    return { ok: false, reason: "unsupported" };
  }
  if (id(field(top, "organizationId")) !== config.linearOrganizationId) {
    return { ok: false, reason: "workspace_mismatch" };
  }
  // Created is caused by the session creator, prompted by the activity author.
  const created = action === "created";
  const holder = field(top, created ? "agentSession" : "agentActivity");
  const human = isPlainRecord(holder) ? field(holder, created ? "creatorId" : "userId") : undefined;
  return id(human) === config.allowedHumanId ? { ok: true } : { ok: false, reason: "not_owner" };
}

function readScope(
  config: LinearPilotConfig,
  installation: LinearPilotInstallation,
  top: Record_,
): Scope | LinearPilotIntakeResult {
  const organizationId = id(field(top, "organizationId"));
  if (organizationId !== config.linearOrganizationId) return refuse("workspace_mismatch");
  if (
    id(field(top, "appUserId")) !== installation.appUserId ||
    id(field(top, "oauthClientId")) !== installation.oauthClientId
  ) {
    return refuse("app_mismatch");
  }
  const session = plain(field(top, "agentSession"));
  if (session === undefined) return refuse("malformed");
  const sessionId = id(field(session, "id"));
  const issueId = id(field(session, "issueId"));
  if (sessionId === undefined || issueId === undefined) return refuse("malformed");
  if (
    id(field(session, "organizationId")) !== organizationId ||
    id(field(session, "appUserId")) !== installation.appUserId
  ) {
    return refuse("session_mismatch");
  }
  const issue = readIssue(session, issueId);
  if ("ok" in issue) return issue;
  return { config, installation, top, session, sessionId, issueId, teamId: issue.teamId };
}

function readIssue(
  session: Record_,
  issueId: string,
): { teamId: string | undefined } | LinearPilotIntakeResult {
  const raw = field(session, "issue");
  if (raw === undefined || raw === null) return { teamId: undefined };
  const issue = plain(raw);
  if (issue === undefined) return refuse("malformed");
  if (id(field(issue, "id")) !== issueId) return refuse("session_mismatch");
  const rawTeam = field(issue, "teamId");
  if (rawTeam === undefined || rawTeam === null) return { teamId: undefined };
  const teamId = id(rawTeam);
  return teamId === undefined ? refuse("malformed") : { teamId };
}

function isOwner(scope: Scope, humanId: string): boolean {
  return humanId === scope.config.allowedHumanId && humanId !== scope.installation.appUserId;
}

function readCreated(scope: Scope): LinearPilotIntakeResult {
  const { session } = scope;
  const humanId = id(field(session, "creatorId"));
  if (humanId === undefined) return refuse("missing_creator");
  if (!isOwner(scope, humanId)) return refuse("not_owner");
  if (scope.teamId === undefined) return refuse("malformed");
  const creator = field(session, "creator");
  if (creator !== undefined && creator !== null) {
    if (id(field(plain(creator) ?? {}, "id")) !== humanId) return refuse("session_mismatch");
  }
  return readCreatedOrigin(scope, humanId);
}

function readCreatedOrigin(scope: Scope, humanId: string): LinearPilotIntakeResult {
  const { session } = scope;
  const rawComment = field(session, "comment");
  const rawCommentId = field(session, "commentId");
  const source = field(session, "sourceCommentId");
  // A creator can be an automation-substituted assignee. Without a comment, history must prove origin.
  if (rawComment == null && rawCommentId == null && source == null) {
    return accept(scope, "created", humanId, { pendingDelegation: true });
  }
  return readCreatedComment(scope, humanId, { rawComment, rawCommentId, source });
}

function readCreatedComment(
  scope: Scope,
  humanId: string,
  {
    rawComment,
    rawCommentId,
    source,
  }: { rawComment: unknown; rawCommentId: unknown; source: unknown },
): LinearPilotIntakeResult {
  const fallback = (delegationFallback: DelegationFallback) =>
    accept(scope, "created", humanId, { pendingDelegation: true, delegationFallback });
  const comment = plain(rawComment);
  if (comment === undefined) return fallback("comment_missing");
  const author = field(comment, "userId");
  if (author != null && author !== humanId) return refuse("origin_unproven");
  const commentId = id(rawCommentId);
  if (commentId === undefined || id(field(comment, "id")) !== commentId)
    return fallback("comment_id_mismatch");
  if (id(field(comment, "issueId")) !== scope.issueId) return fallback("comment_issue_mismatch");
  if (author == null) return fallback("comment_author_missing");
  if (source != null && source !== commentId) return fallback("source_mismatch");
  return acceptCreatedComment(scope, humanId, comment);
}

function acceptCreatedComment(
  scope: Scope,
  humanId: string,
  comment: Record_,
): LinearPilotIntakeResult {
  const message = readText(field(comment, "body"));
  if ("refusal" in message) return refuse(message.refusal);
  return accept(scope, "created", humanId, { message: message.text });
}

function readPrompted(scope: Scope): LinearPilotIntakeResult {
  const activity = plain(field(scope.top, "agentActivity"));
  if (activity === undefined) return refuse("malformed");
  const activityId = id(field(activity, "id"));
  if (activityId === undefined) return refuse("malformed");
  const humanId = id(field(activity, "userId"));
  const user = field(activity, "user");
  if (
    id(field(activity, "agentSessionId")) !== scope.sessionId ||
    humanId === undefined ||
    (user !== undefined && user !== null && id(field(plain(user) ?? {}, "id")) !== humanId)
  ) {
    return refuse("activity_mismatch");
  }
  if (!isOwner(scope, humanId)) return refuse("not_owner");
  const signal = field(activity, "signal");
  // Stop is decided before any body requirement: it must work with absent or odd content.
  if (signal === "stop") {
    return accept(scope, "stop", humanId, {
      activityId,
      stopCreatedAtMs: readUtcMs(field(activity, "createdAt")),
    });
  }
  if (signal !== undefined && signal !== null) return refuse("unsupported_signal");
  const body = readPromptBody(activity);
  if ("refusal" in body) return refuse(body.refusal);
  return accept(scope, "prompted", humanId, { activityId, message: body.text });
}

const UTC_STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u;

function readUtcMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = UTC_STAMP.exec(value);
  if (match === null) return undefined;
  const [, seconds = "", fraction = ""] = match;
  const canonical = `${seconds}.${fraction.padEnd(3, "0")}Z`;
  const parsed = new Date(canonical);
  const at = parsed.getTime();
  // Date parsing can roll invalid calendar dates forward.
  return Number.isFinite(at) && parsed.toISOString() === canonical ? at : undefined;
}

const PROMPT_KEYS = new Set(["type", "body", "title"]);

function readPromptBody(activity: Record_): PilotText {
  const unqualified: PilotText = { refusal: "unqualified_content" };
  const content = plain(field(activity, "content"));
  if (content === undefined || field(content, "type") !== "prompt") return unqualified;
  if (Object.keys(content).some((key) => !PROMPT_KEYS.has(key))) return unqualified;
  const title = field(content, "title");
  if (title !== undefined && title !== null && typeof title !== "string") return unqualified;
  const body = readText(field(content, "body"));
  if ("refusal" in body) return body;
  // The developer guide places the text on the activity itself. A second, different location is
  // an unqualified shape, so refuse rather than choose.
  const sibling = field(activity, "body");
  return sibling !== undefined && sibling !== body.text ? unqualified : body;
}

type PilotText = { text: string } | { refusal: LinearPilotRefusal };

function readText(value: unknown): PilotText {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { refusal: "unqualified_content" };
  }
  return value.length > MAX_PILOT_MESSAGE_CHARS ? { refusal: "oversized" } : { text: value };
}

function accept(
  scope: Scope,
  kind: LinearPilotEvent["kind"],
  humanId: string,
  {
    stopCreatedAtMs,
    ...extra
  }: Pick<
    LinearPilotEvent,
    "activityId" | "message" | "pendingDelegation" | "delegationFallback"
  > & {
    stopCreatedAtMs?: number | undefined;
  },
): LinearPilotIntakeResult {
  const event: LinearPilotEvent = {
    kind,
    workspaceId: scope.installation.workspaceId,
    applicationId: scope.installation.applicationId,
    appUserId: scope.installation.appUserId,
    nativeSessionId: scope.sessionId,
    humanId,
    issueId: scope.issueId,
    ...extra,
  };
  if (scope.teamId !== undefined) event.teamId = scope.teamId;
  if (stopCreatedAtMs !== undefined) event.stopCreatedAtMs = stopCreatedAtMs;
  return { ok: true, event };
}

function plain(value: unknown): Record_ | undefined {
  return isPlainRecord(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function isPlainRecord(value: unknown): value is Record_ {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function field(record: Record_, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && LINEAR_PILOT_ID.test(value) ? value : undefined;
}

// ---- companion comment suppression ----------------------------------------------------------

export type LinearPilotCompanionDecision =
  | { readonly suppress: true }
  | {
      readonly suppress: false;
      readonly reason:
        | "workspace_mismatch"
        | "owner_mismatch"
        | "body_unusable"
        | "handle_unusable"
        | "no_handle"
        | "code_only";
    }
  | {
      // The raw text names the handle but the Markdown could not be parsed safely, so whether it
      // is prose or code is unknown. The caller must not run a legacy trigger on it.
      readonly suppress: false;
      readonly reason: "unclassifiable";
      readonly ambiguous: true;
    };

/**
 * Decides whether a plain Linear comment is the companion of a native pilot session and must not
 * start a legacy trigger run. It matches only the exact pilot workspace and owner, and only a
 * literal `@handle` token in prose. Code spans, fences and indented code never count.
 * `resolveHandle` reads the stored verified handle. It is not called for refused input, so
 * a comment from anyone else costs no lookup.
 */
export async function classifyLinearPilotCompanionComment(input: {
  config: LinearPilotConfig;
  workspaceId: string;
  authorId: string | null | undefined;
  body: unknown;
  resolveHandle: () => string | null | undefined | Promise<string | null | undefined>;
}): Promise<LinearPilotCompanionDecision> {
  const { config, body } = input;
  if (input.workspaceId !== config.linearOrganizationId) {
    return { suppress: false, reason: "workspace_mismatch" };
  }
  if (input.authorId !== config.allowedHumanId)
    return { suppress: false, reason: "owner_mismatch" };
  if (typeof body !== "string" || !body.includes("@")) {
    return { suppress: false, reason: "body_unusable" };
  }
  const handle = normalizeHandle(await input.resolveHandle());
  if (handle === undefined) return { suppress: false, reason: "handle_unusable" };
  const token = new RegExp(`@${escapeRegExp(handle)}`, "giu");
  // Cheap raw pass first: most comments never name the app, and the parser is the costly step.
  if (!hasHandleToken(body, token)) return { suppress: false, reason: "no_handle" };
  // The Markdown parser is quadratic or stack-deep on adversarial input, so only a short, shallow
  // body is parsed. Anything else that names the handle is reported as unclassifiable.
  if (body.length > MAX_PILOT_PARSE_CHARS || structureTooRisky(body)) return UNCLASSIFIABLE;
  let prose: string;
  try {
    prose = proseOf(parseMarkdown(body));
  } catch {
    return UNCLASSIFIABLE;
  }
  return hasHandleToken(prose, token)
    ? { suppress: true }
    : { suppress: false, reason: "code_only" };
}

const UNCLASSIFIABLE: LinearPilotCompanionDecision = {
  suppress: false,
  reason: "unclassifiable",
  ambiguous: true,
};

function normalizeHandle(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const handle = value.startsWith("@") ? value.slice(1) : value;
  const usable =
    handle.length > 0 &&
    handle.length <= MAX_HANDLE_CHARS &&
    !/[\s@\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(handle);
  return usable ? handle : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// A letter, mark, digit, underscore, hyphen or another @ means the text is part of a larger token.
const TOKEN_CHAR_BEFORE = /[\p{L}\p{M}\p{N}_@-]$/u;
const TOKEN_CHAR_AFTER = /^[\p{L}\p{M}\p{N}_@-]/u;

function hasHandleToken(text: string, token: RegExp): boolean {
  token.lastIndex = 0;
  for (const match of text.matchAll(token)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 2), start);
    if (!TOKEN_CHAR_BEFORE.test(before) && !TOKEN_CHAR_AFTER.test(text.slice(end, end + 2))) {
      return true;
    }
  }
  return false;
}

const MAX_CONTAINER_DEPTH = 6;
const MAX_OPENER_RUN = 64;
const OPENER_RUN = new RegExp(`([\\[(*_~<!\`\\\\])\\1{${MAX_OPENER_RUN}}`, "u");
const LINE_BREAK = /\r\n|[\r\n]/u;

/** Inputs on which the Markdown parser goes superlinear or overflows its stack. */
function structureTooRisky(body: string): boolean {
  if (OPENER_RUN.test(body)) return true;
  return body.split(LINE_BREAK).some((line) => containerDepth(line) > MAX_CONTAINER_DEPTH);
}

// Block quote and list markers stacked at the start of one line. Each step eats a character.
function containerDepth(line: string): number {
  let depth = 0;
  let at = 0;
  for (;;) {
    while (line[at] === " " || line[at] === "\t") at += 1;
    const width = markerWidth(line, at);
    if (width === 0) return depth;
    depth += 1;
    at += width;
  }
}

function markerWidth(line: string, at: number): number {
  const rest = line.slice(at, at + 12);
  const marker = /^(?:>|[-+*](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/u.exec(rest);
  return marker === null ? 0 : marker[0].length;
}

function parseMarkdown(source: string): Root {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

const OPAQUE = new Set([
  "inlineCode",
  "code",
  "html",
  "image",
  "imageReference",
  "footnoteReference",
  "definition",
  "yaml",
  "toml",
]);
const BLOCK = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "footnoteDefinition",
  "thematicBreak",
]);

/** Visible prose with code, raw HTML and bare URLs replaced by a separator. Iterative: nesting depth is attacker-sized. */
function proseOf(root: Root): string {
  const out: string[] = [];
  const stack: (Nodes | string)[] = [root];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (item.type === "text") out.push(item.value);
    else if (item.type === "break") out.push("\n");
    else if (OPAQUE.has(item.type) || isBareLink(item)) out.push(" ");
    else if ("children" in item) {
      if (BLOCK.has(item.type)) stack.push("\n");
      for (const child of item.children.toReversed()) stack.push(child);
    }
  }
  return out.join("");
}

function isBareLink(node: Nodes): boolean {
  if (node.type !== "link" || node.children.length !== 1) return false;
  const [only] = node.children;
  return only?.type === "text" && (only.value === node.url || `mailto:${only.value}` === node.url);
}
