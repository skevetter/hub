import { describe, expect, it } from "vitest";
import {
  createGitHubNotificationProvider,
  createGitHubNotificationsSource,
  readGitHubNotificationsOptions,
  storedFailureMessage,
  type NotificationClock,
} from "./index.js";
import type { GitHubNotificationPoller, GitHubNotificationStore } from "./poller.js";

const unused = async (): Promise<never> => {
  throw new Error("the injected poller does not use the store");
};
const store: GitHubNotificationStore = {
  exclusive: unused,
  readCursor: unused,
  saveCursor: unused,
  deliver: unused,
  recordSuccess: async () => {},
  recordFailure: async () => {},
  readStatus: unused,
  countDelivered: unused,
};

/** Records what the source tells the store about each poll. */
function recordingStore() {
  const events: string[] = [];
  const recording: GitHubNotificationStore = {
    ...store,
    recordSuccess: async (now) => {
      events.push(`success ${now.toISOString()}`);
    },
    recordFailure: async (now, message) => {
      events.push(`failure ${now.toISOString()} ${message}`);
    },
  };
  return { events, recording };
}

function fakeClock(start: Date) {
  let now = start;
  let tick: (() => void) | undefined;
  let stopped = 0;
  const clock: NotificationClock = {
    now: () => now,
    every(callback) {
      tick = callback;
      return () => {
        stopped++;
      };
    },
  };
  return {
    clock,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      tick?.();
    },
    stopped: () => stopped,
  };
}

describe("notification source", () => {
  const options = (clock: NotificationClock) => ({ token: "t", pollIntervalMs: 60_000, clock });

  it("does not poll again while a poll is in flight", async () => {
    const time = fakeClock(new Date("2026-11-14T10:00:00Z"));
    const polls: Date[] = [];
    let release: (() => void) | undefined;
    const poller: GitHubNotificationPoller = {
      poll: async (now) => {
        polls.push(now);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { nextPollAt: now, started: 0 };
      },
    };
    const source = createGitHubNotificationsSource(store, options(time.clock), poller);
    await source.start(async () => {});
    time.advance(1000);
    time.advance(1000);
    expect(polls).toHaveLength(1);
    release!();
    await source.stop();
  });

  it("waits until the poller's next time before polling again", async () => {
    const time = fakeClock(new Date("2026-11-14T10:00:00Z"));
    const polls: Date[] = [];
    const poller: GitHubNotificationPoller = {
      poll: async (now) => {
        polls.push(now);
        return { nextPollAt: new Date(now.getTime() + 60_000), started: 0 };
      },
    };
    const source = createGitHubNotificationsSource(store, options(time.clock), poller);
    await source.start(async () => {});
    await Promise.resolve();
    await Promise.resolve();
    time.advance(30_000);
    await Promise.resolve();
    expect(polls).toHaveLength(1);
    time.advance(30_000);
    await Promise.resolve();
    expect(polls).toHaveLength(2);
    await source.stop();
  });

  it("backs off for one interval after a failure", async () => {
    const time = fakeClock(new Date("2026-11-14T10:00:00Z"));
    let polls = 0;
    const poller: GitHubNotificationPoller = {
      poll: async () => {
        polls++;
        throw new Error("GitHub notifications returned 401");
      },
    };
    const source = createGitHubNotificationsSource(store, options(time.clock), poller);
    await source.start(async () => {});
    await source.stop();
    expect(polls).toBe(1);
    await source.start(async () => {});
    time.advance(1000);
    await source.stop();
    expect(polls).toBe(1);
    await source.start(async () => {});
    time.advance(60_000);
    await source.stop();
    expect(polls).toBe(2);
  });

  it("records a success after each poll and nothing for a skipped one", async () => {
    const time = fakeClock(new Date("2026-11-14T10:00:00Z"));
    const { events, recording } = recordingStore();
    const results = [
      { nextPollAt: new Date("2026-11-14T10:01:00Z"), started: 0 },
      { nextPollAt: new Date("2026-11-14T10:02:00Z"), started: 0, skipped: true as const },
    ];
    const poller: GitHubNotificationPoller = { poll: async () => results.shift()! };
    const source = createGitHubNotificationsSource(recording, options(time.clock), poller);
    await source.start(async () => {});
    await source.stop();
    time.advance(60_000);
    await source.stop();
    expect(events).toEqual(["success 2026-11-14T10:00:00.000Z"]);
  });

  it("records a failure with the token removed and the message cut to 200 characters", async () => {
    const time = fakeClock(new Date("2026-11-14T10:00:00Z"));
    const { events, recording } = recordingStore();
    const poller: GitHubNotificationPoller = {
      poll: async () => {
        throw new Error(`GitHub notifications returned 401: bad token secret-token-xyz`);
      },
    };
    const source = createGitHubNotificationsSource(
      recording,
      { token: "secret-token-xyz", pollIntervalMs: 60_000, clock: time.clock },
      poller,
    );
    await source.start(async () => {});
    await source.stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(
      "failure 2026-11-14T10:00:00.000Z GitHub notifications returned 401",
    );
    expect(events[0]).not.toContain("secret-token-xyz");
    expect(storedFailureMessage(new Error("x".repeat(500)), "fake-token-0001")).toHaveLength(200);
    expect(storedFailureMessage("plain text", "fake-token-0001")).toBe("plain text");
  });

  it("keeps polling when the status write fails", async () => {
    const time = fakeClock(new Date("2026-11-14T10:00:00Z"));
    let polls = 0;
    const failing: GitHubNotificationStore = {
      ...store,
      recordSuccess: async () => {
        throw new Error("database is down");
      },
    };
    const poller: GitHubNotificationPoller = {
      poll: async (now) => {
        polls++;
        return { nextPollAt: new Date(now.getTime() + 60_000), started: 0 };
      },
    };
    const source = createGitHubNotificationsSource(failing, options(time.clock), poller);
    await source.start(async () => {});
    await source.stop();
    expect(polls).toBe(1);
    await source.start(async () => {});
    time.advance(60_000);
    await source.stop();
    expect(polls).toBe(2);
  });

  it("stops the clock and waits for the in-flight poll", async () => {
    const time = fakeClock(new Date("2026-11-14T10:00:00Z"));
    let release: (() => void) | undefined;
    const poller: GitHubNotificationPoller = {
      poll: async (now) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { nextPollAt: now, started: 0 };
      },
    };
    const source = createGitHubNotificationsSource(store, options(time.clock), poller);
    await source.start(async () => {});
    let finished = false;
    const stopping = source.stop().then(() => {
      finished = true;
      return undefined;
    });
    await Promise.resolve();
    expect(time.stopped()).toBe(1);
    expect(finished).toBe(false);
    release!();
    await stopping;
    expect(finished).toBe(true);
  });
});

describe("notification environment", () => {
  it("is off without a token", () => {
    expect(readGitHubNotificationsOptions({})).toBeUndefined();
    expect(readGitHubNotificationsOptions({ GITHUB_NOTIFICATIONS_TOKEN: "  " })).toBeUndefined();
  });

  it("defaults to 60 seconds and never goes below 30", () => {
    const token = { GITHUB_NOTIFICATIONS_TOKEN: "t" };
    expect(readGitHubNotificationsOptions(token)?.pollIntervalMs).toBe(60_000);
    expect(
      readGitHubNotificationsOptions({ ...token, GITHUB_NOTIFICATIONS_POLL_SECONDS: "10" })
        ?.pollIntervalMs,
    ).toBe(30_000);
    expect(
      readGitHubNotificationsOptions({ ...token, GITHUB_NOTIFICATIONS_POLL_SECONDS: "120" })
        ?.pollIntervalMs,
    ).toBe(120_000);
    expect(
      readGitHubNotificationsOptions({ ...token, GITHUB_NOTIFICATIONS_POLL_SECONDS: "soon" })
        ?.pollIntervalMs,
    ).toBe(60_000);
  });
});

describe("notification provider", () => {
  it("owns only github.notification and returns the stored event as context", async () => {
    const provider = createGitHubNotificationProvider();
    expect(provider.name).toBe("github_notification");
    expect(provider.eventNames).toEqual(["github.notification"]);
    expect(
      await provider.match({
        providerEventReceiptId: "receipt",
        organizationId: "org",
        projectId: "project",
        configurationRevisionId: "revision",
        source: "github.notification",
        deliveryId: "1:x",
        receivedAt: new Date(),
        payload: {},
      }),
    ).toEqual([]);
    const event = {
      github_notification: {
        repo: "o/r",
        thread_id: "1",
        subject_type: "PullRequest",
        title: "t",
        number: 1,
        html_url: null,
        reason: "mention",
        updated_at: "x",
      },
    };
    expect(
      await provider.materializeContext?.({
        executionId: "execution",
        organizationId: "org",
        projectId: "project",
        providerEventReceiptId: "receipt",
        triggerContext: { provider: "github_notification", deliveryId: "1:x", event },
      }),
    ).toBe(event);
  });
});
