import type { GitHubNotificationsClient } from "./client.js";
import type { GitHubNotificationThread } from "./notification.js";

export const MIN_POLL_SECONDS = 30;
export const DEFAULT_POLL_SECONDS = 60;
/** Threads can become visible slightly after their updated_at, so each poll looks back a little. */
const OVERLAP_MS = 2 * 60_000;

export interface NotificationCursor {
  lastModified: string | null;
  since: Date;
  nextPollAt: Date;
}

export interface GitHubNotificationStore {
  /** Runs one poll with no other process polling. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  readCursor(): Promise<NotificationCursor | undefined>;
  saveCursor(cursor: NotificationCursor, now: Date): Promise<void>;
  /** Starts runs and saves the cursor in one transaction. Returns the number of runs started. */
  deliver(
    threads: readonly GitHubNotificationThread[],
    cursor: NotificationCursor,
    now: Date,
  ): Promise<number>;
}

export interface PollResult {
  /** When the next poll may run. */
  nextPollAt: Date;
  started: number;
}

export interface GitHubNotificationPoller {
  poll(now: Date): Promise<PollResult>;
}

export function createGitHubNotificationPoller(options: {
  client: GitHubNotificationsClient;
  store: GitHubNotificationStore;
  pollIntervalMs: number;
}): GitHubNotificationPoller {
  const { client, store } = options;
  return {
    poll: (now) =>
      store.exclusive(async () => {
        const cursor = await store.readCursor();
        // The first run starts from now. Notifications that already exist are not replayed.
        if (cursor === undefined) {
          const nextPollAt = new Date(now.getTime() + options.pollIntervalMs);
          await store.saveCursor({ lastModified: null, since: now, nextPollAt }, now);
          return { nextPollAt, started: 0 };
        }
        // Another process polled within the interval GitHub asked for.
        if (cursor.nextPollAt.getTime() > now.getTime()) {
          return { nextPollAt: cursor.nextPollAt, started: 0 };
        }
        const result = await client.list({
          since: cursor.since,
          lastModified: cursor.lastModified,
        });
        const intervalMs = Math.max(
          options.pollIntervalMs,
          (result.pollIntervalSeconds ?? 0) * 1000,
        );
        const nextPollAt = new Date(now.getTime() + intervalMs);
        if (result.status === "not_modified") {
          await store.saveCursor({ ...cursor, nextPollAt }, now);
          return { nextPollAt, started: 0 };
        }
        const started = await store.deliver(
          result.notifications,
          {
            lastModified: result.lastModified ?? cursor.lastModified,
            since: nextSince(cursor.since, result.notifications),
            nextPollAt,
          },
          now,
        );
        return { nextPollAt, started };
      }),
  };
}

function nextSince(current: Date, threads: readonly GitHubNotificationThread[]): Date {
  let next = current.getTime();
  for (const { updated_at } of threads) {
    const updated = Date.parse(updated_at);
    if (Number.isFinite(updated)) next = Math.max(next, updated - OVERLAP_MS);
  }
  return new Date(next);
}
