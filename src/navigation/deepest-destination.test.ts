import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deepestDestination, type NavigationDestination } from "./destination.js";

const BASE = "/o/acme";
const DESTINATIONS: readonly NavigationDestination[] = [
  { to: `${BASE}/home` },
  { to: `${BASE}/sessions`, subtree: true },
  { to: `${BASE}/sessions/profiles`, subtree: true },
  { to: `${BASE}/triggers`, subtree: true },
];
const SESSIONS = [BASE, `${BASE}/sessions`];

describe("deepest destination", () => {
  it("lights Profiles alone under Sessions", () => {
    assert.equal(
      deepestDestination(DESTINATIONS, [...SESSIONS, `${BASE}/sessions/profiles`]),
      `${BASE}/sessions/profiles`,
    );
  });

  it("keeps Sessions lit on its own pages and on pages beneath it that have no destination", () => {
    assert.equal(deepestDestination(DESTINATIONS, SESSIONS), `${BASE}/sessions`);
    assert.equal(
      deepestDestination(DESTINATIONS, [...SESSIONS, `${BASE}/sessions/new`]),
      `${BASE}/sessions`,
    );
  });

  it("matches a destination without a subtree only on the page itself", () => {
    assert.equal(deepestDestination(DESTINATIONS, [`${BASE}/home`]), `${BASE}/home`);
    assert.equal(
      deepestDestination(DESTINATIONS, [`${BASE}/home`, `${BASE}/home/more`]),
      undefined,
    );
  });

  it("ignores a trailing slash and finds nothing outside the destinations", () => {
    assert.equal(deepestDestination(DESTINATIONS, [`${BASE}/triggers/`]), `${BASE}/triggers`);
    assert.equal(deepestDestination(DESTINATIONS, [`${BASE}/settings`]), undefined);
  });

  it("does not depend on the order of the destinations", () => {
    const reversed = DESTINATIONS.toReversed();
    assert.equal(
      deepestDestination(reversed, [...SESSIONS, `${BASE}/sessions/profiles`]),
      `${BASE}/sessions/profiles`,
    );
  });
});
