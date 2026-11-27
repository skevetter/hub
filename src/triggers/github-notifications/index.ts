import type { TriggerProvider, TriggerSource } from "../index.js";
import { reportFailure } from "../../failures/index.js";
import { redact } from "../../logger.js";
import {
  createGitHubNotificationsClient,
  type NotificationFetch,
  type GitHubNotificationsClient,
} from "./client.js";
import {
  createGitHubNotificationPoller,
  DEFAULT_MAX_THREADS_PER_POLL,
  DEFAULT_POLL_SECONDS,
  MAX_THREADS_PER_POLL_LIMIT,
  MIN_POLL_SECONDS,
  type GitHubNotificationPoller,
  type GitHubNotificationStore,
  type PollResult,
  type NotificationProgressRequest,
} from "./poller.js";
import type { NotificationPayload } from "./notification.js";

export { GitHubNotificationRepository } from "./internal/repository.js";
export type { GitHubNotificationStore, NotificationPollStatus } from "./poller.js";

const ERROR_MESSAGE_LIMIT = 200;

/** The failure as the Triggers page shows it: no token, one short line. */
export function storedFailureMessage(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const scrubbed = redact(message, { scrubValues: [token] });
  return String(scrubbed).slice(0, ERROR_MESSAGE_LIMIT);
}

export interface GitHubNotificationsOptions {
  token: string;
  pollIntervalMs: number;
  /** Most threads delivered per poll. The rest wait for the next poll. */
  maxThreadsPerPoll?: number;
  /** Injected in tests. Production uses the global fetch. */
  fetch?: NotificationFetch;
  clock?: NotificationClock;
  onProgressRequested?: NotificationProgressRequest;
}

export interface NotificationClock {
  now(): Date;
  every(callback: () => void, milliseconds: number): () => void;
}

const clock: NotificationClock = {
  now: () => new Date(),
  every(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/**
 * The poll is off unless `GITHUB_NOTIFICATIONS_TOKEN` is set. The interval is clamped to 30
 * seconds so a typo cannot hammer the API. `GITHUB_NOTIFICATIONS_MAX_THREADS_PER_POLL` must be a
 * whole number from 1 to 100, or startup fails.
 */
export function readGitHubNotificationsOptions(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubNotificationsOptions | undefined {
  const token = environment["GITHUB_NOTIFICATIONS_TOKEN"]?.trim();
  if (token === undefined || token === "") return undefined;
  const configured = Number(environment["GITHUB_NOTIFICATIONS_POLL_SECONDS"]?.trim());
  const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_SECONDS;
  return {
    token,
    pollIntervalMs: Math.max(seconds, MIN_POLL_SECONDS) * 1000,
    maxThreadsPerPoll: readMaxThreadsPerPoll(environment),
  };
}

const MAX_THREADS_VARIABLE = "GITHUB_NOTIFICATIONS_MAX_THREADS_PER_POLL";

function readMaxThreadsPerPoll(environment: Readonly<Record<string, string | undefined>>): number {
  const raw = environment[MAX_THREADS_VARIABLE]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_THREADS_PER_POLL;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_THREADS_PER_POLL_LIMIT) {
    throw new Error(
      `${MAX_THREADS_VARIABLE} must be a whole number from 1 to ${String(MAX_THREADS_PER_POLL_LIMIT)}, got "${raw}".`,
    );
  }
  return value;
}

export function createGitHubNotificationsSource(
  store: GitHubNotificationStore,
  options: GitHubNotificationsOptions,
  poller?: GitHubNotificationPoller,
): TriggerSource {
  const time = options.clock ?? clock;
  const active = createActivePoller(store, options, poller);
  let cancel: (() => void) | undefined;
  let processing: Promise<unknown> | undefined;
  let controller: AbortController | undefined;
  let notBefore = 0;
  const run = async (now: Date, signal: AbortSignal): Promise<void> => {
    let result: PollResult;
    try {
      result = await active.poll(now, signal);
    } catch (error) {
      if (signal.aborted && error === signal.reason) return;
      // A failed poll leaves the cursor alone; the next one picks up where it stopped.
      notBefore = now.getTime() + options.pollIntervalMs;
      reportFailure(
        error,
        { operation: "github.notifications.poll", component: "triggers", provider: "github" },
        { scrubValues: [options.token] },
      );
      const message = storedFailureMessage(error, options.token);
      await rememberPollStatus(options, () => store.recordFailure(time.now(), message));
      return;
    }
    notBefore = result.nextPollAt.getTime();
    if (result.skipped !== true)
      await rememberPollStatus(options, () => store.recordSuccess(time.now()));
  };
  const tick = () => {
    if (processing !== undefined) return;
    const now = time.now();
    if (now.getTime() < notBefore) return;
    controller = new AbortController();
    processing = run(now, controller.signal).finally(() => {
      controller = undefined;
      processing = undefined;
    });
  };
  return {
    async start() {
      cancel ??= time.every(tick, 1000);
      tick();
    },
    async stop() {
      cancel?.();
      cancel = undefined;
      controller?.abort();
      await processing;
    },
  };
}

function createActivePoller(
  store: GitHubNotificationStore,
  options: GitHubNotificationsOptions,
  poller: GitHubNotificationPoller | undefined,
): GitHubNotificationPoller {
  const client: GitHubNotificationsClient = createGitHubNotificationsClient({
    token: options.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return (
    poller ??
    createGitHubNotificationPoller({
      client,
      store,
      pollIntervalMs: options.pollIntervalMs,
      ...(options.onProgressRequested === undefined
        ? {}
        : { onProgressRequested: options.onProgressRequested }),
      ...(options.maxThreadsPerPoll === undefined
        ? {}
        : { maxThreadsPerPoll: options.maxThreadsPerPoll }),
    })
  );
}

// Status is for the UI. A store error here must not look like a failed poll.
async function rememberPollStatus(
  options: GitHubNotificationsOptions,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    reportFailure(
      error,
      { operation: "github.notifications.status", component: "triggers", provider: "github" },
      { scrubValues: [options.token] },
    );
  }
}

export interface NotificationRunContext {
  provider: "github_notification";
  deliveryId: string;
  event: { github_notification: NotificationPayload };
}

/** Only the poll accepts notifications; public event intake cannot synthesize them. */
export function createGitHubNotificationProvider(): TriggerProvider<
  "github_notification",
  NotificationRunContext,
  { provider: "github_notification" }
> {
  return {
    name: "github_notification",
    eventNames: ["github.notification"],
    async match() {
      return [];
    },
    async materializeContext({ triggerContext }) {
      return triggerContext.event;
    },
  };
}
