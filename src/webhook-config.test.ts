import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { DEFAULT_WEBHOOK_OPTIONS, readWebhookOptions } from "./webhook-config.js";

const settings = [
  ["maxBytes", "PASEO_HUB_WEBHOOK_MAX_BYTES", 1_024, 1_048_576],
  ["ratePerMinute", "PASEO_HUB_WEBHOOK_RATE_PER_MINUTE", 1, 6_000],
  ["burst", "PASEO_HUB_WEBHOOK_BURST", 1, 1_000],
  ["maxActiveRuns", "PASEO_HUB_WEBHOOK_MAX_ACTIVE_RUNS", 1, 1_000],
] as const;

describe("webhook options", () => {
  it("uses the defaults only for unset settings", () => {
    assert.deepEqual(DEFAULT_WEBHOOK_OPTIONS, {
      maxBytes: 262_144,
      ratePerMinute: 120,
      burst: 30,
      maxActiveRuns: 25,
    });
    assert.deepEqual(readWebhookOptions({}), DEFAULT_WEBHOOK_OPTIONS);
    assert.deepEqual(
      readWebhookOptions({ PASEO_HUB_WEBHOOK_BURST: undefined }),
      DEFAULT_WEBHOOK_OPTIONS,
    );
  });

  it("reads every setting and trims numeric values", () => {
    assert.deepEqual(
      readWebhookOptions({
        PASEO_HUB_WEBHOOK_MAX_BYTES: " 524288 ",
        PASEO_HUB_WEBHOOK_RATE_PER_MINUTE: "240",
        PASEO_HUB_WEBHOOK_BURST: "50",
        PASEO_HUB_WEBHOOK_MAX_ACTIVE_RUNS: "40",
      }),
      { maxBytes: 524_288, ratePerMinute: 240, burst: 50, maxActiveRuns: 40 },
    );
  });

  for (const [field, name, min, max] of settings) {
    it(`accepts both inclusive bounds for ${name}`, () => {
      assert.equal(readWebhookOptions({ [name]: String(min) })[field], min);
      assert.equal(readWebhookOptions({ [name]: String(max) })[field], max);
    });

    it(`rejects invalid ${name} values with the exact setting and range`, () => {
      for (const value of [
        "",
        " ",
        "NaN",
        "Infinity",
        "ten",
        "2.5",
        "1.0",
        "1e3",
        "0x10",
        "+1",
        "-1",
        "3s",
        "9007199254740993",
        String(min - 1),
        String(max + 1),
      ]) {
        assert.throws(
          () => readWebhookOptions({ [name]: value }),
          new Error(`${name} must be a whole number from ${min} to ${max}, got "${value.trim()}".`),
        );
      }
    });
  }
});
