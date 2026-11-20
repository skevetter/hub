import { activityTimestampMicros } from "../db/activity-key.js";
import type { ActivityRunKey, ActivityRunPageRequest } from "../db/types.js";

export const ACTIVITY_PAGE_SIZE = 25;
export const ACTIVITY_PAGE_SIZE_MAX = 100;

type Position = NonNullable<ActivityRunPageRequest["position"]>;

const CURSOR_MAX = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function encodeActivityCursor(
  direction: Position["direction"],
  key: ActivityRunKey,
): string {
  return Buffer.from(JSON.stringify([direction, key.createdAt, key.id])).toString("base64url");
}

/** A cursor the reader cannot trust is no position: the page falls back to the newest runs. */
export function decodeActivityCursor(cursor: string | undefined): Position | undefined {
  if (cursor === undefined || cursor.length > CURSOR_MAX) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [direction, createdAt, id] = parsed as unknown[];
    if (
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
