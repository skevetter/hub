import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { BrowserDaemon } from "./functions.js";
import { deviceProviders, filterDaemons, profilesByDaemon } from "./device-details.js";

describe("daemon device details", () => {
  it("shows only enabled, ready provider labels and tracks discovery separately", () => {
    const details = deviceProviders([
      { provider: "claude", label: "Claude", status: "ready", enabled: true },
      { provider: "codex", status: "ready", enabled: true },
      { provider: "disabled", status: "ready", enabled: false },
      { provider: "pending", status: "loading", enabled: true },
    ]);
    assert.deepEqual(details, { labels: ["Claude", "codex"], discovering: true });
    assert.deepEqual(deviceProviders([]), { labels: [], discovering: false });
  });

  it("groups profile names by daemon ID", () => {
    const profiles = profilesByDaemon([
      { id: "one", daemonId: "a", name: "Web" },
      { id: "two", daemonId: "b", name: "Web" },
      { id: "three", daemonId: "a", name: "Review" },
    ]);
    assert.deepEqual(profiles.get("a"), [
      { id: "one", name: "Web" },
      { id: "three", name: "Review" },
    ]);
    assert.deepEqual(profiles.get("b"), [{ id: "two", name: "Web" }]);
    assert.equal(profiles.get("missing"), undefined);
  });

  it("combines a case-insensitive name query with device status", () => {
    const daemons: BrowserDaemon[] = [
      daemon("build-desktop", "connected"),
      daemon("build-laptop", "offline"),
      { ...daemon("build-retired", "offline"), status: "revoked" },
    ];
    assert.deepEqual(filterDaemons(daemons, "  BUILD  ", "all"), daemons);
    assert.deepEqual(filterDaemons(daemons, "build", "connected"), [daemons[0]]);
    assert.deepEqual(filterDaemons(daemons, "build", "offline"), [daemons[1]]);
    assert.deepEqual(filterDaemons(daemons, "laptop", "connected"), []);
  });
});

function daemon(slug: string, presence: BrowserDaemon["presence"]): BrowserDaemon {
  return {
    id: slug,
    slug,
    status: "active",
    presence,
    connectedAt: null,
    lastSeenAt: "2026-11-20T18:00:00.000Z",
    registeredAt: "2026-11-20T18:00:00.000Z",
    permissions: [],
  };
}
