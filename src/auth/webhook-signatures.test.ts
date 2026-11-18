import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, it, vi } from "vitest";
import {
  deriveSigningSecret,
  parseGitHubSignature,
  readWebhookSigningSettings,
  verifyGitHubSignature,
} from "./webhook-signatures.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

describe("GitHub SHA-256 primitives", () => {
  it("matches the GitHub HMAC vector and refuses invalid digests", () => {
    const secret = "It's a Secret to Everybody";
    const raw = Buffer.from("Hello, World!");
    const header = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    const parsed = parseGitHubSignature(header);
    assert.ok(parsed);
    assert.equal(verifyGitHubSignature(parsed, raw, secret), "current");
    assert.equal(verifyGitHubSignature(parsed, raw, "other", secret), "previous");
    assert.equal(verifyGitHubSignature(parsed, Buffer.from("Hello, World?"), secret), undefined);
    assert.equal(verifyGitHubSignature(parsed.subarray(0, 31), raw, secret), undefined);
    assert.equal(verifyGitHubSignature(parsed, raw, "wrong"), undefined);
    for (const invalid of [
      null,
      header.toUpperCase(),
      header.slice(0, -1),
      header + "g",
      header.slice(0, -1) + "g",
      header + ", " + header,
      header + "\n",
      header.replace("a", "A"),
    ]) {
      assert.equal(parseGitHubSignature(invalid), undefined);
    }
  });

  it("compares both bounded candidates with the timing-safe primitive", () => {
    const digest = parseGitHubSignature(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
    assert.ok(digest);
    const compare = vi.mocked(timingSafeEqual);
    compare.mockClear();
    const body = Buffer.from("Hello, World!");
    assert.equal(verifyGitHubSignature(digest, body, "It's a Secret to Everybody"), "current");
    assert.equal(compare.mock.calls.length, 2);
    assert.ok(
      compare.mock.calls.every(
        ([actual, provided]) => actual.byteLength === 32 && provided.byteLength === 32,
      ),
    );
    assert.equal(verifyGitHubSignature(digest.subarray(1), body, "wrong"), undefined);
    assert.equal(compare.mock.calls.length, 2);
  });

  it("requires both sources of derivation material and binds every identity component", () => {
    const master = Buffer.alloc(32, 1);
    const salt = Buffer.alloc(32, 2).toString("base64url");
    const original = deriveSigningSecret(
      master,
      "master",
      salt,
      "organization",
      "api-key",
      "version",
    );
    assert.match(original, /^paseo_whsec_[A-Za-z0-9_-]{43}$/u);
    for (const changed of [
      deriveSigningSecret(
        Buffer.alloc(32, 3),
        "master",
        salt,
        "organization",
        "api-key",
        "version",
      ),
      deriveSigningSecret(
        master,
        "master",
        Buffer.alloc(32, 3).toString("base64url"),
        "organization",
        "api-key",
        "version",
      ),
      deriveSigningSecret(master, "master", salt, "another", "api-key", "version"),
      deriveSigningSecret(master, "master", salt, "organization", "another", "version"),
      deriveSigningSecret(master, "master", salt, "organization", "api-key", "another"),
    ])
      assert.notEqual(changed, original);
    assert.throws(() =>
      deriveSigningSecret(Buffer.alloc(0), "master", salt, "organization", "api-key", "version"),
    );
    assert.throws(() =>
      deriveSigningSecret(master, "master", "", "organization", "api-key", "version"),
    );
  });

  it("derives noninterchangeable proofs from equal master bytes under different IDs", () => {
    const master = Buffer.alloc(32, 1);
    const salt = Buffer.alloc(32, 2).toString("base64url");
    const first = deriveSigningSecret(
      master,
      "current",
      salt,
      "organization",
      "api-key",
      "version",
    );
    const second = deriveSigningSecret(
      master,
      "replacement",
      salt,
      "organization",
      "api-key",
      "version",
    );
    const body = Buffer.from('{"message":"key ID binding"}');
    const firstProof = createHmac("sha256", first).update(body).digest();
    const secondProof = createHmac("sha256", second).update(body).digest();
    assert.notDeepEqual(firstProof, secondProof);
    assert.equal(verifyGitHubSignature(firstProof, body, first), "current");
    assert.equal(verifyGitHubSignature(secondProof, body, second), "current");
    assert.equal(verifyGitHubSignature(firstProof, body, second), undefined);
    assert.equal(verifyGitHubSignature(secondProof, body, first), undefined);
  });

  it("defaults signing off and validates configuration with fixed errors", () => {
    const defaults = readWebhookSigningSettings({});
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.githubEnabled, false);
    assert.equal(defaults.organizationIds.size, 0);
    assert.throws(
      () => readWebhookSigningSettings({ PASEO_HUB_WEBHOOK_GITHUB_SIGNATURES_ENABLED: "true" }),
      /requires/u,
    );
    assert.throws(
      () => readWebhookSigningSettings({ PASEO_HUB_WEBHOOK_HMAC_ENABLED: "true" }),
      /ACTIVE_KEY_ID/u,
    );
    assert.throws(
      () =>
        readWebhookSigningSettings({ PASEO_HUB_WEBHOOK_HMAC_ORGANIZATION_IDS: '["org","org"]' }),
      /distinct/u,
    );
    assert.throws(
      () =>
        readWebhookSigningSettings({ PASEO_HUB_WEBHOOK_HMAC_KEYRING: "sentinel-keyring-secret" }),
      (error) => {
        assert.doesNotMatch(String(error), /sentinel-keyring-secret/u);
        return true;
      },
    );
  });
});
