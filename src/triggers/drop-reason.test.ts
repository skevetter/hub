import assert from "node:assert/strict";
import { describe, it } from "vitest";
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

  it("maps stable codes to fixed provider-neutral summaries", () => {
    assert.equal(
      providerEventDropReasonSummary("trigger_filters_rejected"),
      "The event did not pass the configured trigger filters.",
    );
    assert.equal(providerEventDropReasonSummary("PRIVATE-EVENT-BODY"), null);
  });
});
