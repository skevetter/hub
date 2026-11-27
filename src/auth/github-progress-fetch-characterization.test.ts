import { describe, expect, it } from "vitest";
import { githubProgressFetch, GITHUB_API_ORIGIN } from "./github-progress-fetch.js";

const url = `${GITHUB_API_ORIGIN}/repos/a/b`;

function relay(response: Response): typeof fetch {
  return githubProgressFetch(async () => response);
}

describe("GitHub progress fetch", () => {
  it("validates the origin before touching fetch or an aborted signal", async () => {
    const request = githubProgressFetch(async () => {
      throw new Error("upstream should not run");
    });
    const reason = new Error("caller aborted");
    const signal = AbortSignal.abort(reason);
    await expect(request("https://example.invalid", { signal })).rejects.toThrow(
      "Unexpected GitHub API origin",
    );
    await expect(request(url, { signal })).rejects.toBe(reason);
    await expect(request("invalid url")).rejects.toThrow("Invalid URL");
    await expect(request(url)).rejects.toThrow("GitHub progress request failed");
  });

  it("keeps the request input and forces manual redirect handling", async () => {
    const input = new Request(url);
    const request = githubProgressFetch(async (received, init) => {
      expect(received).toBe(input);
      expect(init).toEqual({ redirect: "manual", method: "GET" });
      return new Response(null, { status: 204 });
    });
    expect((await request(input, { redirect: "follow", method: "GET" })).status).toBe(204);
  });

  it("fails closed and cancels a redirected response", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const response = Object.defineProperty(new Response(body), "redirected", { value: true });
    await expect(relay(response)(url)).rejects.toThrow("GitHub progress request failed");
    expect(cancelled).toBe(true);
    const empty = Object.defineProperty(new Response(null), "redirected", { value: true });
    await expect(relay(empty)(url)).rejects.toThrow("GitHub progress request failed");
  });

  it("preserves safe header values, strips parameters and redacts metadata", async () => {
    const date = "Wed, 21 Oct 2015 07:28:00 GMT";
    const response = await relay(
      new Response("ok", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": date,
          "x-github-sso": "private",
          "x-oauth-scopes": "user, admin:org, extra",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "invalid",
          "x-private": "discard",
        },
      }),
    )(url);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/plain",
      "retry-after": date,
      "x-github-sso": "required",
      "x-oauth-scopes": "repo",
      "x-ratelimit-remaining": "0",
    });
    expect(await response.text()).toBe("ok");
  });

  it("drops invalid metadata and preserves an empty success body", async () => {
    const response = await relay(
      new Response(null, {
        headers: { "retry-after": "invalid", "x-oauth-scopes": "user" },
      }),
    )(url);
    expect(Object.fromEntries(response.headers)).toEqual({});
    expect(response.body).toBe(null);
  });

  it("masks rejection bodies and distinguishes partial evidence", async () => {
    for (const [body, rejected, partial] of [
      [null, false, false],
      ["broken", false, false],
      ["null", false, false],
      ["1", false, false],
      ["[]", false, false],
      ["{}", false, false],
      ['{"message":1}', false, false],
      ['{"message":"rejected","errors":[]}', false, false],
      ['{"message":"rejected","status":403}', true, false],
      ['{"message":"rejected","status":"403"}', true, false],
      ['{"message":"rejected","status":404}', false, true],
      ['{"message":"rejected","extra":0}', false, true],
    ] as const) {
      const response = await relay(
        new Response(body, {
          status: 403,
          headers: { "retry-after": "2", "x-oauth-scopes": "repo" },
        }),
      )(url);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("retry-after")).toBe("2");
      expect(response.headers.get("x-oauth-scopes")).toBe("repo");
      expect(await response.text()).toBe(JSON.stringify({ rejected, partial }));
    }
  });

  it("masks oversized bodies and aborts during a read", async () => {
    await expect(relay(new Response("a".repeat(1024 * 1024 + 1)))(url)).rejects.toThrow(
      "GitHub progress request failed",
    );
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        pull() {
          controller.abort();
        },
      }),
    );
    await expect(relay(response)(url, { signal: controller.signal })).rejects.toThrow(
      "GitHub progress request failed",
    );
  });
});
