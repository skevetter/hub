import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { readBillingConfig } from "./config.js";
import { readTimelineScrubValues } from "../run-timeline/secrets.js";
import { createTimelineScrubber } from "../run-timeline/scrub.js";
import { projectTimelineEvent } from "../run-timeline/project.js";

describe("readBillingConfig", () => {
  it("protects raw and effective billing startup credentials accepted by the reader", () => {
    const environment = {
      STRIPE_SECRET_KEY: "  sk_test_mmmmmmmmmmmm  ",
      STRIPE_WEBHOOK_SECRET: "  whsec_mmmmmmmmmmmm  ",
    };
    const configuration = readBillingConfig(environment);
    assert.ok(configuration);
    const values = [
      environment.STRIPE_SECRET_KEY,
      environment.STRIPE_WEBHOOK_SECRET,
      configuration.stripeSecretKey,
      configuration.stripeWebhookSecret,
    ];
    const collected = readTimelineScrubValues(environment);
    for (const value of values) assert.ok(collected.includes(value));
    const projected = projectTimelineEvent(
      {
        kind: "agent_event",
        event: { type: "turn_failed", provider: "claude", error: values.join(" ") },
      },
      createTimelineScrubber({ scrubValues: collected }),
    );
    assert.equal(projected?.kind, "turn_failed");
    const stored = JSON.stringify(projected);
    for (const value of values)
      for (let index = 0; index + 8 <= value.length; index += 1)
        assert.equal(stored.includes(value.slice(index, index + 8)), false);
  });

  it("returns undefined when STRIPE_SECRET_KEY is absent", () => {
    assert.equal(readBillingConfig({}), undefined);
  });

  it("returns undefined when STRIPE_SECRET_KEY is blank", () => {
    assert.equal(readBillingConfig({ STRIPE_SECRET_KEY: "   " }), undefined);
  });

  it("returns a config when both secrets are well-formed", () => {
    assert.deepEqual(
      readBillingConfig({
        STRIPE_SECRET_KEY: "sk_test_abc123",
        STRIPE_WEBHOOK_SECRET: "whsec_abc123",
      }),
      { stripeSecretKey: "sk_test_abc123", stripeWebhookSecret: "whsec_abc123" },
    );
  });

  it("throws when STRIPE_SECRET_KEY does not look like a Stripe secret key", () => {
    assert.throws(
      () =>
        readBillingConfig({
          STRIPE_SECRET_KEY: "not-a-stripe-key",
          STRIPE_WEBHOOK_SECRET: "whsec_abc123",
        }),
      /STRIPE_SECRET_KEY is invalid/,
    );
  });

  it("throws when STRIPE_WEBHOOK_SECRET is missing", () => {
    assert.throws(
      () => readBillingConfig({ STRIPE_SECRET_KEY: "sk_test_abc123" }),
      /STRIPE_WEBHOOK_SECRET is required/,
    );
  });

  it("throws when STRIPE_WEBHOOK_SECRET does not look like a Stripe webhook secret", () => {
    assert.throws(
      () =>
        readBillingConfig({
          STRIPE_SECRET_KEY: "sk_test_abc123",
          STRIPE_WEBHOOK_SECRET: "not-a-webhook-secret",
        }),
      /STRIPE_WEBHOOK_SECRET is invalid/,
    );
  });
});
