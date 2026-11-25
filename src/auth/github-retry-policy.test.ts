import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it, vi } from "vitest";
import { logger } from "../logger.js";
import { createGitHubReactionClient } from "../triggers/github/provider.js";
import { createGitHubAuth } from "./github.js";

interface Seen {
  method: string;
  path: string;
}

function harness(respond: (seen: Seen, attempt: number) => Response) {
  const requests: Seen[] = [];
  const auth = createGitHubAuth({
    appId: "12345",
    privateKey: testPrivateKey(),
    fetch: async (input, init) => {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init);
      const seen = { method: request.method, path: new URL(request.url).pathname };
      if (seen.path.endsWith("/access_tokens")) {
        return Response.json({
          token: "ghs_installation",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }
      requests.push(seen);
      return respond(seen, requests.length);
    },
  });
  return { auth, requests };
}

const unavailable = () => Response.json({ message: "unavailable" }, { status: 502 });

describe("GitHub client retry and throttle policy", () => {
  it("publishes a comment at most once when the response is a server error", async () => {
    const { auth, requests } = harness(unavailable);

    const octokit = await auth.createInstallationOctokit(142);

    await assert.rejects(
      octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: "acme",
        repo: "app",
        issue_number: 7,
        body: "hello",
      }),
    );

    assert.deepEqual(requests, [{ method: "POST", path: "/repos/acme/app/issues/7/comments" }]);
  });

  it("publishes a comment at most once when the endpoint is given as a resolved URL", async () => {
    const { auth, requests } = harness(unavailable);
    const octokit = await auth.createInstallationOctokit(142);

    await assert.rejects(
      octokit.request("POST /repos/acme/app/issues/7/comments", { body: "hello" }),
    );

    assert.equal(requests.length, 1);
  });

  it("keeps the retry setting of the client after a comment is created", async () => {
    const { auth, requests } = harness(unavailable);
    const octokit = await auth.createInstallationOctokit(142);

    await assert.rejects(
      octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: "acme",
        repo: "app",
        issue_number: 7,
        body: "hello",
      }),
    );
    await assert.rejects(
      octokit.request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "app" }),
    );

    assert.equal(requests.length, 3);
  });

  it("still retries a PATCH of a known comment", async () => {
    const { auth, requests } = harness(unavailable);
    const octokit = await auth.createInstallationOctokit(142);

    await assert.rejects(
      octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner: "acme",
        repo: "app",
        comment_id: 9,
        body: "edited",
      }),
    );

    assert.equal(requests.length, 2);
  });

  it("retries a reaction once, then reports the failure", async () => {
    const { auth, requests } = harness(unavailable);

    await assert.rejects(
      createGitHubReactionClient(auth).createReaction({
        installationId: 142,
        repo: "acme/app",
        subject: { kind: "item", issueNumber: 7 },
        content: "eyes",
      }),
    );

    assert.equal(requests.length, 2);
  });

  it("retries a read once, then reports the failure", async () => {
    const { auth, requests } = harness(unavailable);

    await assert.rejects(auth.getAppBotIdentity("paseo", "installation-token"));

    assert.equal(requests.length, 2);
  });

  it("does not retry a 429", async () => {
    const { auth, requests } = harness(() =>
      Response.json({ message: "slow down" }, { status: 429 }),
    );

    await assert.rejects(auth.getAppBotIdentity("paseo", "installation-token"));

    assert.equal(requests.length, 1);
  });

  it("fails at once on a secondary rate limit instead of waiting for it", async () => {
    const { auth, requests } = harness(() =>
      Response.json(
        { message: "You have exceeded a secondary rate limit." },
        { status: 403, headers: { "retry-after": "60" } },
      ),
    );
    const startedAt = performance.now();

    await assert.rejects(auth.getAppBotIdentity("paseo", "installation-token"));

    assert.equal(requests.length, 1);
    assert.ok(performance.now() - startedAt < 2_000);
  });

  it("fails at once on an exhausted primary quota instead of waiting for the reset", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3_600;
    const { auth, requests } = harness(() =>
      Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        },
      ),
    );
    const startedAt = performance.now();

    await assert.rejects(auth.getAppBotIdentity("paseo", "installation-token"));

    assert.equal(requests.length, 1);
    assert.ok(performance.now() - startedAt < 2_000);
  });

  it.each([
    ["a trailing slash", "POST /repos/acme/app/issues/7/comments/", "https://api.github.com"],
    ["a query template", "POST /repos/acme/app/issues/7/comments{?flag}", "https://api.github.com"],
    [
      "an API base prefix",
      "POST /repos/acme/app/issues/7/comments",
      "https://ghe.example.test/api/v3",
    ],
  ])("publishes a comment at most once with %s", async (_name, route, baseUrl) => {
    const { auth, requests } = harness(unavailable);
    const octokit = await auth.createInstallationOctokit(142);

    await assert.rejects(octokit.request(route, { body: "hello", baseUrl, flag: "x" }));

    assert.equal(requests.length, 1);
  });

  it("logs a rate limit without account or repository names under an API base prefix", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { auth, requests } = harness(() =>
        Response.json(
          { message: "You have exceeded a secondary rate limit." },
          { status: 403, headers: { "retry-after": "60" } },
        ),
      );
      const octokit = await auth.createInstallationOctokit(142);

      await assert.rejects(
        octokit.request("GET https://ghe.example.test/api/v3/repos/acme/secret-repo/issues/7"),
      );

      assert.equal(requests.length, 1);
      const logged = JSON.stringify(warn.mock.calls);
      assert.ok(logged.includes("/repos/:owner/:repo/issues/:id"));
      assert.ok(!logged.includes("acme") && !logged.includes("secret-repo"));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps spacing writes one second apart", async () => {
    const { auth, requests } = harness(() => Response.json({}));
    const octokit = await auth.createInstallationOctokit(142);
    const startedAt = performance.now();

    await Promise.all(
      [1, 2].map((comment_id) =>
        octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          owner: "acme",
          repo: "app",
          comment_id,
          body: "edited",
        }),
      ),
    );

    assert.equal(requests.length, 2);
    assert.ok(performance.now() - startedAt >= 900);
  });

  it("keeps retry and throttling off for run progress clients", async () => {
    const { auth, requests } = harness(unavailable);
    const octokit = await auth.createInstallationOctokit(142, { retries: "off" });

    await assert.rejects(
      octokit.request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "app" }),
    );

    assert.equal(requests.length, 1);
  });
});

describe("GitHub installation token mint retry", () => {
  const mintAuth = (fetchImpl: () => Promise<Response>) => {
    const mints: string[] = [];
    const auth = createGitHubAuth({
      appId: "12345",
      privateKey: testPrivateKey(),
      fetch: async (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        mints.push(`${request.method} ${new URL(request.url).pathname}`);
        return fetchImpl();
      },
    });
    return { auth, mints };
  };

  it("mints at most once when the response is a server error", async () => {
    const { auth, mints } = mintAuth(async () => unavailable());

    await assert.rejects(auth.createInstallationOctokit(142));

    assert.deepEqual(mints, ["POST /app/installations/142/access_tokens"]);
  });

  it("mints at most once when the connection fails after the request", async () => {
    const { auth, mints } = mintAuth(async () => {
      throw new TypeError("fetch failed");
    });

    await assert.rejects(auth.createInstallationOctokit(142));

    assert.equal(mints.length, 1);
  });

  it("still retries a read of the app installation once", async () => {
    const { auth, mints } = mintAuth(async () => unavailable());

    await assert.rejects(auth.getInstallation(142));

    assert.deepEqual(mints, ["GET /app/installations/142", "GET /app/installations/142"]);
  });
});

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}
