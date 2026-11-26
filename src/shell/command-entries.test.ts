import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { commandActions, matchCommand, pageKeywords } from "./command-entries.js";

describe("command menu entries", () => {
  it("adds words people type to the pages that hold them", () => {
    assert.ok(pageKeywords("acme", "/o/acme/triggers").includes("webhook"));
    assert.ok(pageKeywords("acme", "/o/acme/settings/api-keys").includes("token"));
    assert.deepEqual(pageKeywords("acme", "/o/acme/home"), []);
    assert.deepEqual(pageKeywords("acme", "/o/other/triggers"), []);
  });

  it("offers create actions only where the page and the right exist", () => {
    const labels = (manageResources: boolean, sessionsEnabled: boolean) =>
      commandActions({ slug: "acme", manageResources, sessionsEnabled }).map(({ label }) => label);
    assert.deepEqual(labels(true, true), ["New trigger", "Create API key", "New session"]);
    assert.deepEqual(labels(true, false), ["New trigger", "Create API key"]);
    assert.deepEqual(labels(false, true), ["New session"]);
    assert.deepEqual(labels(false, false), []);
  });

  it("points every action at an organization page", () => {
    for (const { to } of commandActions({
      slug: "acme",
      manageResources: true,
      sessionsEnabled: true,
    })) {
      assert.ok(to.startsWith("/o/acme/"));
    }
  });

  it("matches keywords as plain substrings and labels fuzzily", () => {
    const words = ["webhook", "provider"];
    assert.ok(matchCommand("Connections Setup", "conn", words) > 0.1);
    assert.ok(matchCommand("Connections Setup", "webhook", words) > 0);
    assert.equal(matchCommand("Connections Setup", "orbit", words), 0);
    assert.equal(matchCommand("Connections Setup", "", words) > 0, true);
  });
});
