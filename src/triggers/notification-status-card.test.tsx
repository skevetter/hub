import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import type { NotificationStatusView } from "./notification-status.js";
import { NOTIFICATION_DOCS_URL, NotificationStatusCard } from "./notification-status-card.js";

const healthy: NotificationStatusView = {
  state: "polling",
  lastSuccessAt: "2026-11-14T11:59:30.000Z",
  nextPollAt: "2026-11-14T12:00:30.000Z",
  lastError: null,
  delivered24h: 12,
  pollIntervalSeconds: 60,
  tokenConfigured: true,
};

const render = (status: NotificationStatusView) =>
  renderToStaticMarkup(<NotificationStatusCard status={status} />);

describe("notification status card", () => {
  it("shows a healthy poll with the shared status pill and no warning", () => {
    const markup = render(healthy);
    assert.match(markup, /GitHub notifications/u);
    assert.match(markup, /Polling/u);
    assert.match(markup, /Last poll/u);
    assert.match(markup, /Next poll/u);
    assert.match(markup, /Delivered in the last 24 hours/u);
    assert.match(markup, />12</u);
    assert.doesNotMatch(markup, /Last error/u);
    assert.doesNotMatch(markup, /role="alert"/u);
  });

  const labels = (markup: string) =>
    [...markup.matchAll(/<dt[^>]*>([^<]*)<\/dt>/gu)].map((match) => match[1]);

  it("fills the three column grid with six rows", () => {
    assert.deepEqual(labels(render(healthy)), [
      "Status",
      "Last poll",
      "Next poll",
      "Poll interval",
      "Delivered in the last 24 hours",
      "Token",
    ]);
  });

  it("shows the configured poll interval and that a token is set, never its value", () => {
    const markup = render(healthy);
    assert.match(markup, /Poll interval/u);
    assert.match(markup, />60 seconds</u);
    assert.match(markup, /Token/u);
    assert.match(markup, />Configured</u);
    assert.doesNotMatch(markup, /Not set/u);
  });

  it("says the token is not set and that nothing is polling when polling is off", () => {
    const markup = render({
      ...healthy,
      state: "off",
      pollIntervalSeconds: null,
      tokenConfigured: false,
    });
    assert.match(markup, />Not set</u);
    assert.match(markup, />Not polling</u);
    assert.equal(labels(markup).length, 6);
  });

  it("shows the last error as its own block below the grid, not as a grid cell", () => {
    const markup = render({ ...healthy, state: "error", lastError: "GitHub returned 502" });
    assert.deepEqual(labels(markup).slice(0, 6), [
      "Status",
      "Last poll",
      "Next poll",
      "Poll interval",
      "Delivered in the last 24 hours",
      "Token",
    ]);
    const grid = /<dl[^>]*data-summary="GitHub notifications"[^>]*>[\s\S]*?<\/dl>/u.exec(markup);
    assert.ok(grid);
    assert.doesNotMatch(grid[0], /Last error/u);
    const block = /<dl[^>]*data-summary="GitHub notifications error"[^>]*>[\s\S]*?<\/dl>/u.exec(
      markup,
    );
    assert.ok(block);
    assert.match(block[0], /Last error/u);
    assert.match(block[0], /GitHub returned 502/u);
    assert.ok(markup.indexOf(grid[0]) < markup.indexOf(block[0]));
  });

  it("shows the last error, muted, beside an Error pill", () => {
    const markup = render({
      ...healthy,
      state: "error",
      lastError: "GitHub notifications returned 401: Bad credentials",
    });
    assert.match(markup, /Error/u);
    assert.match(markup, /Last error/u);
    assert.match(markup, /text-muted-foreground[^>]*>GitHub notifications returned 401/u);
    assert.doesNotMatch(markup, /role="alert"/u);
  });

  it("warns that polling is off and links the setup steps", () => {
    const markup = render({ ...healthy, state: "off", lastSuccessAt: null, nextPollAt: null });
    assert.match(markup, /Polling is off/u);
    assert.match(markup, /GITHUB_NOTIFICATIONS_TOKEN/u);
    assert.match(markup, /is not set on the Hub/u);
    assert.ok(markup.includes(`href="${NOTIFICATION_DOCS_URL}"`));
    assert.match(markup, /Not yet/u);
  });

  it("says a poll that has not happened yet is not scheduled", () => {
    const markup = render({
      ...healthy,
      state: "starting",
      lastSuccessAt: null,
      nextPollAt: null,
    });
    assert.match(markup, /Starting/u);
    assert.match(markup, /Not scheduled/u);
  });
});
