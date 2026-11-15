import type { NotificationPollStatus } from "./github-notifications/poller.js";

export type NotificationState = "polling" | "error" | "off" | "starting" | "stalled";

export interface NotificationStatusView {
  state: NotificationState;
  lastSuccessAt: string | null;
  nextPollAt: string | null;
  lastError: string | null;
  delivered24h: number;
  /** The configured seconds between polls. Null while polling is off. */
  pollIntervalSeconds: number | null;
  /** Whether the Hub has a token. The token itself never leaves the server. */
  tokenConfigured: boolean;
}

/** A poll more than this far past its due time means the loop is not running. */
const STALLED_AFTER_MS = 5 * 60_000;

export function notificationState(input: {
  enabled: boolean;
  status: NotificationPollStatus;
  now: Date;
}): NotificationState {
  const { enabled, status, now } = input;
  if (!enabled) return "off";
  const { lastSuccessAt, lastError, lastErrorAt, nextPollAt } = status;
  if (lastError !== null) {
    const newer =
      lastSuccessAt === null ||
      lastErrorAt === null ||
      lastErrorAt.getTime() > lastSuccessAt.getTime();
    if (newer) return "error";
  }
  if (lastSuccessAt === null) return "starting";
  if (nextPollAt !== null && now.getTime() - nextPollAt.getTime() > STALLED_AFTER_MS) {
    return "stalled";
  }
  return "polling";
}

export function notificationStatusView(input: {
  enabled: boolean;
  /** The configured seconds between polls. */
  pollIntervalSeconds?: number;
  status: NotificationPollStatus;
  delivered24h: number;
  now: Date;
}): NotificationStatusView {
  const { status } = input;
  return {
    state: notificationState(input),
    lastSuccessAt: status.lastSuccessAt?.toISOString() ?? null,
    nextPollAt: status.nextPollAt?.toISOString() ?? null,
    lastError: status.lastError,
    delivered24h: input.delivered24h,
    pollIntervalSeconds: input.enabled ? (input.pollIntervalSeconds ?? null) : null,
    tokenConfigured: input.enabled,
  };
}
