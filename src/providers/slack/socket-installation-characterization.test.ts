import { describe, expect, it } from "vitest";
import {
  startSlackSocketFixture,
  type SlackOpenBehavior,
} from "../../test-utils/slack-socket-fixture.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "./client.js";
import { createSlackSocketInstallationVerifier } from "./installation.js";

type FixtureOptions = Parameters<typeof startSlackSocketFixture>[1];

async function verify(opens: SlackOpenBehavior[], identity: FixtureOptions, botToken: string) {
  const slack = await startSlackSocketFixture(opens, identity);
  try {
    const verifier = createSlackSocketInstallationVerifier({
      apiBaseUrl: slack.apiBaseUrl,
      timeoutMs: 1_000,
    });
    const installation = await verifier.verify("fixture-app", botToken);
    return { installation, authorizations: slack.authorizations, outstanding: slack.outstanding };
  } finally {
    await slack.close();
  }
}

function testRejection(
  name: string,
  opens: SlackOpenBehavior[],
  reason: string,
  identity?: FixtureOptions,
) {
  it(name, async () => {
    await expect(verify(opens, identity, "fixture-bot")).rejects.toThrow(reason);
  });
}

describe("Slack socket verification evidence", () => {
  for (const [status, reason] of [
    [401, "network"],
    [429, "rateLimited"],
    [500, "upstreamUnavailable"],
    [503, "upstreamUnavailable"],
  ] as const) {
    testRejection(`maps the open response ${status}`, [{ kind: "http", status }], reason);
  }
  for (const scope of SLACK_REQUIRED_BOT_SCOPES) {
    testRejection(`requires ${scope}`, [], "permissionMissing", {
      scopes: SLACK_REQUIRED_BOT_SCOPES.filter((value) => value !== scope),
    });
  }
  testRejection("rejects a mismatching app token", [], "credentialsRejected", {
    appToken: "configured-app",
  });
  testRejection("rejects a mismatching bot token", [], "credentialsRejected", {
    botToken: "configured-bot",
  });
  testRejection("rejects an empty identity field", [], "invalidResponse", { botId: "" });
  testRejection(
    "rejects inconsistent socket and bot identities",
    [{ kind: "socket", appId: "other-app" }],
    "credentialsRejected",
  );

  for (const teamId of ["T1", "T2", "T900"]) {
    it(`returns a closed and verified installation for ${teamId}`, async () => {
      const scopes = SLACK_REQUIRED_BOT_SCOPES.toReversed();
      const result = await verify(
        [],
        { teamId, scopes: [...scopes, " users:read "] },
        "fixture-bot",
      );
      expect(result).toEqual({
        installation: {
          appId: "A123",
          teamId,
          teamName: "Acme",
          botUserId: "U1",
          botAccessToken: "fixture-bot",
          scopes: [...new Set([...scopes, "users:read"])].sort(),
        },
        authorizations: ["Bearer fixture-app", "Bearer fixture-bot", "Bearer fixture-bot"],
        outstanding: 0,
      });
    });
  }
});
