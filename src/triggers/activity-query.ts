import { z } from "zod";
import { DEFAULT_PAGE_SIZE, parsePageSize } from "../components/app/page-size.js";
import type { TriggerRunRecord } from "../db/types.js";
import { DROP_REASON_FILTERS } from "./drop-reason.js";
import { LIST_PROVIDERS } from "./list-providers.js";

export const ACTIVITY_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "canceled",
  "rejected",
] as const satisfies readonly TriggerRunRecord["status"][];
export const ACTIVITY_RANGES = ["24h", "7d", "30d"] as const;
export const ACTIVITY_RANGE_LABELS: Record<(typeof ACTIVITY_RANGES)[number], string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export const activityFiltersSchema = z.object({
  status: z.enum(ACTIVITY_STATUSES).optional().catch(undefined),
  trigger: z.uuid().toLowerCase().optional().catch(undefined),
  provider: z.enum(LIST_PROVIDERS).optional().catch(undefined),
  range: z.enum(ACTIVITY_RANGES).optional().catch(undefined),
});

export const DROPPED_SOURCE_MAX = 100;
export const droppedActivityFiltersSchema = activityFiltersSchema
  .pick({ provider: true, range: true })
  .extend({
    reason: z.enum(DROP_REASON_FILTERS).optional().catch(undefined),
    source: z
      .string()
      .trim()
      .min(1)
      .max(DROPPED_SOURCE_MAX)
      .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u)
      .optional()
      .catch(undefined),
  });

export const activitySearchSchema = activityFiltersSchema
  .extend(droppedActivityFiltersSchema.shape)
  .extend({
    view: z.literal("dropped").optional().catch(undefined),
    cursor: z.string().min(1).optional().catch(undefined),
    size: z.unknown().optional().transform(parsePageSize),
  })
  .transform(
    ({ view, reason, source, status, trigger, ...search }): ActivitySearch =>
      view === "dropped" ? { ...search, view, reason, source } : { ...search, status, trigger },
  );

export type ActivityFilters = z.output<typeof activityFiltersSchema>;
export type DroppedActivityFilters = z.output<typeof droppedActivityFiltersSchema>;
export type ActivitySearch = ActivityFilters &
  DroppedActivityFilters & {
    view?: "dropped" | undefined;
    cursor?: string | undefined;
    size?: ReturnType<typeof parsePageSize>;
  };

export function activityPageKey(organizationSlug: string, search: ActivitySearch) {
  return ["activity", organizationSlug, activityPageRequest(organizationSlug, search)] as const;
}

export function activityPageRequest(organizationSlug: string, search: ActivitySearch) {
  const { size, cursor } = search;
  return {
    organizationSlug,
    ...activityFiltersSchema.parse(search),
    cursor,
    limit: size ?? DEFAULT_PAGE_SIZE,
  };
}

export function droppedActivityPageRequest(organizationSlug: string, search: ActivitySearch) {
  const { size, cursor } = search;
  return {
    organizationSlug,
    ...droppedActivityFiltersSchema.parse(search),
    cursor,
    limit: size ?? DEFAULT_PAGE_SIZE,
  };
}

export function droppedActivityPageKey(organizationSlug: string, search: ActivitySearch) {
  return [
    "dropped-activity",
    organizationSlug,
    droppedActivityPageRequest(organizationSlug, search),
  ] as const;
}
