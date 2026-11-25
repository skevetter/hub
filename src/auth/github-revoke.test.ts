import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import { createGitHubAuth } from "./github.js";
import { TOKEN_REVOKE_BUDGET_MS, TOKEN_REVOKE_WATCHDOG_MS } from "./revocation-budget.js";

const TOKEN = "ghs_revoke_test_secret";
const WARNING = "installation token revocation failed; token stays valid until it expires";

function harness(
  fetch: typeof globalThis.fetch,
  options: Partial<Parameters<typeof createGitHubAuth>[0]> = {},
) {
  const request = vi.fn(fetch);
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const auth = createGitHubAuth({
    appId: "12345",
    privateKey: "unused",
    fetch: request,
    octokitPlugins: { throttle: false },
    revokeRetryDelaysMs: [1, 2],
    ...options,
  });
  return { revoke: () => auth.revokeInstallationToken(TOKEN), request, warn };
}

function githubError(status: number) {
  return Response.json({ message: `GitHub error for ${TOKEN}` }, { status });
}

function fakeTimeout(ms: number): AbortSignal {
  const deadline = new AbortController();
  setTimeout(() => deadline.abort(new DOMException("budget expired", "TimeoutError")), ms);
  return deadline.signal;
}

const hangUntilAborted: typeof fetch = (_input, init) => {
  const signal = init?.signal;
  const pending = Promise.withResolvers<Response>();
  signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
  return pending.promise;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GitHub installation token revocation", () => {
  it("deletes the token on the first try", async () => {
    const { revoke, request, warn } = harness(async () => new Response(null, { status: 204 }));

    await revoke();

    assert.equal(request.mock.calls.length, 1);
    const [input, init] = request.mock.calls[0]!;
    assert.equal(
      new URL(input instanceof Request ? input.url : input).pathname,
      "/installation/token",
    );
    assert.equal(init?.method, "DELETE");
    assert.equal(new Headers(init?.headers).get("authorization"), `token ${TOKEN}`);
    assert.equal(warn.mock.calls.length, 0);
  });

  it("keeps the HTTP status when the error body cannot be decoded", async () => {
    const limited = () =>
      new Response("null", {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    const { revoke, request, warn } = harness(async () => limited());

    await assert.rejects(revoke());

    assert.equal(request.mock.calls.length, 1);
    assert.deepEqual(warn.mock.calls[0]?.[0], { attempts: 1, status: 429 });
  });

  it("still retries a 502 whose error body cannot be decoded", async () => {
    const broken = () =>
      new Response("null", { status: 502, headers: { "content-type": "application/json" } });
    const { revoke, request } = harness(async () => new Response(null, { status: 204 }));
    request.mockResolvedValueOnce(broken());

    await revoke();

    assert.equal(request.mock.calls.length, 2);
  });

  it("retries a 502 and succeeds on the second try", async () => {
    const { revoke, request, warn } = harness(async () => new Response(null, { status: 204 }));
    request.mockResolvedValueOnce(githubError(502));

    await revoke();

    assert.equal(request.mock.calls.length, 2);
    assert.equal(warn.mock.calls.length, 0);
  });

  it("rejects with the final server error after three attempts and logs only safe fields", async () => {
    const { revoke, request, warn } = harness(async () => githubError(503));
    request.mockResolvedValueOnce(githubError(502));

    await assert.rejects(revoke(), { status: 503 });

    assert.equal(request.mock.calls.length, 3);
    assert.ok(!JSON.stringify(warn.mock.calls).includes(TOKEN));
    assert.deepEqual(warn.mock.calls, [[{ attempts: 3, status: 503 }, WARNING]]);
  });

  it.each([401, 404])("treats %s as a token that no longer grants access", async (status) => {
    const { revoke, request, warn } = harness(async () => githubError(status));

    await revoke();

    assert.equal(request.mock.calls.length, 1);
    assert.equal(warn.mock.calls.length, 0);
  });

  it.each([400, 403, 422])("does not retry HTTP %s", async (status) => {
    const { revoke, request, warn } = harness(async () => githubError(status));

    await assert.rejects(revoke(), { status });

    assert.equal(request.mock.calls.length, 1);
    assert.deepEqual(warn.mock.calls, [[{ attempts: 1, status }, WARNING]]);
  });

  it.each([
    {
      kind: "primary",
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" },
    },
    { kind: "secondary", status: 429, headers: { "retry-after": "60" } },
  ])("does not retry a $kind rate limit", async ({ kind, status, headers }) => {
    const { revoke, request, warn } = harness(
      async () =>
        Response.json({ message: `${kind} rate limit for ${TOKEN}` }, { status, headers }),
      { octokitPlugins: {} },
    );

    await assert.rejects(revoke(), { status });

    assert.equal(request.mock.calls.length, 1);
    assert.ok(!JSON.stringify(warn.mock.calls).includes(TOKEN));
    assert.deepEqual(warn.mock.calls.at(-1), [{ attempts: 1, status }, WARNING]);
  });

  it("retries a network error and a request timeout with a fresh signal", async () => {
    const { revoke, request, warn } = harness(async () => new Response(null, { status: 204 }), {
      requestTimeoutMs: 15,
      revokeTimeoutMs: 1_000,
    });
    request.mockRejectedValueOnce(new TypeError("network failed"));
    request.mockImplementationOnce(hangUntilAborted);

    await revoke();

    assert.equal(request.mock.calls.length, 3);
    assert.equal(request.mock.calls[1]?.[1]?.signal?.aborted, true);
    assert.equal(request.mock.calls[2]?.[1]?.signal?.aborted, false);
    assert.equal(warn.mock.calls.length, 0);
  });

  it("leaves a margin between the provider budget and the watchdog", () => {
    assert.ok(TOKEN_REVOKE_WATCHDOG_MS > TOKEN_REVOKE_BUDGET_MS);
  });

  it("rejects a fetch that ignores abort when the default budget expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(fakeTimeout);
    const { revoke, request } = harness(() => new Promise(() => undefined));
    const failed = vi.fn<(error: unknown) => void>();
    void revoke().catch(failed);

    await vi.advanceTimersByTimeAsync(TOKEN_REVOKE_BUDGET_MS - 1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "TimeoutError" }),
    );
  });

  it("enforces the overall budget even when fetch never settles", async () => {
    const { revoke, request, warn } = harness(() => new Promise(() => undefined), {
      requestTimeoutMs: 500,
      revokeTimeoutMs: 50,
    });
    const startedAt = performance.now();

    await assert.rejects(revoke(), { name: "TimeoutError" });

    assert.ok(performance.now() - startedAt < 450);
    assert.equal(request.mock.calls.length, 1);
    assert.equal(request.mock.calls[0]?.[1]?.signal?.aborted, true);
    assert.deepEqual(warn.mock.calls, [[{ attempts: 1, status: undefined }, WARNING]]);
  });

  it("includes backoff in the overall budget and keeps the last HTTP error", async () => {
    const { revoke, request, warn } = harness(async () => githubError(502), {
      revokeRetryDelaysMs: [500, 1_500],
      revokeTimeoutMs: 50,
    });
    const startedAt = performance.now();

    await assert.rejects(revoke(), { status: 502 });

    assert.ok(performance.now() - startedAt < 450);
    assert.equal(request.mock.calls.length, 1);
    assert.deepEqual(warn.mock.calls, [[{ attempts: 1, status: 502 }, WARNING]]);
  });
});
