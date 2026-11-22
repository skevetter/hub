import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { thingsToTry } from "./things-to-try.js";

const nothing = { connections: [], triggers: [], sessions: null };
const linear = {
  provider: "linear" as const,
  slug: "acme",
  label: "Acme",
  needsAuthorization: false,
};

describe("things to try", () => {
  it("offers Linear and GitHub, and sessions only while the feature is on", () => {
    assert.deepEqual(
      thingsToTry(nothing).map(({ key }) => key),
      ["linear", "github"],
    );
    assert.deepEqual(
      thingsToTry(
        {
          ...nothing,
          sessions: { open: 0, openCapped: false, started: false },
        },
        0,
      ).map(({ key }) => key),
      ["linear", "github", "sessions"],
    );
  });

  it("sends the reader to connect an app that is not connected", () => {
    const [surface] = thingsToTry(nothing);
    assert.deepEqual(surface?.next, { label: "Connect Linear", path: "connections" });
    assert.match(surface?.where ?? "", /not connected yet/u);
  });

  it("asks only for a connection when a comment trigger already exists", () => {
    const trigger = {
      id: "t",
      name: "review",
      enabled: true,
      event: "github.pull_request_comment_created",
      commentEvents: [
        {
          on: "github.pull_request_comment_created",
          hasReplyOutput: true,
          commentPrefix: "/paseo",
        },
      ],
    };
    const surface = thingsToTry({ ...nothing, triggers: [trigger] })[1];
    assert.deepEqual(surface?.next, { label: "Connect GitHub", path: "connections" });
    assert.doesNotMatch(surface?.where ?? "", /create a comment trigger/iu);
  });

  it("sends the reader to create a trigger when nothing enabled listens to the app", () => {
    const paused = {
      id: "t",
      name: "triage",
      event: "linear.comment_created",
      enabled: false,
      commentEvents: [{ on: "linear.comment_created", hasReplyOutput: true, commentPrefix: null }],
    };
    const [surface] = thingsToTry({ ...nothing, connections: [linear], triggers: [paused] });
    assert.deepEqual(surface?.next, { label: "New trigger", path: "triggers/new" });
    assert.match(surface?.where ?? "", /Acme is connected/u);
  });

  it("names the workspace and the trigger once both exist, and asks for nothing more", () => {
    const github = { ...linear, provider: "github" as const };
    const trigger = {
      id: "t",
      name: "triage",
      event: "github.issue_comment_created",
      enabled: true,
      commentEvents: [
        { on: "github.issue_comment_created", hasReplyOutput: true, commentPrefix: "" },
      ],
    };
    const surface = thingsToTry({ ...nothing, connections: [github], triggers: [trigger] })[1];
    assert.equal(surface?.next, undefined);
    assert.match(surface?.where ?? "", /Comment on an issue in Acme/u);
    assert.match(surface?.where ?? "", /where triage is configured to run/u);
  });

  it("does not ask for a comment when the only enabled trigger listens for assignments", () => {
    const trigger = { id: "t", name: "on-assign", event: "linear.issue_assigned", enabled: true };
    const [surface] = thingsToTry({ ...nothing, connections: [linear], triggers: [trigger] });
    assert.doesNotMatch(surface?.where ?? "", /Comment on an issue/u);
    assert.deepEqual(surface?.next, { label: "New trigger", path: "triggers/new" });
  });

  it("requires the reply output on the trigger that listens to comments", () => {
    const triggers = [
      {
        id: "t",
        name: "triage",
        event: "linear.comment_created",
        enabled: true,
        commentEvents: [
          { on: "linear.comment_created", hasReplyOutput: false, commentPrefix: null },
        ],
      },
      { id: "assign", name: "assign", event: "linear.issue_assigned", enabled: true },
    ];
    const [surface] = thingsToTry({ ...nothing, connections: [linear], triggers });
    assert.match(surface?.where ?? "", /triage needs a reply output/u);
    assert.doesNotMatch(surface?.where ?? "", /Comment on an issue/u);
  });

  it("offers pull request prompts for a pull request comment trigger without promising a push", () => {
    const github = { ...linear, provider: "github" as const };
    const trigger = {
      id: "t",
      name: "checks",
      event: "github.pull_request_comment_created",
      enabled: true,
      commentEvents: [
        { on: "github.pull_request_comment_created", hasReplyOutput: true, commentPrefix: "" },
      ],
    };
    const surface = thingsToTry({
      ...nothing,
      connections: [github],
      triggers: [trigger],
    })[1];
    assert.match(surface?.where ?? "", /Comment on a pull request in Acme/u);
    assert.equal(surface?.examples.length, 3);
    assert.doesNotMatch(surface?.examples.map(({ prompt }) => prompt).join(" ") ?? "", /push/u);
    assert.match(
      surface?.examples.map(({ prompt }) => prompt).join(" ") ?? "",
      /checks.*cause.*proposed fix/u,
    );
  });

  it("offers issue prompts for a GitHub issue comment trigger", () => {
    const github = { ...linear, provider: "github" as const };
    const trigger = {
      id: "t",
      name: "triage",
      event: "github.issue_comment_created",
      enabled: true,
      commentEvents: [
        { on: "github.issue_comment_created", hasReplyOutput: true, commentPrefix: "" },
      ],
    };
    const surface = thingsToTry({
      ...nothing,
      connections: [github],
      triggers: [trigger],
    })[1];
    assert.match(surface?.where ?? "", /Comment on an issue in Acme/u);
    assert.equal(surface?.examples.length, 3);
    assert.doesNotMatch(
      surface?.examples.map(({ prompt }) => prompt).join(" ") ?? "",
      /pull request/u,
    );
  });

  it("does not count a GitHub notification trigger as listening to repository comments", () => {
    const github = { ...linear, provider: "github" as const };
    const inbox = { id: "t", name: "inbox", event: "github.notification", enabled: true };
    const surface = thingsToTry({ ...nothing, connections: [github], triggers: [inbox] })[1];
    assert.deepEqual(surface?.next, { label: "New trigger", path: "triggers/new" });
  });

  it("points a session at a profile first, then at a new session", () => {
    const sessions = { open: 0, openCapped: false, started: false };
    assert.deepEqual(thingsToTry({ ...nothing, sessions }, 0, true)[2]?.next, {
      label: "Create a profile",
      path: "sessions/profiles",
    });
    assert.deepEqual(thingsToTry({ ...nothing, sessions }, 2)[2]?.next, {
      label: "New session",
      path: "sessions/new",
    });
  });

  it("gives every surface three prompts that need nothing filled in", () => {
    const sessions = { open: 0, openCapped: false, started: false };
    for (const surface of thingsToTry({ ...nothing, sessions }, 1)) {
      assert.equal(surface.examples.length, 3);
      for (const { prompt } of surface.examples) assert.doesNotMatch(prompt, /[<>{}[\]]/u);
    }
  });
});
