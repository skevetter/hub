import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  actorFixMessage,
  canRevokeWebhookKey,
  canRotateWebhookKey,
  overlapError,
  overlapSecondsFromMinutes,
  webhookKeyState,
  webhookKeyStatus,
  type WebhookKeyRecord,
} from "./webhook-keys-model.js";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const key = (patch: Partial<WebhookKeyRecord>): WebhookKeyRecord => ({
  id: "6f0f0f4e-0000-4000-8000-000000000001",
  name: "deploy",
  prefix: "paseo_pk_abc",
  scopes: ["events:send"],
  actor: "ci",
  allowedTriggers: ["deploy"],
  createdAt: "2026-11-26T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
  ...patch,
});

describe("webhook key status", () => {
  it("is live when not revoked and not past its expiry", () => {
    assert.equal(webhookKeyStatus(key({}), NOW), "active");
    assert.equal(webhookKeyStatus(key({ expiresAt: "2026-11-26T12:00:01.000Z" }), NOW), "expiring");
    assert.equal(webhookKeyStatus(key({ expiresAt: "2026-11-26T12:00:00.000Z" }), NOW), "expired");
    assert.equal(webhookKeyStatus(key({ expiresAt: "2026-11-26T11:00:00.000Z" }), NOW), "expired");
  });

  it("reads revoked before expiry", () => {
    const revoked = key({
      revokedAt: "2026-11-26T11:00:00.000Z",
      expiresAt: "2026-11-27T00:00:00.000Z",
    });
    assert.equal(webhookKeyStatus(revoked, NOW), "revoked");
  });

  it("allows rotation only for a key that is not already expiring", () => {
    assert.deepEqual(
      (["active", "expiring", "expired", "revoked"] as const).map(canRotateWebhookKey),
      [true, false, false, false],
    );
    assert.deepEqual(
      (["active", "expiring", "expired", "revoked"] as const).map(canRevokeWebhookKey),
      [true, true, false, false],
    );
  });

  it("names each state once", () => {
    assert.equal(webhookKeyState("expired").label, "Expired");
    assert.equal(webhookKeyState("expiring").tone, "live");
  });
});

describe("rotation overlap", () => {
  it("converts whole minutes from 0 to 1440 into seconds", () => {
    assert.equal(overlapSecondsFromMinutes("60"), 3600);
    assert.equal(overlapSecondsFromMinutes("0"), 0);
    assert.equal(overlapSecondsFromMinutes("1440"), 86400);
  });

  it("refuses anything else", () => {
    for (const value of ["", " ", "-1", "1.5", "1441", "abc", "1e3"]) {
      assert.equal(overlapSecondsFromMinutes(value), null, value);
      assert.match(overlapError(value) ?? "", /0 to 1440/u);
    }
    assert.equal(overlapError("60"), undefined);
  });
});

describe("actor warning", () => {
  it("names the actor and how to fix it", () => {
    assert.match(actorFixMessage("ci"), /allow ci\. Add it to from_users/u);
    assert.match(actorFixMessage(null), /this key's actor/u);
  });
});
