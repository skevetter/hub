import { createHash } from "node:crypto";
import { activityTimestampMicros } from "../db/activity-key.js";
import type { ActivityRunKey, ActivityRunPageRequest } from "../db/types.js";
import type { ActivityFilters } from "./activity-query.js";

type Position = NonNullable<ActivityRunPageRequest["position"]>;

const CURSOR_MAX = 512;
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

export function encodeActivityCursor(
  direction: Position["direction"],
  key: ActivityRunKey,
  scope: string,
): string {
  return Buffer.from(JSON.stringify([direction, key.createdAt, key.id, scope])).toString(
    "base64url",
  );
}

/** A cursor the reader cannot trust is no position: the page falls back to the newest runs. */
export function decodeActivityCursor(
  cursor: string | undefined,
  scope: string,
): Position | undefined {
  if (cursor === undefined || cursor.length > CURSOR_MAX || !BASE64URL.test(cursor)) {
    return undefined;
  }
  try {
    // Node's decoder skips what it cannot read, so only the exact text the encoder writes counts.
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 4) return undefined;
    const [direction, createdAt, id, cursorScope] = parsed as unknown[];
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
    return { direction, key: { createdAt, id } };
  } catch {
    return undefined;
  }
}
