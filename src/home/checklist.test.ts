import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveChecklist, type ChecklistFacts } from "./checklist.js";

const nothing: ChecklistFacts = {
  appsConfigured: true,
  connections: [],
  daemons: [],
  triggers: [],
  runs: [],
  sessionStarted: null,
};

function states(facts: ChecklistFacts) {
  return deriveChecklist(facts).steps.map((step) => step.state);
}

describe("the onboarding checklist", () => {
  it("starts with every step pending on a hosted Hub whose apps exist", () => {
    const checklist = deriveChecklist(nothing);
    assert.deepEqual(
      checklist.steps.map((step) => step.state),
      ["pending", "pending", "pending", "pending"],
    );
    assert.equal(checklist.completed, 0);
    assert.equal(checklist.complete, false);
  });

  it("sends a self-hosted operator to app setup when no provider app is configured", () => {
    assert.equal(states({ ...nothing, appsConfigured: false })[0], "setup");
  });

  it("marks the app step done by a connection, whatever the app situation", () => {
    const snapshot = {
      ...nothing,
      connections: [
        { provider: "github" as const, slug: "acme", label: "acme", needsAuthorization: false },
      ],
    };
    assert.equal(states(snapshot)[0], "done");
    assert.equal(states({ ...snapshot, appsConfigured: false })[0], "done");
  });

  it("keeps the app step unfinished when every connection requires authorization", () => {
    assert.notEqual(
      states({
        ...nothing,
        connections: [
          { provider: "github", slug: "acme", label: "Acme", needsAuthorization: true },
        ],
      })[0],
      "done",
    );
  });

  it("tells a daemon that cannot run agents apart from no daemon at all", () => {
    const laptop = { id: "1", slug: "laptop", presence: "connected" as const, canExecute: false };
    const devbox = { id: "2", slug: "devbox", presence: "offline" as const, canExecute: true };
    assert.equal(states({ ...nothing, daemons: [laptop] })[1], "cannotRun");
    assert.equal(states({ ...nothing, daemons: [laptop, devbox] })[1], "done");
  });

  it("completes and counts once a trigger exists and has run", () => {
    const checklist = deriveChecklist({
      appsConfigured: true,
      connections: [{ provider: "slack", slug: "acme", label: "Acme", needsAuthorization: false }],
      daemons: [{ id: "2", slug: "devbox", presence: "connected", canExecute: true }],
      triggers: [{ id: "t", name: "slack-help", event: "slack.mention", enabled: true }],
      sessionStarted: null,
      runs: [
        {
          id: "r",
          triggerName: "slack-help",
          provider: "slack",
          source: "slack.mention",
          status: "succeeded",
          receivedAt: "2026-09-21T12:00:00.000Z",
          agent: { provider: "codex", model: "gpt-5.4" },
        },
      ],
    });
    assert.equal(checklist.completed, 4);
    assert.equal(checklist.complete, true);
  });

  it("keeps the four automation steps, in order, while sessions are off", () => {
    assert.deepEqual(
      deriveChecklist(nothing).steps.map(({ key }) => key),
      ["app", "daemon", "trigger", "run"],
    );
  });

  it("leads with the daemon and adds the two session steps when sessions are on", () => {
    const checklist = deriveChecklist({ ...nothing, sessionStarted: false }, 0);
    assert.deepEqual(
      checklist.steps.map(({ key }) => key),
      ["daemon", "profile", "session", "app", "trigger", "run"],
    );
    assert.equal(checklist.complete, false);

    const underway = deriveChecklist({ ...nothing, sessionStarted: true }, 1);
    assert.deepEqual(
      underway.steps.filter(({ state }) => state === "done").map(({ key }) => key),
      ["profile", "session"],
    );
    assert.equal(underway.completed, 2);
  });
});
