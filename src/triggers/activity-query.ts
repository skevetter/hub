import { z } from "zod";
import { DEFAULT_PAGE_SIZE, parsePageSize } from "../components/app/page-size.js";
import type { TriggerRunRecord } from "../db/types.js";
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

export const activitySearchSchema = activityFiltersSchema.extend({
  cursor: z.string().min(1).optional().catch(undefined),
  size: z.unknown().optional().transform(parsePageSize),
});

export type ActivityFilters = z.output<typeof activityFiltersSchema>;
export type ActivitySearch = z.output<typeof activitySearchSchema>;

export function activityPageKey(organizationSlug: string, search: ActivitySearch) {
  return ["activity", organizationSlug, activityPageRequest(organizationSlug, search)] as const;
}

export function activityPageRequest(organizationSlug: string, { size, ...search }: ActivitySearch) {
  return {
    organizationSlug,
    ...search,
    limit: size ?? DEFAULT_PAGE_SIZE,
  };
}
