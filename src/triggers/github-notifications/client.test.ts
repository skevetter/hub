import { describe, expect, it } from "vitest";
import { createGitHubNotificationsClient, GitHubNotificationsError } from "./client.js";
import { thread } from "./test-fixture.js";

const TOKEN = "fake-notification-token-0001";
const since = new Date("2026-11-14T09:00:00.000Z");

interface Seen {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
}

function fakeFetch(responses: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, seen };
}

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("GitHub notifications client", () => {
  it("sends the documented query, token and API version", async () => {
    const { fetch, seen } = fakeFetch([
      json([thread()], { "last-modified": "Sat, 14 Nov 2026 10:00:01 GMT" }),
    ]);
    const client = createGitHubNotificationsClient({ token: TOKEN, fetch });
    const result = await client.list({ since, lastModified: null });
    expect(result).toMatchObject({ status: "ok", lastModified: "Sat, 14 Nov 2026 10:00:01 GMT" });
    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.github.com/notifications");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      all: "true",
      participating: "true",
      since: "2026-11-14T09:00:00Z",
      per_page: "50",
      page: "1",
    });
    expect(seen[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(seen[0]!.headers["if-modified-since"]).toBeUndefined();
  });

  it("returns not_modified on 304 and sends If-Modified-Since", async () => {
    const { fetch, seen } = fakeFetch([
      new Response(null, { status: 304, headers: { "x-poll-interval": "90" } }),
    ]);
    const client = createGitHubNotificationsClient({ token: TOKEN, fetch });
    const result = await client.list({ since, lastModified: "Sat, 14 Nov 2026 10:00:01 GMT" });
    expect(result).toEqual({ status: "not_modified", pollIntervalSeconds: 90 });
    expect(seen[0]!.headers["if-modified-since"]).toBe("Sat, 14 Nov 2026 10:00:01 GMT");
  });

  it("reads X-Poll-Interval from a successful response", async () => {
    const { fetch } = fakeFetch([json([], { "x-poll-interval": "120" })]);
    const result = await createGitHubNotificationsClient({ token: TOKEN, fetch }).list({
      since,
      lastModified: null,
    });
    expect(result).toMatchObject({ status: "ok", notifications: [], pollIntervalSeconds: 120 });
  });

  it("follows pagination and keeps the first page Last-Modified", async () => {
    const next = "https://api.github.com/notifications?page=2&per_page=50";
    const controller = new AbortController();
    const { fetch, seen } = fakeFetch([
      json([thread({ id: "1" })], {
        link: `<${next}>; rel="next", <https://api.github.com/notifications?page=2>; rel="last"`,
        "last-modified": "first",
      }),
      json([thread({ id: "2" })], { "last-modified": "second" }),
    ]);
    const result = await createGitHubNotificationsClient({ token: TOKEN, fetch }).list({
      since,
      lastModified: "older",
      signal: controller.signal,
    });
    expect(result).toMatchObject({ status: "ok", lastModified: "first" });
    expect(result.status === "ok" && result.notifications.map(({ id }) => id)).toEqual(["1", "2"]);
    expect(seen[1]!.url).toBe(next);
    expect(seen[1]!.headers["if-modified-since"]).toBeUndefined();
    expect(seen.map(({ signal }) => signal)).toEqual([controller.signal, controller.signal]);
  });

  it("does not follow a next link to another host", async () => {
    const { fetch, seen } = fakeFetch([
      json([thread()], { link: '<https://example.com/steal>; rel="next"' }),
    ]);
    await createGitHubNotificationsClient({ token: TOKEN, fetch }).list({
      since,
      lastModified: null,
    });
    expect(seen).toHaveLength(1);
  });

  it("fails with the status on 401 and never includes the token", async () => {
    const { fetch } = fakeFetch([json({ message: `Bad credentials for ${TOKEN}` }, {}, 401)]);
    const error = await createGitHubNotificationsClient({ token: TOKEN, fetch })
      .list({ since, lastModified: null })
      .catch((caught: unknown) => caught);
    if (!(error instanceof GitHubNotificationsError)) throw new Error("expected an API error");
    expect(error.status).toBe(401);
    expect(error.message).toBe("GitHub notifications returned 401: Bad credentials for [redacted]");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
  });

  it("redacts the token from transport errors", async () => {
    const { fetch } = fakeFetch([new Error(`connect failed with Bearer ${TOKEN}`)]);
    const error = await createGitHubNotificationsClient({ token: TOKEN, fetch })
      .list({ since, lastModified: null })
      .catch((caught: unknown) => caught);
    if (!(error instanceof Error)) throw new Error("expected an error");
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[redacted]");
  });

  it.each([200, 401])(
    "aborts an in-flight %s response body without masking cancellation",
    async (status) => {
      const controller = new AbortController();
      const reading = Promise.withResolvers<void>();
      const client = createGitHubNotificationsClient({
        token: TOKEN,
        fetch: async (_url, init) => {
          const response = new Response(
            new ReadableStream({
              start(stream) {
                init.signal!.addEventListener("abort", () => stream.error(init.signal!.reason), {
                  once: true,
                });
              },
            }),
            { status },
          );
          const read: () => Promise<unknown> = response.json.bind(response);
          response.json = async () => {
            reading.resolve();
            return read();
          };
          return response;
        },
      });
      const listing = client.list({ since, lastModified: null, signal: controller.signal });
      const rejected = expect(listing).rejects.toMatchObject({ name: "AbortError" });
      await reading.promise;
      controller.abort();
      await expect(listing).rejects.toBe(controller.signal.reason);
      await rejected;
    },
  );

  it("rejects a response that is not a notification list", async () => {
    const { fetch } = fakeFetch([json({ unexpected: true })]);
    await expect(
      createGitHubNotificationsClient({ token: TOKEN, fetch }).list({ since, lastModified: null }),
    ).rejects.toThrow("unexpected response shape");
  });
});
