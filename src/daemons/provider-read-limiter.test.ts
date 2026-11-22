import { expect, it, vi } from "vitest";
import { createProviderReadLimiter } from "./provider-read-limiter.js";

it("starts at most four of 24 reads in order and drops an aborted queued read", async () => {
  const schedule = createProviderReadLimiter();
  const requests = Array.from({ length: 24 }, () => ({
    controller: new AbortController(),
    work: Promise.withResolvers<void>(),
  }));
  const started: number[] = [];
  let running = 0;
  let peak = 0;
  const results = Promise.allSettled(
    requests.map(({ controller, work }, index) =>
      schedule(controller.signal, async () => {
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
  const schedule = createProviderReadLimiter();
  const controller = new AbortController();
  const inFlight = Promise.withResolvers<void>();
  const read = vi.fn(() => inFlight.promise);
  const running = Array.from({ length: 4 }, () => schedule(controller.signal, read));
  let nextStarted = false;
  const next = schedule(new AbortController().signal, async () => {
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
