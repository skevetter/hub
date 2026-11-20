import { ACTIVITY_PAGE_SIZE } from "./activity-cursor.js";

export function activityPageKey(organizationSlug: string, cursor: string | undefined) {
  return ["activity", organizationSlug, cursor ?? null] as const;
}

export function activityPageRequest(organizationSlug: string, cursor: string | undefined) {
  return {
    organizationSlug,
    limit: ACTIVITY_PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  };
}
