// Synthetic pilot webhook bodies built from the pinned SDL excerpts. No real workspace data.
import type { LinearPilotConfig } from "../config.js";
import type { LinearPilotInstallation } from "../intake.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface JsonObject {
  [key: string]: Json;
}

export const PILOT_CONFIG: LinearPilotConfig = {
  hubOrganizationId: "hub-org-7f3a",
  linearOrganizationId: "lin-org-91c2",
  allowedHumanId: "human-owner-4d18",
  profileId: "b6e0a1c4-7d2e-4f3b-8a95-0c1d2e3f4a5b",
};

export const INSTALLATION: LinearPilotInstallation = {
  organizationId: PILOT_CONFIG.hubOrganizationId,
  workspaceId: PILOT_CONFIG.linearOrganizationId,
  applicationId: "app-record-52ab",
  appUserId: "app-user-e077",
  oauthClientId: "client-3b9d",
};

const STAMP = "2026-11-21T10:00:00.000Z";
const SESSION = "session-c0de";
const ISSUE = "issue-a1b2";
const TEAM = "team-77e1";
const COMMENT = "comment-5e5e";

function sessionBlock(): JsonObject {
  return {
    id: SESSION,
    type: "AgentSession",
    status: "pending",
    appUserId: INSTALLATION.appUserId,
    organizationId: PILOT_CONFIG.linearOrganizationId,
    creatorId: PILOT_CONFIG.allowedHumanId,
    creator: { id: PILOT_CONFIG.allowedHumanId, name: "Synthetic Owner" },
    commentId: COMMENT,
    comment: {
      id: COMMENT,
      body: "@paseo check the flaky export",
      issueId: ISSUE,
      userId: PILOT_CONFIG.allowedHumanId,
    },
    sourceCommentId: null,
    issueId: ISSUE,
    issue: { id: ISSUE, teamId: TEAM },
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

export function createdPayload(): JsonObject {
  return {
    type: "AgentSessionEvent",
    action: "created",
    appUserId: INSTALLATION.appUserId,
    oauthClientId: INSTALLATION.oauthClientId,
    organizationId: PILOT_CONFIG.linearOrganizationId,
    createdAt: STAMP,
    webhookId: "webhook-1f1f",
    webhookTimestamp: 1_800_000_000_000,
    promptContext: "<issue>synthetic</issue>",
    guidance: [{ body: "synthetic guidance" }],
    previousComments: [{ id: "comment-0000", body: "earlier", userId: "human-other-0001" }],
    agentSession: sessionBlock(),
  };
}

export function promptedPayload(): JsonObject {
  const base = createdPayload();
  return {
    ...base,
    action: "prompted",
    promptContext: null,
    agentSession: { ...sessionBlock(), status: "active" },
    agentActivity: {
      id: "activity-9a9a",
      agentSessionId: SESSION,
      userId: PILOT_CONFIG.allowedHumanId,
      user: { id: PILOT_CONFIG.allowedHumanId, name: "Synthetic Owner" },
      content: { type: "prompt", body: "also cover the retry path" },
      signal: null,
      createdAt: STAMP,
      updatedAt: STAMP,
    },
  };
}

export function objectAt(node: JsonObject, key: string): JsonObject {
  const child = node[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    throw new Error(`fixture has no object at ${key}`);
  }
  return child;
}

export function stopPayload(): JsonObject {
  const base = promptedPayload();
  return {
    ...base,
    agentActivity: {
      ...objectAt(base, "agentActivity"),
      id: "activity-5709",
      content: { type: "prompt" },
      signal: "stop",
    },
  };
}

export function clone<T extends Json>(value: T): T {
  return structuredClone(value);
}

/** Copy of `body` with the value at `path` replaced, or removed when `value` is undefined. */
export function mutate(body: JsonObject, path: string[], value: Json | undefined): JsonObject {
  const copy = clone(body);
  let node: JsonObject = copy;
  for (const key of path.slice(0, -1)) node = objectAt(node, key);
  const last = path.at(-1);
  if (last === undefined) throw new Error("empty path");
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}

/** mulberry32: replayable from a printed seed. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function pick<T>(next: () => number, items: readonly T[]): T {
  const index = Math.floor(next() * items.length);
  for (const [i, item] of items.entries()) if (i === index) return item;
  throw new Error("empty choice list");
}

const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";

export function randomId(next: () => number, prefix: string): string {
  const length = 1 + Math.floor(next() * 40);
  let out = prefix;
  for (let i = 0; i < length; i += 1) out += ID_CHARS[Math.floor(next() * ID_CHARS.length)];
  return out;
}

export const REPLAY_SEED = Number(process.env["PILOT_FUZZ_SEED"] ?? 20_261_121);
