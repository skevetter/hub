import type { GitHubNotificationsClient } from "./client.js";
import type { GitHubNotificationThread } from "./notification.js";

export const MIN_POLL_SECONDS = 30;
export const DEFAULT_POLL_SECONDS = 60;
export const DEFAULT_MAX_THREADS_PER_POLL = 5;
export const MAX_THREADS_PER_POLL_LIMIT = 100;
/** Threads can become visible slightly after their updated_at, so each poll looks back a little. */
const OVERLAP_MS = 2 * 60_000;
/** While catching up, the next poll starts just behind the last delivered thread. */
const CATCH_UP_OVERLAP_MS = 1_000;

export interface NotificationCursor {
  lastModified: string | null;
  since: Date;
  nextPollAt: Date;
}

/** What the Triggers page shows about the poll. Every field is null until it has happened. */
export interface NotificationPollStatus {
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  nextPollAt: Date | null;
}

export interface DeliveryBatch {
  /** Oldest first, so a limit always leaves the newest threads for the next poll. */
  threads: readonly GitHubNotificationThread[];
  /**
   * Most threads that may start runs. A thread another poll already delivered, or that no trigger
   * matches, starts nothing and does not count.
   */
  limit: number;
  /** Saved when every thread was handled. */
  cursor: NotificationCursor;
  /**
   * Saved when the limit stopped delivery. `lastDelivered` is the `updated_at` of the last thread
   * that started runs, or undefined when it cannot be read.
   */
  stoppedCursor(lastDelivered: Date | undefined): NotificationCursor;
}

export interface DeliveryOutcome {
  /** Runs started. */
  started: number;
  /** True when the limit left threads for the next poll. */
  deferred: boolean;
}

export interface GitHubNotificationStore {
  /** Runs one poll with no other process polling. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  readCursor(): Promise<NotificationCursor | undefined>;
  saveCursor(cursor: NotificationCursor, now: Date): Promise<void>;
  /** Starts runs and saves the cursor in one transaction. */
  deliver(batch: DeliveryBatch, now: Date): Promise<DeliveryOutcome>;
  /** A poll finished. Clears the last error. Does nothing before the first cursor exists. */
  recordSuccess(now: Date): Promise<void>;
  /** A poll failed. The message must already be free of the token. */
  recordFailure(now: Date, message: string): Promise<void>;
  readStatus(): Promise<NotificationPollStatus>;
  /** Runs started by notifications for one organization since a time, counted by receipt. */
  countDelivered(organizationId: string, since: Date): Promise<number>;
}

export interface PollResult {
  /** When the next poll may run. */
  nextPollAt: Date;
  started: number;
  /** Set when another process polled within the interval, so this call asked GitHub nothing. */
  skipped?: true;
  /** Set when the thread limit left threads for the next poll. */
  deferred?: true;
}

export interface GitHubNotificationPoller {
  poll(now: Date, signal?: AbortSignal): Promise<PollResult>;
}

export function createGitHubNotificationPoller(options: {
  client: GitHubNotificationsClient;
  store: GitHubNotificationStore;
  pollIntervalMs: number;
  /** Most threads delivered per poll. Defaults to 5. */
  maxThreadsPerPoll?: number;
}): GitHubNotificationPoller {
  const { client, store } = options;
  const limit = options.maxThreadsPerPoll ?? DEFAULT_MAX_THREADS_PER_POLL;
  return {
    poll: (now, signal) =>
      store.exclusive(async () => {
        const cursor = await store.readCursor();
        signal?.throwIfAborted();
        // The first run starts from now. Notifications that already exist are not replayed.
        if (cursor === undefined) {
          const nextPollAt = new Date(now.getTime() + options.pollIntervalMs);
          await store.saveCursor({ lastModified: null, since: now, nextPollAt }, now);
          return { nextPollAt, started: 0 };
        }
        // Another process polled within the interval GitHub asked for.
        if (cursor.nextPollAt.getTime() > now.getTime()) {
          return { nextPollAt: cursor.nextPollAt, started: 0, skipped: true };
        }
        const result = await client.list({
          since: cursor.since,
          lastModified: cursor.lastModified,
          ...(signal === undefined ? {} : { signal }),
        });
        signal?.throwIfAborted();
        const intervalMs = Math.max(
          options.pollIntervalMs,
          (result.pollIntervalSeconds ?? 0) * 1000,
        );
        const nextPollAt = new Date(now.getTime() + intervalMs);
        if (result.status === "not_modified") {
          await store.saveCursor({ ...cursor, nextPollAt }, now);
          return { nextPollAt, started: 0 };
        }
        const threads = oldestFirst(result.notifications);
        const outcome = await store.deliver(
          {
            threads,
            limit,
            cursor: {
              lastModified: result.lastModified ?? cursor.lastModified,
              since: nextSince(cursor.since, threads),
              nextPollAt,
            },
            // No Last-Modified: the next poll must not answer 304 and skip the threads left over.
            stoppedCursor: (lastDelivered) => ({
              lastModified: null,
              since: catchUpSince(cursor.since, lastDelivered),
              nextPollAt,
            }),
          },
          now,
        );
        return {
          nextPollAt,
          started: outcome.started,
          ...(outcome.deferred ? { deferred: true as const } : {}),
        };
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

function updatedAt(thread: GitHubNotificationThread): number {
  const updated = Date.parse(thread.updated_at);
  return Number.isFinite(updated) ? updated : Number.POSITIVE_INFINITY;
}

/** Ties break on the thread id so the order does not depend on what GitHub returned. */
function oldestFirst(threads: readonly GitHubNotificationThread[]): GitHubNotificationThread[] {
  return [...threads].sort(
    (left, right) => updatedAt(left) - updatedAt(right) || compareText(left.id, right.id),
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function catchUpSince(current: Date, lastDelivered: Date | undefined): Date {
  if (lastDelivered === undefined) return current;
  return new Date(Math.max(current.getTime(), lastDelivered.getTime() - CATCH_UP_OVERLAP_MS));
}
