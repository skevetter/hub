import { afterEach, describe, expect, it, vi } from "vitest";
import { startSlackSocketFixture } from "../../test-utils/slack-socket-fixture.js";
import { createSlackSocketInstallationVerifier } from "./installation.js";

function restoreTimers(): void {
  vi.clearAllTimers();
  vi.useRealTimers();
}

afterEach(restoreTimers);

function pauseAuthTest() {
  const received = Promise.withResolvers<AbortSignal>();
  const realFetch = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (typeof input !== "string" || !input.endsWith("/auth.test")) return realFetch(input, init);
    const signal = init?.signal;
    if (signal === null || signal === undefined) throw new Error("missing auth request signal");
    received.resolve(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("fixture fetch aborted")), {
        once: true,
      });
    });
  });
  return { received: received.promise, restore: () => fetch.mockRestore() };
}

describe("Slack socket verification timeout", () => {
  it("maps an aborted auth.test request to a verification timeout", async () => {
    const slack = await startSlackSocketFixture();
    const auth = pauseAuthTest();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const verifier = createSlackSocketInstallationVerifier({
        apiBaseUrl: slack.apiBaseUrl,
        timeoutMs: 1_000,
      });
      const result = verifier.verify("fixture-app", "fixture-bot");
      void result.catch(() => undefined);
      const signal = await Promise.race([
        auth.received,
        result.then(() => {
          throw new Error("auth.test was not called");
        }),
      ]);
      vi.advanceTimersByTime(999);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      await expect(result).rejects.toThrow("timeout");
      expect(signal.aborted).toBe(true);
      expect(slack.authorizations).toEqual(["Bearer fixture-app"]);
    } finally {
      restoreTimers();
      auth.restore();
      await slack.close();
    }
  });
});
