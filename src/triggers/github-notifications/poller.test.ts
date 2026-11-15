import { describe, expect, it } from "vitest";
import type { GitHubNotificationsClient, ListNotificationsResult } from "./client.js";
import {
  createGitHubNotificationPoller,
  type GitHubNotificationStore,
  type NotificationCursor,
} from "./poller.js";
import type { GitHubNotificationThread } from "./notification.js";
import { thread } from "./test-fixture.js";

const START = new Date("2026-11-14T10:00:00Z");

function setup(results: ListNotificationsResult[], initial?: NotificationCursor) {
  let cursor = initial;
  const delivered: { threads: readonly GitHubNotificationThread[]; cursor: NotificationCursor }[] =
    [];
  const requests: { since: Date; lastModified: string | null }[] = [];
  const store: GitHubNotificationStore = {
    exclusive: (operation) => operation(),
    readCursor: async () => cursor,
    saveCursor: async (next) => {
      cursor = next;
    },
    deliver: async (threads, next) => {
      delivered.push({ threads, cursor: next });
      cursor = next;
      return threads.length;
    },
    recordSuccess: async () => {},
    recordFailure: async () => {},
    readStatus: async () => ({
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      nextPollAt: null,
    }),
    countDelivered: async () => 0,
  };
  const client: GitHubNotificationsClient = {
    list: async (input) => {
      requests.push(input);
      const next = results.shift();
      if (next === undefined) throw new Error("unexpected poll");
      return next;
    },
  };
  const poller = createGitHubNotificationPoller({ client, store, pollIntervalMs: 60_000 });
  return { poller, requests, delivered, cursor: () => cursor };
}

describe("notification poller", () => {
  it("sets the cursor to now on the first run and delivers nothing", async () => {
    const { poller, requests, cursor } = setup([]);
    const result = await poller.poll(START);
    expect(result).toEqual({ nextPollAt: new Date(START.getTime() + 60_000), started: 0 });
    expect(requests).toEqual([]);
    expect(cursor()).toMatchObject({ since: START, lastModified: null });
  });

  it("delivers new threads and moves since to just behind the newest update", async () => {
    const { poller, requests, delivered } = setup(
      [
        {
          status: "ok",
          notifications: [thread({ updated_at: "2026-11-14T10:05:00Z" })],
          lastModified: "stamp-1",
          pollIntervalSeconds: undefined,
        },
      ],
      { since: START, lastModified: "stamp-0", nextPollAt: START },
    );
    const now = new Date("2026-11-14T10:06:00Z");
    const result = await poller.poll(now);
    expect(result.started).toBe(1);
    expect(requests).toEqual([{ since: START, lastModified: "stamp-0" }]);
    expect(delivered[0]!.cursor).toEqual({
      since: new Date("2026-11-14T10:03:00Z"),
      lastModified: "stamp-1",
      nextPollAt: new Date(now.getTime() + 60_000),
    });
  });

  it("keeps the cursor on 304 and obeys a longer X-Poll-Interval", async () => {
    const { poller, delivered, cursor } = setup(
      [{ status: "not_modified", pollIntervalSeconds: 300 }],
      { since: START, lastModified: "stamp-0", nextPollAt: START },
    );
    const result = await poller.poll(START);
    expect(result).toEqual({ nextPollAt: new Date(START.getTime() + 300_000), started: 0 });
    expect(delivered).toEqual([]);
    expect(cursor()).toMatchObject({ since: START, lastModified: "stamp-0" });
  });

  it("never polls faster than the configured interval", async () => {
    const { poller } = setup([{ status: "not_modified", pollIntervalSeconds: 10 }], {
      since: START,
      lastModified: null,
      nextPollAt: START,
    });
    expect((await poller.poll(START)).nextPollAt).toEqual(new Date(START.getTime() + 60_000));
  });

  it("skips when another process polled inside the interval", async () => {
    const due = new Date(START.getTime() + 30_000);
    const { poller, requests } = setup([], { since: START, lastModified: null, nextPollAt: due });
    expect(await poller.poll(START)).toEqual({ nextPollAt: due, started: 0, skipped: true });
    expect(requests).toEqual([]);
  });

  it("leaves the cursor untouched when the client fails", async () => {
    const { poller, cursor } = setup([], {
      since: START,
      lastModified: "stamp-0",
      nextPollAt: START,
    });
    await expect(poller.poll(START)).rejects.toThrow("unexpected poll");
    expect(cursor()).toEqual({ since: START, lastModified: "stamp-0", nextPollAt: START });
  });
});
