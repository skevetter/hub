import { createHash } from "node:crypto";
import { z } from "zod";
import type { TriggerListKey, TriggerListRequest } from "../db/types.js";
import type { TriggerSearch } from "./trigger-query.js";

type Direction = NonNullable<TriggerListRequest["position"]>["direction"];
const cursorSchema = z.tuple([
  z.enum(["previous", "next"]),
  z
    .string()
    .min(1)
    .refine((name) => !name.includes("\u0000")),
  z.uuid().toLowerCase(),
  z.string(),
]);

export function triggerCursorScope(
  organizationId: string,
  size: number,
  { state, provider, q }: TriggerSearch,
) {
  return createHash("sha256")
    .update(JSON.stringify([organizationId, size, state, provider, q]))
    .digest("base64url");
}

export function encodeTriggerCursor(
  direction: Direction,
  key: TriggerListKey,
  scope: string,
): string {
  return Buffer.from(JSON.stringify([direction, key.name, key.id, scope])).toString("base64url");
}

export function decodeTriggerCursor(
  cursor: string | undefined,
  scope: string,
): TriggerListRequest["position"] {
  if (cursor === undefined || !/^[A-Za-z0-9_-]+$/u.test(cursor)) return undefined;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return undefined;
    const parsed = cursorSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) return undefined;
    const [direction, name, id, cursorScope] = parsed.data;
    return cursorScope === scope ? { direction, key: { name, id } } : undefined;
  } catch {
    return undefined;
  }
}
