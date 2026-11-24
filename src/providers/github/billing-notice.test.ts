import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it, vi } from "vitest";
import { createGitHubAuth } from "../../auth/github.js";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  GITHUB_BILLING_DENIAL,
  githubBillingTriggerContext,
} from "../../test-utils/github-billing-notice.js";
import { createGitHubRegistration } from "./index.js";

const BOT_ID = 123;
const MARKER = "<!-- paseo-notice:execution-limit:test%2Ddelivery:92 -->";
const COMMENTS_PATH = "/repos/example/project/issues/92/comments";
const RECEIVED_AT = "2026-08-06T11:00:00.987Z";

describe("GitHub execution limit notices", () => {
  it("posts despite a forged marker on every full page and reads exactly three pages", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: i === 0 ? MARKER : "unrelated",
      user: { id: i === 0 ? 456 : BOT_ID },
    }));
    const fixture = billingNoticeFixture(() => Response.json(page));

    await fixture.deliver();

    assert.equal(fixture.posts.length, 1);
    assert.deepEqual(
      fixture.lists,
      [1, 2, 3].map(
        (n) => `${COMMENTS_PATH}?since=2026-08-06T10%3A50%3A00Z&per_page=100&page=${n}`,
      ),
    );
  });

  it.each([
    { markerPage: 1, lists: 1 },
    { markerPage: 2, lists: 2 },
    { markerPage: 3, lists: 3 },
  ])("finds the notice on page $markerPage and does not post", async ({ markerPage, lists }) => {
    const fixture = billingNoticeFixture((url) =>
      Response.json(pagedComments(Number(url.searchParams.get("page")), markerPage)),
    );

    await fixture.deliver();

    assert.equal(fixture.lists.length, lists);
    assert.equal(fixture.posts.length, 0);
  });

  it("does not read a fourth page and posts when the marker is only there", async () => {
    const fixture = billingNoticeFixture((url) =>
      Response.json(pagedComments(Number(url.searchParams.get("page")), 4)),
    );

    await fixture.deliver();

    assert.equal(fixture.lists.length, 3);
    assert.equal(fixture.posts.length, 1);
  });

  it.each([
    { shortPage: 1, size: 99, lists: 1 },
    { shortPage: 2, size: 0, lists: 2 },
    { shortPage: 3, size: 1, lists: 3 },
  ])("stops at a short page $shortPage and posts", async ({ shortPage, size, lists }) => {
    const fixture = billingNoticeFixture((url) => {
      const page = Number(url.searchParams.get("page"));
      return Response.json(pagedComments(page, 0).slice(0, page === shortPage ? size : 100));
    });

    await fixture.deliver();

    assert.equal(fixture.lists.length, lists);
    assert.equal(fixture.posts.length, 1);
  });

  it("pages by number and ignores a next link to another host or API prefix", async () => {
    const link =
      '<https://ghe.example.test/api/v3/repos/example/project/issues/92/comments?page=9>; rel="next"';
    const fixture = billingNoticeFixture((url) =>
      Response.json(pagedComments(Number(url.searchParams.get("page")), 0), {
        headers: { link },
      }),
    );

    await fixture.deliver();

    assert.equal(fixture.lists.length, 3);
    assert.ok(fixture.lists.every((entry) => entry.startsWith(`${COMMENTS_PATH}?`)));
    assert.equal(fixture.posts.length, 1);
  });

  it.each([
    { scenario: "finds the prior notice despite clock skew", ageSeconds: 2, expectedPosts: 1 },
    { scenario: "misses notices older than the allowance", ageSeconds: 601, expectedPosts: 2 },
  ])("$scenario", async ({ ageSeconds, expectedPosts }) => {
    const updatedAt = Date.parse(RECEIVED_AT) - ageSeconds * 1_000;
    const fixture = billingNoticeFixture((url, posts) =>
      filteredCommentPage(url, posts, updatedAt),
    );

    await fixture.deliver({ receivedAt: RECEIVED_AT });
    assert.equal(fixture.posts.length, 1);
    await fixture.deliver({ receivedAt: RECEIVED_AT });

    assert.equal(fixture.lists.length, 2);
    assert.equal(fixture.posts.length, expectedPosts);
  });

  it("makes one list request without since when the receipt time is invalid", async () => {
    const fixture = billingNoticeFixture(() =>
      Response.json([{ id: 1, body: `old notice\r\n  ${MARKER}  \r\n`, user: { id: BOT_ID } }]),
    );

    await fixture.deliver({ receivedAt: "not a date" });

    assert.deepEqual(fixture.lists, [`${COMMENTS_PATH}?per_page=100&page=1`]);
    assert.equal(fixture.posts.length, 0);
  });

  it("posts when the bot only quotes the marker inside another line", async () => {
    const fixture = billingNoticeFixture(() =>
      Response.json([{ id: 1, body: `Quoting \`${MARKER}\` here.`, user: { id: BOT_ID } }]),
    );

    await fixture.deliver();

    assert.equal(fixture.posts.length, 1);
  });

  it("propagates a list failure without retrying the list or posting", async () => {
    const fixture = billingNoticeFixture(() =>
      Response.json({ message: "comment list unavailable" }, { status: 503 }),
    );

    await assert.rejects(() => fixture.deliver(), /comment list unavailable/u);

    assert.equal(fixture.lists.length, 1);
    assert.equal(fixture.posts.length, 0);
  });

  it("posts separate notices for different deliveries on the same issue", async () => {
    const page: Array<{ id: number; body: string; user: { id: number } }> = [];
    const fixture = billingNoticeFixture(() => Response.json(page));

    await fixture.deliver();
    page.push({ id: 1, body: MARKER, user: { id: BOT_ID } });
    await fixture.deliver();
    await fixture.deliver({ deliveryId: "another-delivery" });

    assert.equal(fixture.lists.length, 3);
    assert.equal(fixture.posts.length, 2);
    assert.ok(fixture.posts[0]?.endsWith(MARKER));
    assert.match(
      fixture.posts[1] ?? "",
      /<!-- paseo-notice:execution-limit:another%2Ddelivery:92 -->/u,
    );
  });
});

function pagedComments(page: number, markerPage: number) {
  return Array.from({ length: 100 }, (_, i) => ({
    id: page * 1_000 + i,
    body: page === markerPage && i === 99 ? MARKER : "unrelated",
    user: { id: BOT_ID },
  }));
}

function filteredCommentPage(url: URL, posts: readonly string[], updatedAt: number): Response {
  const since = url.searchParams.get("since");
  const comments = posts.map((body, i) => ({
    id: i + 1,
    body,
    user: { id: BOT_ID },
    updated_at: new Date(updatedAt).toISOString(),
  }));
  return Response.json(
    since === null
      ? comments
      : comments.filter((comment) => Date.parse(comment.updated_at) > Date.parse(since)),
  );
}

type ListComments = (url: URL, posts: readonly string[]) => Response;

function billingNoticeFixture(list: ListComments) {
  const requests = { lists: new Array<string>(), posts: new Array<string>() };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const configuration = {
    appId: "42",
    appSlug: "paseo",
    clientId: "client",
    clientSecret: "test",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
  const database = createMemoryDatabase();
  vi.spyOn(database, "findOrganizationSlugById").mockResolvedValue("org");
  const registration = createGitHubRegistration({
    database,
    auth: null,
    applicationBaseUrl: "https://hub.test",
    publicBaseUrl: "https://hub.test",
    configuration,
    appAuth: createGitHubAuth({
      ...configuration,
      octokitPlugins: { throttle: false },
      fetch: commentFetch(list, requests),
    }),
  });
  const provider = registration.triggerProviders[0]?.({
    configurationStoreForProject: () => {
      throw new Error("not used");
    },
    connectionsForProject: () => async () => "not used",
  });
  const deliver = ({
    deliveryId,
    receivedAt,
  }: { deliveryId?: string; receivedAt?: string } = {}) => {
    if (typeof provider?.onAgentExecutionFailed !== "function")
      throw new Error("GitHub failure hook unavailable");
    const context = githubBillingTriggerContext(deliveryId);
    if (receivedAt !== undefined) context.event.github.received_at = receivedAt;
    return provider.onAgentExecutionFailed(context, context, GITHUB_BILLING_DENIAL);
  };
  return { deliver, ...requests };
}

function commentFetch(
  list: ListComments,
  { lists, posts }: { lists: string[]; posts: string[] },
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/app/installations/42/access_tokens") {
      return Response.json({
        token: "test-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (decodeURIComponent(url.pathname) === "/users/paseo[bot]")
      return Response.json({ id: BOT_ID, login: "paseo[bot]" });
    assert.equal(url.pathname, COMMENTS_PATH);
    if (init?.method === "POST") {
      assert.ok(typeof init.body === "string");
      const payload: unknown = JSON.parse(init.body);
      assert.ok(payload && typeof payload === "object" && "body" in payload);
      assert.ok(typeof payload.body === "string");
      posts.push(payload.body);
      return Response.json({ id: posts.length });
    }
    assert.equal(init?.method, "GET");
    lists.push(`${url.pathname}${url.search}`);
    return list(url, posts);
  };
}
