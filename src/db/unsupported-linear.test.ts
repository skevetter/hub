import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { readUnsupportedLinearReceiptRate } from "./unsupported-linear.js";

const setting = "PASEO_HUB_LINEAR_UNSUPPORTED_RECEIPTS_PER_HOUR";

describe("the unsupported Linear receipt write budget", () => {
  it("defaults to 600 and lets the operator lower the limit", () => {
    assert.equal(readUnsupportedLinearReceiptRate({}), 600);
    assert.equal(readUnsupportedLinearReceiptRate({ [setting]: "" }), 600);
    assert.equal(readUnsupportedLinearReceiptRate({ [setting]: " 40 " }), 40);
  });

  it.each(["0", "601", "-1", "1.5", "unlimited"])("rejects %s at startup", (value) => {
    assert.throws(
      () => readUnsupportedLinearReceiptRate({ [setting]: value }),
      /whole number from 1 to 600/u,
    );
  });
});
