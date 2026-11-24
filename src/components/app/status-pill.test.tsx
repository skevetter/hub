import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { StatusPill } from "./status-pill.js";

it("renders a live status in the live ink, apart from a done one", () => {
  const live = renderToStaticMarkup(<StatusPill tone="live">Running</StatusPill>);
  const done = renderToStaticMarkup(<StatusPill tone="success">Succeeded</StatusPill>);
  assert.match(live, /bg-live-surface text-live-text/u);
  assert.doesNotMatch(done, /live/u);
});

it("renders a status with its tone", () => {
  const markup = renderToStaticMarkup(<StatusPill tone="danger">Failed</StatusPill>);
  assert.match(markup, /bg-danger-surface text-danger/u);
  assert.match(markup, /Failed/u);
});
