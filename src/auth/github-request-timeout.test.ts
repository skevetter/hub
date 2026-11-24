import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, vi } from "vitest";
import { createGitHubReactionClient } from "../triggers/github/provider.js";
import { createGitHubAuth } from "./github.js";

const TIMEOUT_MS = 40;
const REPO_ROUTE = "GET /repos/acme/app";
const COMMENT_ROUTE = "POST /repos/acme/app/issues/7/comments";
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

function stalledBody(
  signal: AbortSignal | undefined,
  status: number,
  onRead?: () => void,
): Promise<Response> {
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("Body read aborted", "AbortError")),
          { once: true },
        );
      },
      pull() {
        onRead?.();
      },
    },
    { highWaterMark: 0 },
  );
  return Promise.resolve(
    new Response(body, { status, headers: { "content-type": "application/json" } }),
  );
}

function isBodyTimeout(error: unknown): boolean {
  return (
    causedByTimeout(error) &&
    error instanceof Error &&
    error.name === "HttpError" &&
    Reflect.get(error, "status") === 500
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

    await assert.rejects(octokit.request(COMMENT_ROUTE, { body: "hello" }), causedByTimeout);
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

describe("GitHub response body timeout", () => {
  it("rejects a stalled GET body and retries it once with a fresh timeout", async () => {
    const respond = vi.fn((signal?: AbortSignal) => stalledBody(signal, 200));
    const octokit = await createAuth(respond).createInstallationOctokit(142);
    const startedAt = performance.now();

    await assert.rejects(octokit.request(REPO_ROUTE), isBodyTimeout);

    assert.equal(respond.mock.calls.length, 2);
    assert.notEqual(respond.mock.calls[0]?.[0], respond.mock.calls[1]?.[0]);
    assert.ok(performance.now() - startedAt < 2_500);
  }, 5_000);

  it("rejects a stalled comment POST body without retrying", async () => {
    const respond = vi.fn((signal?: AbortSignal) => stalledBody(signal, 201));
    const octokit = await createAuth(respond).createInstallationOctokit(142);

    await assert.rejects(octokit.request(COMMENT_ROUTE, { body: "hello" }), isBodyTimeout);
    assert.equal(respond.mock.calls.length, 1);
  }, 5_000);

  it("rejects a stalled reaction response instead of returning an undefined ID", async () => {
    const respond = vi.fn((signal?: AbortSignal) => stalledBody(signal, 201));
    const reactions = createGitHubReactionClient(createAuth(respond));

    await assert.rejects(
      reactions.createReaction({
        installationId: 142,
        repo: "acme/app",
        subject: { kind: "item", issueNumber: 7 },
        content: "eyes",
      }),
      isBodyTimeout,
    );
    assert.equal(respond.mock.calls.length, 2);
  }, 5_000);

  it("returns a fast 201 JSON response with its headers and URL", async () => {
    const headers = { "x-ratelimit-remaining": "42", "retry-after": "2" };
    const url = "https://api.github.com/repos/acme/app/issues/7/comments";
    const upstream = Response.json({ id: 7 }, { status: 201, statusText: "Created", headers });
    Object.defineProperty(upstream, "url", { value: url });
    const octokit = await createAuth(() => Promise.resolve(upstream)).createInstallationOctokit(
      142,
    );

    const response = await octokit.request(COMMENT_ROUTE, { body: "hello" });

    assert.equal(response.status, 201);
    assert.deepEqual(response.data, { id: 7 });
    assert.partialDeepStrictEqual(response.headers, headers);
    assert.equal(response.url, url);
  });

  it.each([
    ["DELETE /installation/token", 204],
    ["DELETE /installation/token", 205],
    ["HEAD /repos/acme/app", 200],
  ])("preserves the empty response for %s (%i)", async (route, status) => {
    const octokit = await createAuth(() =>
      Promise.resolve(new Response(null, { status })),
    ).createInstallationOctokit(142);

    const response = await octokit.request(route);

    assert.equal(response.status, status);
    assert.equal(response.data, "");
  });

  it("keeps a stalled error response's status and fails within the timeout", async () => {
    const respond = vi.fn((signal?: AbortSignal) => stalledBody(signal, 429));
    const octokit = await createAuth(respond).createInstallationOctokit(142);
    const startedAt = performance.now();

    await assert.rejects(octokit.request(REPO_ROUTE), { status: 429 });

    assert.equal(respond.mock.calls.length, 1);
    assert.ok(performance.now() - startedAt < 1_000);
  }, 5_000);

  it("surfaces a caller abort during the body read as AbortError", async () => {
    const reading = Promise.withResolvers<void>();
    const octokit = await createAuth((signal) =>
      stalledBody(signal, 200, reading.resolve),
    ).createInstallationOctokit(142);
    const controller = new AbortController();
    const result = assert.rejects(
      octokit.request(REPO_ROUTE, { request: { signal: controller.signal } }),
      { name: "AbortError" },
    );

    await reading.promise;
    controller.abort();
    await result;
  }, 5_000);
});
