import assert from "node:assert/strict";
import { it } from "vitest";
import { billingNoticeSince, executionLimitNoticeMarker } from "./billing-notice.js";

it("looks back ten minutes and rounds the lower bound down to a whole second", () => {
  assert.equal(billingNoticeSince("2026-08-06T11:02:03.987Z"), "2026-08-06T10:52:03Z");
});

it("omits the lower bound when the receipt time is invalid", () => {
  assert.equal(billingNoticeSince("not a date"), undefined);
});

it("escapes consecutive hyphens and angle brackets inside the HTML marker", () => {
  assert.equal(
    executionLimitNoticeMarker("id-->%2D", 92),
    "<!-- paseo-notice:execution-limit:id%2D%2D%3E%252D:92 -->",
  );
});
