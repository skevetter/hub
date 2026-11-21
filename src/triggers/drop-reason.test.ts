import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EDITOR_EVENTS } from "./configuration/events.js";
import {
  RECEIPT_REASON_CODES,
  providerEventDropReasonHint,
  providerEventDropReasonSummary,
} from "./drop-reason.js";

describe("provider event drop reasons", () => {
  it.each(RECEIPT_REASON_CODES)("maps %s to a sentence and actionable hint", (reason) => {
    const sentence = providerEventDropReasonSummary(reason);
    assert.match(sentence ?? "", /^[A-Z].*\.$/u);
    const hint = providerEventDropReasonHint(reason, "linear.comment", "acme");
    assert.match(hint.text, /^[A-Z].*\.$/u);
    assert.notEqual(hint.text, sentence);
  });

  it.each(["no_project_route", "no_trigger_for_source"] as const)(
    "only offers trigger creation for configurable sources with %s",
    (reason) => {
      const configurable = [...EDITOR_EVENTS, "linear.issue", "linear.comment", "webhook.received"];
      for (const source of configurable) {
        assert.equal(providerEventDropReasonHint(reason, source, null).action, "create", source);
      }
      for (const source of [
        "github.check_run",
        "github.workflow_run",
        "github.organization",
        "linear.agent_session",
      ]) {
        const hint = providerEventDropReasonHint(reason, source, "example/repo");
        assert.equal(hint.action, undefined, source);
        assert.match(hint.text, /Hub has no trigger for this event type\./u);
      }
    },
  );
  it("maps stable codes to fixed provider-neutral summaries", () => {
    assert.equal(
      providerEventDropReasonSummary("trigger_filters_rejected"),
      "The event did not pass the configured trigger filters.",
    );
    assert.equal(providerEventDropReasonSummary("PRIVATE-EVENT-BODY"), null);
  });
});
