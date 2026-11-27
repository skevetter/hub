import assert from "node:assert/strict";
import { it } from "vitest";
import { startSlackSocketFixture } from "./slack-socket-fixture.js";

it("routes Slack HTTP requests and consumes only authorized open behaviors", async () => {
  const slack = await startSlackSocketFixture(
    [
      { kind: "http", status: 503 },
      { kind: "slackError", code: "fixture_error", bodyCanary: "diagnostic" },
      { kind: "socket", appId: "override", ignoreClose: true },
    ],
    { appToken: "open", botToken: "bot", appId: "identity", scopes: ["chat:write"] },
  );
  const get = (url: string, token: string) =>
    fetch(url, { headers: { authorization: `Bearer ${token}` } });
  try {
    assert.equal(
      await (await get(slack.openUrl, "wrong")).text(),
      '{"ok":false,"error":"invalid_auth","detail":""}',
    );
    assert.equal((await get(slack.openUrl, "open")).status, 503);
    assert.equal(
      await (await get(slack.openUrl, "open")).text(),
      '{"ok":false,"error":"fixture_error","detail":"diagnostic"}',
    );
    assert.match(
      await (await get(slack.openUrl, "open")).text(),
      /^{"ok":true,"url":"ws:\/\/127\.0\.0\.1:\d+\/socket\?app=override&ignore=yes&ticket=ticket-canary"}$/,
    );
    assert.match(await (await get(slack.openUrl, "open")).text(), /app=identity&ignore=no/);
    const auth = `${slack.apiBaseUrl}/auth.test`;
    assert.equal(await (await get(auth, "wrong")).text(), '{"ok":false,"error":"invalid_auth"}');
    const authorized = await get(auth, "bot");
    assert.equal(authorized.headers.get("x-oauth-scopes"), "chat:write");
    assert.equal(
      await authorized.text(),
      '{"ok":true,"team_id":"T1","team":"Acme","user_id":"U1","bot_id":"B1"}',
    );
    assert.equal(
      await (await get(`${slack.apiBaseUrl}/bots.info?bot=B1`, "bot")).text(),
      '{"ok":true,"bot":{"id":"B1","app_id":"identity","user_id":"U1"}}',
    );
    assert.equal((await get(`${slack.apiBaseUrl}/missing`, "bot")).status, 404);
    assert.equal(slack.openCount, 5);
    assert.equal(slack.authorization, "Bearer wrong");
    assert.equal(slack.outstanding, 0);
  } finally {
    await slack.close();
  }
});

it("tracks unfinished opens and serves an incomplete body", async () => {
  const slack = await startSlackSocketFixture([{ kind: "unfinished", status: 202 }]);
  try {
    const response = await fetch(slack.openUrl);
    assert.equal(response.status, 202);
    assert.equal(slack.outstanding, 1);
    const chunk = await response.body?.getReader().read();
    assert.equal(
      new TextDecoder().decode(chunk?.value),
      '{"provider_secret":"body-canary-never-read"',
    );
  } finally {
    await slack.close();
  }
});
