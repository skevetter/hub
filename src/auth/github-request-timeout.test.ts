import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, vi } from "vitest";
import { createGitHubAuth } from "./github.js";

const TIMEOUT_MS = 40;
const REPO_ROUTE = "GET /repos/acme/app";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const appOptions = { appId: "12345", privateKey, requestTimeoutMs: TIMEOUT_MS };

function createAuth(respond: (signal?: AbortSignal) => Promise<Response>) {
  return createGitHubAuth({
    ...appOptions,
    fetch: (input, init) => {
      const signal = init?.signal ?? undefined;
      signal?.throwIfAborted();
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/access_tokens")) {
        return Promise.resolve(
          Response.json({
            token: "ghs_installation",
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
        );
      }
      return respond(signal);
    },
  });
}

function hangUntilAborted(signal?: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function causedByTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.cause instanceof DOMException &&
    error.cause.name === "TimeoutError"
  );
}

describe("GitHub request timeout", () => {
  it("times out a hung read and retries it once with a fresh timeout", async () => {
    const respond = vi.fn(hangUntilAborted);
    const octokit = await createAuth(respond).createInstallationOctokit(142);
    const startedAt = performance.now();

    await assert.rejects(octokit.request(REPO_ROUTE), causedByTimeout);

    assert.equal(respond.mock.calls.length, 2);
    assert.ok(performance.now() - startedAt < 2_500);
  });

  it("never retries a timed-out comment POST", async () => {
    const respond = vi.fn(hangUntilAborted);
    const octokit = await createAuth(respond).createInstallationOctokit(142);

    await assert.rejects(
      octokit.request("POST /repos/acme/app/issues/7/comments", { body: "hello" }),
      causedByTimeout,
    );
    assert.equal(respond.mock.calls.length, 1);
  });

  it("still works after an idle client outlives an earlier request's timeout", async () => {
    const respond = vi.fn(hangUntilAborted);
    const octokit = await createAuth(respond).createInstallationOctokit(142);
    const request = () => octokit.request(REPO_ROUTE, { request: { retries: 0 } });

    await assert.rejects(request(), causedByTimeout);
    await delay(TIMEOUT_MS);
    respond.mockResolvedValueOnce(Response.json({ id: 7 }));
    assert.deepEqual((await request()).data, { id: 7 });
    await assert.rejects(request(), causedByTimeout);

    assert.equal(respond.mock.calls.length, 3);
    assert.notEqual(respond.mock.calls[0]?.[0], respond.mock.calls[2]?.[0]);
  });

  it("uses the global fetch when no override is set and leaves a fast response intact", async () => {
    const respond = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: 7, login: "paseo[bot]" }));
    try {
      const auth = createGitHubAuth(appOptions);

      assert.deepEqual(await auth.getAppBotIdentity("paseo", "installation-token"), {
        id: 7,
        login: "paseo[bot]",
      });
      assert.ok(respond.mock.calls[0]?.[1]?.signal instanceof AbortSignal);
    } finally {
      respond.mockRestore();
    }
  });

  it("aborts the in-flight fetch as soon as the caller aborts", async () => {
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const octokit = await createAuth((signal) => {
      started.resolve(signal);
      return hangUntilAborted(signal);
    }).createInstallationOctokit(142);
    const controller = new AbortController();
    const result = assert.rejects(
      octokit.request(REPO_ROUTE, { request: { signal: controller.signal } }),
      { name: "AbortError" },
    );

    const signal = await started.promise;
    controller.abort();
    const reason: unknown = signal?.reason;

    await result;
    assert.equal(reason, controller.signal.reason);
  });

  it("leaves progress requests on their existing caller signal", async () => {
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const controller = new AbortController();
    const octokit = await createAuth((signal) => {
      started.resolve(signal);
      return hangUntilAborted(signal);
    }).createInstallationOctokit(142, { retries: "off", signal: controller.signal });
    const result = assert.rejects(
      octokit.request(REPO_ROUTE, { request: { signal: controller.signal } }),
      { message: "GitHub progress request failed" },
    );

    assert.equal(await started.promise, controller.signal);
    await delay(TIMEOUT_MS * 2);
    assert.equal(controller.signal.aborted, false);
    controller.abort();
    await result;
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])("rejects invalid timeout %s", (ms) => {
    assert.throws(
      () => createGitHubAuth({ ...appOptions, requestTimeoutMs: ms }),
      /requestTimeoutMs must be an integer/u,
    );
  });
});
