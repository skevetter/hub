import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  connectionState,
  daemonState,
  pillTone,
  runState,
  sessionState,
  enabledState,
  type SessionState,
} from "./state-label.js";

describe("state labels", () => {
  it.each<[string, string, string]>([
    ["running", "Running", "live"],
    ["succeeded", "Succeeded", "done"],
    ["failed", "Failed", "attention"],
    ["timed_out", "Timed out", "attention"],
    ["rejected", "Rejected", "attention"],
    ["canceled", "Canceled", "off"],
  ])("names run %s", (status, label, tone) => {
    assert.deepEqual(runState(status), { label, tone });
  });

  it("reads a status it does not know as off, in sentence case", () => {
    assert.deepEqual(runState("waiting_on_reply"), { label: "Waiting on reply", tone: "off" });
    assert.deepEqual(runState("toString"), { label: "Tostring", tone: "off" });
  });

  it("names connections, with one wording for both reasons to authorize again", () => {
    assert.deepEqual(connectionState("connected"), { label: "Connected", tone: "done" });
    assert.deepEqual(connectionState("notConfigured"), connectionState("disconnected"));
    assert.deepEqual(connectionState("suspended"), connectionState("requiresReauthorization"));
    assert.equal(connectionState("suspended").label, "Needs authorization");
    assert.equal(connectionState("suspended").tone, "attention");
  });

  it("names daemons", () => {
    assert.equal(daemonState("offline").tone, "off");
    assert.equal(daemonState("revoked").tone, "attention");
    assert.equal(daemonState("connected").tone, "done");
  });

  it.each<[SessionState, string, string]>([
    ["starting", "Starting", "live"],
    ["running", "Running", "live"],
    ["idle", "Idle", "off"],
    ["waiting_permission", "Waiting for approval", "attention"],
    ["stopping", "Stopping", "live"],
    ["failed", "Failed", "attention"],
    ["closed", "Closed", "off"],
  ])("names session %s", (state, label, tone) => {
    assert.deepEqual(sessionState(state), { label, tone });
  });

  it("says a session a person stopped is stopped, not idle", () => {
    assert.deepEqual(sessionState("idle", "stopped_by_person"), { label: "Stopped", tone: "off" });
    assert.equal(sessionState("running", "stopped_by_person").label, "Running");
  });

  it("names triggers and profiles", () => {
    assert.deepEqual(enabledState(true), { label: "Enabled", tone: "done" });
    assert.deepEqual(enabledState(false), { label: "Disabled", tone: "off" });
  });

  it("maps each state ink to one pill tone", () => {
    assert.equal(pillTone("attention"), "danger");
    assert.equal(pillTone("live"), "live");
    assert.equal(pillTone("done"), "success");
    assert.equal(pillTone("off"), "neutral");
  });
});
