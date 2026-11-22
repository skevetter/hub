import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, it, vi } from "vitest";
import { DaemonDevice, DaemonResults } from "./daemon-list.js";
import type { BrowserDaemon } from "./functions.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/o/acme/sessions/profiles">{children}</a>
  ),
}));

const daemon: BrowserDaemon = {
  id: "4e0b6391-8ff2-4c7e-b94c-f0ba48e4a11a",
  slug: "build-studio",
  status: "active",
  presence: "connected",
  connectedAt: "2026-11-20T18:00:00.000Z",
  lastSeenAt: "2026-11-20T18:00:00.000Z",
  registeredAt: "2026-11-20T18:00:00.000Z",
  permissions: ["hub.execute"],
};

const providers = { labels: ["Claude", "Codex"], message: null };
const profiles = { names: [{ id: "one", name: "Review" }], message: null };
const offline: BrowserDaemon = { ...daemon, presence: "offline" };
const revoked: BrowserDaemon = { ...daemon, status: "revoked" };
const connectedOnly: BrowserDaemon = { ...daemon, permissions: [] };

afterEach(() => vi.unstubAllGlobals());

it("renders connected provider labels, permission wording, and linked profile names", () => {
  const markup = renderToStaticMarkup(
    <DaemonDevice
      daemon={daemon}
      organizationSlug="acme"
      providers={providers}
      profiles={profiles}
    />,
  );
  assert.match(markup, />Connected</u);
  assert.match(markup, /Claude, Codex/u);
  assert.match(markup, /Can run Hub automations/u);
  assert.match(markup, /href="\/o\/acme\/sessions\/profiles"[^>]*>Review<\/a>/u);
  assert.doesNotMatch(markup, /permissions grant/u);
});

it("explains why an offline device has no provider list", () => {
  const markup = renderToStaticMarkup(<DaemonDevice daemon={offline} organizationSlug="acme" />);
  assert.match(markup, />Offline</u);
  assert.match(markup, /Providers are available when this daemon connects/u);
  assert.doesNotMatch(markup, /Session profiles/u);
});

it("keeps the revoked state visible", () => {
  const markup = renderToStaticMarkup(<DaemonDevice daemon={revoked} organizationSlug="acme" />);
  assert.match(markup, />Revoked</u);
  assert.doesNotMatch(markup, /Can run Hub automations|permissions grant/u);
});

it("offers the grant command for a connected-only daemon while providers load", () => {
  const markup = renderToStaticMarkup(
    <DaemonDevice daemon={connectedOnly} organizationSlug="acme" />,
  );
  assert.match(markup, /Loading providers/u);
  assert.match(markup, /Connected only: Hub cannot start agents here/u);
  assert.match(markup, /paseo hub permissions grant hub\.execute/u);
  assert.match(markup, /aria-label="Copy grant command"/u);
});

it("offers the host-specific login command and docs when no daemons exist", () => {
  vi.stubGlobal("window", { location: { origin: "https://hub.example.test" } });
  const markup = renderToStaticMarkup(<DaemonResults hasDaemons={false} onClear={vi.fn()} />);
  assert.match(markup, /No daemons connected/u);
  assert.match(markup, /paseo hub login https:\/\/hub\.example\.test/u);
  assert.match(markup, /https:\/\/paseo\.sh\/docs\/hub\/daemons/u);
  assert.doesNotMatch(markup, /No daemons match/u);
});

it("offers to clear filters when no daemons match", () => {
  const markup = renderToStaticMarkup(<DaemonResults hasDaemons onClear={vi.fn()} />);
  assert.match(markup, /No daemons match/u);
  assert.match(markup, /<button[^>]*>Clear filters<\/button>/u);
  assert.doesNotMatch(markup, /No daemons connected/u);
});
