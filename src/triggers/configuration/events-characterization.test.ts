import assert from "node:assert/strict";
import { test } from "vitest";
import { EDITOR_EVENTS, eventDefinition, isTriggerableReceiptSource } from "./events.js";

test("preserves the event origins and optional receipt sources", () => {
  const actual = EDITOR_EVENTS.map((id) => {
    const definition = eventDefinition(id);
    return [
      id,
      definition.origin,
      Object.hasOwn(definition, "receiptSource") ? definition.receiptSource : null,
    ];
  });
  assert.deepEqual(actual, [
    ["slack.mention", "provider", null],
    ["discord.mention", "provider", null],
    ["github.issue_created", "provider", null],
    ["github.pull_request_created", "provider", null],
    ["github.pull_request_ready_for_review", "provider", null],
    ["github.pull_request_synchronized", "provider", null],
    ["github.issue_comment_created", "provider", null],
    ["github.pull_request_comment_created", "provider", null],
    ["github.issue_label_added", "provider", null],
    ["github.pull_request_label_added", "provider", null],
    ["github.issue_comment", "provider", null],
    ["github.issues", "provider", null],
    ["github.pull_request", "provider", null],
    ["github.pull_request_review", "provider", null],
    ["github.pull_request_review_comment", "provider", null],
    ["github.push", "provider", null],
    ["linear.issue_entered_scope", "provider", "linear.issue"],
    ["linear.issue_assigned", "provider", "linear.issue"],
    ["linear.comment_created", "provider", "linear.comment"],
    ["github.notification", "hub", null],
    ["schedule.tick", "hub", null],
    ["manual.run", "hub", "webhook.received"],
  ]);
});

test("accepts event IDs and receipt aliases as triggerable sources", () => {
  for (const id of [...EDITOR_EVENTS, "linear.issue", "linear.comment", "webhook.received"]) {
    assert.equal(isTriggerableReceiptSource(id), true, id);
  }
  for (const id of ["", "undefined", "schedule", "toString", "linear.unknown"]) {
    assert.equal(isTriggerableReceiptSource(id), false, id);
  }
});
