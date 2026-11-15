import type { NotificationPayload } from "./notification.js";

export interface NotificationFilters {
  repo?: string | undefined;
  reason?: string | undefined;
  contains?: string | undefined;
  pattern?: string | undefined;
}

/** Every filter that is set must match. `pattern` is a title prefix, as it is for other sources. */
export function matchesNotification(
  notification: NotificationPayload,
  filters: NotificationFilters | undefined,
): boolean {
  if (filters === undefined) return true;
  const { repo, reason, contains, pattern } = filters;
  // GitHub treats repository names as case-insensitive.
  if (repo !== undefined && repo.toLowerCase() !== notification.repo.toLowerCase()) return false;
  if (reason !== undefined && reason !== notification.reason) return false;
  if (pattern !== undefined && !notification.title.startsWith(pattern)) return false;
  if (contains !== undefined && !notification.title.includes(contains)) return false;
  return true;
}
