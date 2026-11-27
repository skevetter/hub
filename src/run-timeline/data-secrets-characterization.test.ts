import assert from "node:assert/strict";
import { test } from "vitest";
import { jsonbText } from "./data.js";
import { readTimelineScrubValues } from "./secrets.js";

test("formats positive and negative exponents without scientific notation", () => {
  assert.equal(jsonbText(1.5e21), "1500000000000000000000");
  assert.equal(jsonbText(-1.5e21), "-1500000000000000000000");
  assert.equal(jsonbText(1e-7), "0.0000001");
  assert.equal(jsonbText(-1.5e-7), "-0.00000015");
  assert.equal(jsonbText(-3.5), "-3.5");
  assert.throws(() => jsonbText(Infinity), {
    name: "TypeError",
    message: "Timeline numbers must be finite",
  });
});

test("sorts JSON object keys by encoded length and bytes and rejects unsupported text", () => {
  assert.equal(
    jsonbText({ ab: 1, a: null, "\u00e9": [true, false] }),
    '{"a": null, "ab": 1, "\u00e9": [true, false]}',
  );
  assert.throws(() => jsonbText({ "\u0000": 1 }), {
    name: "TypeError",
    message: "Timeline text must be valid PostgreSQL Unicode text",
  });
  const missing = { entry: true };
  Object.defineProperty(missing, "entry", { value: undefined });
  assert.throws(() => jsonbText(missing), {
    name: "TypeError",
    message: "Cannot convert undefined or null to object",
  });
});

test("preserves scrub inventory order and distinguishes environment and provider values", () => {
  const keyring = '{"one":"first","zero":"","ignored":null,"two":"  next  "}';
  assert.deepEqual(
    readTimelineScrubValues(
      {
        DATABASE_URL: "  first ",
        PASEO_HUB_WEBHOOK_HMAC_KEYRING: keyring,
        GITHUB_APP_PRIVATE_KEY_PATH: "/fixture",
        EMPTY_TOKEN: "",
        MISSING_SECRET: undefined,
        WHITESPACE_KEY: "  ",
        unrelated: "not included",
      },
      [{ privateKey: " raw ", publicKey: "not included", token: "", secret: 1 }],
    ),
    ["  first ", "first", keyring, "  next  ", "  ", " raw "],
  );
  for (const invalid of ["not json", "null", "true", "42"]) {
    assert.deepEqual(readTimelineScrubValues({ PASEO_HUB_WEBHOOK_HMAC_KEYRING: invalid }), [
      invalid,
    ]);
  }
  assert.deepEqual(readTimelineScrubValues({ PASEO_HUB_WEBHOOK_HMAC_KEYRING: '["alpha","",42]' }), [
    '["alpha","",42]',
    "alpha",
  ]);
});
