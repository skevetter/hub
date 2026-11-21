import { createHash } from "node:crypto";
import { activityTimestampMicros } from "../db/activity-key.js";
import type { ActivityRunKey, ActivityRunPageRequest } from "../db/types.js";
import type { ActivityFilters, DroppedActivityFilters } from "./activity-query.js";

type Position = NonNullable<ActivityRunPageRequest["position"]>;
type ActivityCursor = Position & { offset?: number };

const CURSOR_MAX = 512;
const MAX_DISPLAY_OFFSET = 1_000_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function activityCursorScope(
  organizationId: string,
  limit: number,
  { status, trigger, provider, range }: ActivityFilters,
): string {
  return createHash("sha256")
    .update(JSON.stringify([organizationId, limit, status, trigger, provider, range]))
    .digest("base64url");
}

export function droppedActivityCursorScope(
  organizationId: string,
  limit: number,
  { provider, source, reason, range }: DroppedActivityFilters,
): string {
  return createHash("sha256")
    .update(JSON.stringify(["dropped", organizationId, limit, provider, source, reason, range]))
    .digest("base64url");
}

export function encodeActivityCursor(
  direction: Position["direction"],
  key: ActivityRunKey,
  scope: string,
  offset?: number,
): string {
  const display = displayOffset(offset);
  const fields = [direction, key.createdAt, key.id, scope];
  return Buffer.from(
    JSON.stringify(display === undefined ? fields : [...fields, display]),
  ).toString("base64url");
}

function displayOffset(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DISPLAY_OFFSET
    ? value
    : undefined;
}

/** A cursor the reader cannot trust is no position: the page falls back to the newest runs. */
export function decodeActivityCursor(
  cursor: string | undefined,
  scope: string,
): ActivityCursor | undefined {
  if (cursor === undefined || cursor.length > CURSOR_MAX || !BASE64URL.test(cursor)) {
    return undefined;
  }
  try {
    // Node's decoder skips what it cannot read, so only the exact text the encoder writes counts.
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed) || (parsed.length !== 4 && parsed.length !== 5)) return undefined;
    const [direction, createdAt, id, cursorScope, rawOffset] = parsed as unknown[];
    if (
      cursorScope !== scope ||
      (direction !== "before" && direction !== "after") ||
      typeof createdAt !== "string" ||
      activityTimestampMicros(createdAt) === undefined ||
      typeof id !== "string" ||
      !UUID.test(id)
    ) {
      return undefined;
    }
    const offset = displayOffset(rawOffset);
    return { direction, key: { createdAt, id }, ...(offset === undefined ? {} : { offset }) };
  } catch {
    return undefined;
  }
}
