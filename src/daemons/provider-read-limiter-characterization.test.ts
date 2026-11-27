import { describe, expect, it } from "vitest";
import { createProviderReadLimiter } from "./provider-read-limiter.js";

describe("provider read limiter boundaries", () => {
  it("rejects a pre-aborted read with its reason without cancelling a query", async () => {
    const limiter = createProviderReadLimiter();
    const reason = new Error("already cancelled");
    const calls: string[] = [];
    limiter.reconcile(["daemon"]);
    const result = limiter.schedule(
      "daemon",
      AbortSignal.abort(reason),
      async () => calls.push("read"),
      () => calls.push("cancel"),
    );
    await expect(result).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });

  it("drops an unknown daemon synchronously without starting its read", async () => {
    const limiter = createProviderReadLimiter();
    const calls: string[] = [];
    const result = limiter.schedule(
      "unknown",
      new AbortController().signal,
      async () => calls.push("read"),
      () => calls.push("cancel"),
    );
    expect(calls).toEqual(["cancel"]);
    await expect(result).rejects.toThrow("Daemon left the provider read queue.");
  });

  it("releases a rejected read and observes an abort before starting transport", async () => {
    const limiter = createProviderReadLimiter();
    const controller = new AbortController();
    const reason = new Error("aborted before transport");
    const calls: string[] = [];
    limiter.reconcile(["daemon"]);
    const result = limiter.schedule("daemon", controller.signal, async () => calls.push("read"));
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    const failure = new Error("transport failed");
    await expect(
      limiter.schedule("daemon", new AbortController().signal, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(
      limiter.schedule("daemon", new AbortController().signal, async () => "ready"),
    ).resolves.toBe("ready");
    expect(calls).toEqual([]);
  });
});
