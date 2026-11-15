import type { TriggerProvider, TriggerSource } from "../index.js";
import { reportFailure } from "../../failures/index.js";
import {
  createGitHubNotificationsClient,
  type NotificationFetch,
  type GitHubNotificationsClient,
} from "./client.js";
import {
  createGitHubNotificationPoller,
  DEFAULT_POLL_SECONDS,
  MIN_POLL_SECONDS,
  type GitHubNotificationPoller,
  type GitHubNotificationStore,
} from "./poller.js";
import type { NotificationPayload } from "./notification.js";

export { GitHubNotificationRepository } from "./internal/repository.js";
export type { GitHubNotificationStore } from "./poller.js";

export interface GitHubNotificationsOptions {
  token: string;
  pollIntervalMs: number;
  /** Injected in tests. Production uses the global fetch. */
  fetch?: NotificationFetch;
  clock?: NotificationClock;
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
 * seconds so a typo cannot hammer the API.
 */
export function readGitHubNotificationsOptions(
  environment: Readonly<Record<string, string | undefined>>,
): GitHubNotificationsOptions | undefined {
  const token = environment["GITHUB_NOTIFICATIONS_TOKEN"]?.trim();
  if (token === undefined || token === "") return undefined;
  const configured = Number(environment["GITHUB_NOTIFICATIONS_POLL_SECONDS"]?.trim());
  const seconds = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_SECONDS;
  return { token, pollIntervalMs: Math.max(seconds, MIN_POLL_SECONDS) * 1000 };
}

export function createGitHubNotificationsSource(
  store: GitHubNotificationStore,
  options: GitHubNotificationsOptions,
  poller?: GitHubNotificationPoller,
): TriggerSource {
  const time = options.clock ?? clock;
  const client: GitHubNotificationsClient = createGitHubNotificationsClient({
    token: options.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const active =
    poller ??
    createGitHubNotificationPoller({ client, store, pollIntervalMs: options.pollIntervalMs });
  let cancel: (() => void) | undefined;
  let processing: Promise<unknown> | undefined;
  let notBefore = 0;
  const run = async (now: Date): Promise<void> => {
    try {
      notBefore = (await active.poll(now)).nextPollAt.getTime();
    } catch (error) {
      // A failed poll leaves the cursor alone; the next one picks up where it stopped.
      notBefore = now.getTime() + options.pollIntervalMs;
      reportFailure(
        error,
        { operation: "github.notifications.poll", component: "triggers", provider: "github" },
        { scrubValues: [options.token] },
      );
    }
  };
  const tick = () => {
    if (processing !== undefined) return;
    const now = time.now();
    if (now.getTime() < notBefore) return;
    processing = run(now).finally(() => {
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
      await processing;
    },
  };
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
