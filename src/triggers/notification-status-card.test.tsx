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
