import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "vitest";
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

  it("keeps retry and throttling off for run progress clients", async () => {
    const { auth, requests } = harness(unavailable);
    const octokit = await auth.createInstallationOctokit(142, { retries: "off" });

    await assert.rejects(
      octokit.request("GET /repos/{owner}/{repo}", { owner: "acme", repo: "app" }),
    );

    assert.equal(requests.length, 1);
  });
});

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}
