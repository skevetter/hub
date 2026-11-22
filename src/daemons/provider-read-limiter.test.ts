import { expect, it, vi } from "vitest";
import { createProviderReadLimiter } from "./provider-read-limiter.js";

it("starts at most four of 24 reads in order and drops an aborted queued read", async () => {
  const requests = Array.from({ length: 24 }, (_, index) => ({
    id: String(index),
    controller: new AbortController(),
    work: Promise.withResolvers<void>(),
  }));
  const { schedule } = fleet(requests.map(({ id }) => id));
  const started: number[] = [];
  let running = 0;
  let peak = 0;
  const results = Promise.allSettled(
    requests.map(({ id, controller, work }, index) =>
      schedule(id, controller.signal, async () => {
        started.push(index);
        peak = Math.max(peak, ++running);
        await work.promise;
        running--;
        return index;
      }),
    ),
  );

  await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  const cancelled = requests[5]!;
  const reason = new Error("queued read removed");
  cancelled.controller.abort(reason);
  requests[0]!.work.resolve();
  requests[1]!.work.resolve();
  await expect.poll(() => started.slice(4)).toEqual([4, 6]);
  for (const { work } of requests) work.resolve();

  expect((await results)[5]).toEqual({
    status: "rejected",
    reason,
  });
  expect(started).toEqual([...requests.keys()].filter((index) => index !== 5));
  expect(peak).toBe(4);
  expect(running).toBe(0);
});

it("holds an aborted in-flight slot until its read settles", async () => {
  const ids = ["a", "b", "c", "d"];
  const { schedule } = fleet([...ids, "next"]);
  const controller = new AbortController();
  const inFlight = Promise.withResolvers<void>();
  const read = vi.fn(() => inFlight.promise);
  const running = ids.map((id) => schedule(id, controller.signal, read));
  let nextStarted = false;
  const next = schedule("next", new AbortController().signal, async () => {
    nextStarted = true;
  });

  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(4);
  controller.abort();
  await Promise.resolve();
  expect(nextStarted).toBe(false);
  inFlight.resolve();
  await Promise.all([...running, next]);
  expect(nextStarted).toBe(true);
});

it("aborts and releases unresponsive reads at 15 seconds and accepts an explicit retry", async () => {
  vi.useFakeTimers();
  try {
    const ids = ["a", "b", "c", "d"];
    const { schedule } = fleet([...ids, "next"]);
    const work = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const pending = Promise.allSettled(
      ids.map((id) =>
        schedule(id, new AbortController().signal, (signal) => {
          signals.push(signal);
          return work.promise;
        }),
      ),
    );
    const online = vi.fn(async () => "ready");
    const queued = schedule("next", new AbortController().signal, online);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(online).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(online).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const result of await pending) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { message: "This daemon did not answer." },
      });
    }
    await expect(queued).resolves.toBe("ready");
    const retry = vi.fn(async () => "retried");
    await expect(schedule("a", new AbortController().signal, retry)).resolves.toBe("retried");
    expect(retry).toHaveBeenCalledTimes(1);
    work.resolve();
  } finally {
    vi.useRealTimers();
  }
});

it("drops a queued read when its daemon disconnects", async () => {
  const { active, held, schedule, reconcile } = connectedFleet(["a", "b", "c", "d", "offline"]);
  const read = vi.fn(async () => "stale");
  const query = new AbortController();
  const dropped = Promise.allSettled([
    schedule("offline", query.signal, read, () => query.abort()),
  ]);
  reconcile(["a", "b", "c", "d"]);
  expect(query.signal.aborted).toBe(true);
  held.resolve();
  await Promise.all(active);
  expect((await dropped)[0]?.status).toBe("rejected");
  expect(read).not.toHaveBeenCalled();
});

it("uses the updated list order after a queued daemon is renamed", async () => {
  const { active, held, schedule, reconcile } = connectedFleet([
    "a",
    "b",
    "c",
    "d",
    "last",
    "next",
  ]);
  const starts: string[] = [];
  const later = schedule("last", new AbortController().signal, async () => starts.push("last"));
  const renamed = schedule("next", new AbortController().signal, async () => starts.push("next"));
  reconcile(["a", "b", "c", "d", "next", "last"]);
  held.resolve();
  await Promise.all([...active, later, renamed]);
  expect(starts).toEqual(["next", "last"]);
});

function connectedFleet(daemonIds: string[]) {
  const held = Promise.withResolvers<void>();
  const { schedule, reconcile } = fleet(daemonIds);
  const active = daemonIds
    .slice(0, 4)
    .map((id) => schedule(id, new AbortController().signal, () => held.promise));
  return { active, held, schedule, reconcile };
}

function fleet(daemonIds: readonly string[]) {
  const limiter = createProviderReadLimiter();
  limiter.reconcile(daemonIds);
  return limiter;
}
