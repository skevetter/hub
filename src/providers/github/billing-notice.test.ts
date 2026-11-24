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
const MARKER = "<!-- paseo-notice:execution-limit:test-delivery:92 -->";
const COMMENTS_PATH = "/repos/example/project/issues/92/comments";

describe("GitHub execution limit notices", () => {
  it("posts despite a forged marker on a full page and does not fetch the next page", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: i === 0 ? MARKER : "unrelated",
      user: { id: i === 0 ? 456 : BOT_ID },
    }));
    const fixture = billingNoticeFixture(() =>
      Response.json(page, {
        headers: { link: `<https://api.github.com${COMMENTS_PATH}?page=2>; rel="next"` },
      }),
    );

    await fixture.deliver();

    assert.equal(fixture.posts.length, 1);
    assert.deepEqual(fixture.lists, [
      `${COMMENTS_PATH}?since=2026-08-06T11%3A00%3A00.000Z&per_page=100`,
    ]);
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
    await fixture.deliver("another-delivery");

    assert.equal(fixture.lists.length, 3);
    assert.equal(fixture.posts.length, 2);
    assert.match(fixture.posts[0] ?? "", /<!-- paseo-notice:execution-limit:test-delivery:92 -->/u);
    assert.match(
      fixture.posts[1] ?? "",
      /<!-- paseo-notice:execution-limit:another-delivery:92 -->/u,
    );
  });
});

function billingNoticeFixture(list: () => Response) {
  const lists: string[] = [];
  const posts: string[] = [];
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
      fetch: async (input, init) => {
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
          posts.push(init.body);
          return Response.json({ id: posts.length });
        }
        assert.equal(init?.method, "GET");
        lists.push(`${url.pathname}${url.search}`);
        return list();
      },
    }),
  });
  const provider = registration.triggerProviders[0]?.({
    configurationStoreForProject: () => {
      throw new Error("not used");
    },
    connectionsForProject: () => async () => "not used",
  });
  const deliver = (deliveryId?: string) => {
    if (typeof provider?.onAgentExecutionFailed !== "function")
      throw new Error("GitHub failure hook unavailable");
    const context = githubBillingTriggerContext(deliveryId);
    return provider.onAgentExecutionFailed(context, context, GITHUB_BILLING_DENIAL);
  };
  return { deliver, lists, posts };
}
