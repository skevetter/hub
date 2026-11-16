import { describe, expect, it } from "vitest";
import type { GitHubNotificationsClient, ListNotificationsResult } from "./client.js";
import {
  createGitHubNotificationPoller,
  type DeliveryBatch,
  type GitHubNotificationStore,
  type NotificationCursor,
} from "./poller.js";
import type { GitHubNotificationThread } from "./notification.js";
import { thread } from "./test-fixture.js";

const START = new Date("2026-11-14T10:00:00Z");

/**
 * Follows the store contract: a thread already delivered starts nothing and does not count, and
 * the limit stops delivery at the first new thread past it.
 */
function setup(
  results: ListNotificationsResult[],
  initial?: NotificationCursor,
  maxThreadsPerPoll?: number,
) {
  let cursor = initial;
  const seen = new Set<string>();
  const delivered: { threads: readonly GitHubNotificationThread[]; cursor: NotificationCursor }[] =
    [];
  const requests: { since: Date; lastModified: string | null }[] = [];
  const store: GitHubNotificationStore = {
    exclusive: (operation) => operation(),
    readCursor: async () => cursor,
    saveCursor: async (next) => {
      cursor = next;
    },
    deliver: async (batch: DeliveryBatch) => {
      const started: GitHubNotificationThread[] = [];
      let deferred = false;
      for (const candidate of batch.threads) {
        const key = `${candidate.id}:${candidate.updated_at}`;
        if (seen.has(key)) continue;
        if (started.length >= batch.limit) {
          deferred = true;
          break;
        }
        seen.add(key);
        started.push(candidate);
      }
      const last = started.at(-1);
      const next = deferred
        ? batch.stoppedCursor(last === undefined ? undefined : new Date(last.updated_at))
        : batch.cursor;
      delivered.push({ threads: started, cursor: next });
      cursor = next;
      return { started: started.length, deferred };
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
  const poller = createGitHubNotificationPoller({
    client,
    store,
    pollIntervalMs: 60_000,
    ...(maxThreadsPerPoll === undefined ? {} : { maxThreadsPerPoll }),
  });
  return { poller, client, requests, delivered, cursor: () => cursor };
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

  it("forwards cancellation and leaves pre-cancelled polls untouched", async () => {
    const initial = { since: START, lastModified: "stamp-0", nextPollAt: START };
    const { poller, requests, cursor, delivered } = setup(
      [{ status: "not_modified", pollIntervalSeconds: undefined }],
      initial,
    );
    const controller = new AbortController();
    await poller.poll(START, controller.signal);
    expect(requests).toEqual([
      { since: START, lastModified: "stamp-0", signal: controller.signal },
    ]);
    expect(delivered).toEqual([]);

    const cancelled = setup([], initial);
    controller.abort();
    await expect(cancelled.poller.poll(START, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
    expect(cancelled.requests).toEqual([]);
    expect(cancelled.cursor()).toEqual(initial);
    expect(cursor()?.since).toEqual(START);
  });

  it("does not deliver results received after cancellation", async () => {
    const initial = { since: START, lastModified: "stamp-0", nextPollAt: START };
    const { poller, client, cursor, delivered } = setup([], initial);
    const requested = Promise.withResolvers<void>();
    const listing = Promise.withResolvers<ListNotificationsResult>();
    client.list = () => {
      requested.resolve();
      return listing.promise;
    };
    const controller = new AbortController();
    const polling = poller.poll(START, controller.signal);
    const rejected = expect(polling).rejects.toMatchObject({ name: "AbortError" });
    await requested.promise;
    controller.abort();
    listing.resolve({
      status: "ok",
      notifications: [thread()],
      lastModified: "stamp-1",
      pollIntervalSeconds: undefined,
    });
    await rejected;
    expect(cursor()).toEqual(initial);
    expect(delivered).toEqual([]);
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

const idsOf = (threads: readonly GitHubNotificationThread[]) => threads.map(({ id }) => id);

describe("notification poller thread limit", () => {
  const at = (minute: number, id = String(minute)) =>
    thread({ id, updated_at: `2026-11-14T10:${String(minute).padStart(2, "0")}:00Z` });
  const due: NotificationCursor = { since: START, lastModified: "stamp-0", nextPollAt: START };
  const ok = (notifications: GitHubNotificationThread[], lastModified: string, poll?: number) =>
    ({
      status: "ok",
      notifications,
      lastModified,
      pollIntervalSeconds: poll,
    }) satisfies ListNotificationsResult;

  it("delivers everything and keeps the usual cursor when the threads fit under the limit", async () => {
    const { poller, delivered } = setup([ok([at(1), at(2), at(3)], "stamp-1")], due, 3);
    const now = new Date("2026-11-14T10:06:00Z");
    expect(await poller.poll(now)).toEqual({
      nextPollAt: new Date(now.getTime() + 60_000),
      started: 3,
    });
    expect(delivered[0]!.cursor).toEqual({
      since: new Date("2026-11-14T10:01:00Z"),
      lastModified: "stamp-1",
      nextPollAt: new Date(now.getTime() + 60_000),
    });
  });

  it("defaults to 5 threads per poll", async () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((minute) => at(minute));
    const { poller, delivered } = setup([ok(threads, "stamp-1")], due);
    expect(await poller.poll(START)).toMatchObject({ started: 5, deferred: true });
    expect(idsOf(delivered[0]!.threads)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("delivers the oldest threads first, moves since to just behind the last one, and drops Last-Modified", async () => {
    const shuffled = [at(5), at(2), at(4), at(1), at(3)];
    const { poller, delivered, cursor } = setup([ok(shuffled, "stamp-1")], due, 2);
    const now = new Date("2026-11-14T10:10:00Z");
    const result = await poller.poll(now);
    expect(result).toEqual({
      nextPollAt: new Date(now.getTime() + 60_000),
      started: 2,
      deferred: true,
    });
    expect(idsOf(delivered[0]!.threads)).toEqual(["1", "2"]);
    expect(cursor()).toEqual({
      since: new Date("2026-11-14T10:01:59Z"),
      lastModified: null,
      nextPollAt: new Date(now.getTime() + 60_000),
    });
  });

  it("breaks ties on the thread id so the order is stable", async () => {
    const { poller, delivered } = setup(
      [ok([at(1, "c"), at(1, "a"), at(1, "b")], "stamp-1")],
      due,
      2,
    );
    await poller.poll(START);
    expect(idsOf(delivered[0]!.threads)).toEqual(["a", "b"]);
  });

  it("delivers the rest on the next polls, each thread exactly once", async () => {
    const all = [1, 2, 3, 4, 5].map((minute) => at(minute));
    const { poller, delivered, requests } = setup(
      [
        ok(all, "stamp-1"),
        // The overlap brings back the last delivered thread; GitHub also returns the rest.
        ok(all.slice(1), "stamp-2"),
        ok(all.slice(3), "stamp-3"),
      ],
      due,
      2,
    );
    const first = await poller.poll(new Date("2026-11-14T10:10:00Z"));
    const second = await poller.poll(first.nextPollAt);
    const third = await poller.poll(second.nextPollAt);
    expect([first.deferred, second.deferred, third.deferred]).toEqual([true, true, undefined]);
    const ids = delivered.map(({ threads }) => idsOf(threads));
    expect(ids).toEqual([["1", "2"], ["3", "4"], ["5"]]);
    // The second poll asks from just behind thread 2 and sends no If-Modified-Since.
    expect(requests[1]).toEqual({ since: new Date("2026-11-14T10:01:59Z"), lastModified: null });
    expect(requests[2]).toEqual({ since: new Date("2026-11-14T10:03:59Z"), lastModified: null });
  });

  it("keeps the wait at the larger of the configured interval and X-Poll-Interval", async () => {
    const longer = setup([ok([at(1), at(2)], "stamp-1", 300)], due, 1);
    expect((await longer.poller.poll(START)).nextPollAt).toEqual(
      new Date(START.getTime() + 300_000),
    );
    const shorter = setup([ok([at(1), at(2)], "stamp-1", 10)], due, 1);
    expect((await shorter.poller.poll(START)).nextPollAt).toEqual(
      new Date(START.getTime() + 60_000),
    );
  });

  it("never moves since backwards", async () => {
    const early = { ...due, since: new Date("2026-11-14T10:30:00Z") };
    const { poller, cursor } = setup([ok([at(1), at(2)], "stamp-1")], early, 1);
    await poller.poll(START);
    expect(cursor()!.since).toEqual(early.since);
  });
});
