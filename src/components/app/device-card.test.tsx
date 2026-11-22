import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { it } from "vitest";
import { DeviceCard, DeviceCardSkeleton } from "./device-card.js";

const details = [{ label: "Providers", value: "Claude, Codex" }];
const actions = <button type="button">Manage device</button>;

it("shows a device identity, state, last-seen time, facts, and actions", () => {
  const markup = renderToStaticMarkup(
    <DeviceCard
      name="build-studio"
      id="4e0b6391-8ff2-4c7e-b94c-f0ba48e4a11a"
      status="connected"
      lastSeenAt="2026-11-20T18:00:00.000Z"
      details={details}
      actions={actions}
    />,
  );
  assert.match(markup, /<h2[^>]*>[\s\S]*build-studio/u);
  assert.match(markup, /font-mono[^>]*>4e0b6391-8ff2-4c7e-b94c-f0ba48e4a11a/u);
  assert.match(markup, /Connected/u);
  assert.match(markup, /Last seen <time dateTime="2026-11-20T18:00:00.000Z"/u);
  assert.match(markup, /Claude, Codex/u);
  assert.match(markup, /Manage device/u);
});

it("marks the card skeleton busy", () => {
  const markup = renderToStaticMarkup(<DeviceCardSkeleton detailCount={3} />);
  assert.match(markup, /aria-busy="true"/u);
});
