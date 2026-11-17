import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { CredentialBackoff, retryAfterMs } from "./backoff.js";
import type { CredentialLocator } from "./types.js";

const locator = (id: number): CredentialLocator => ({ kind: "installation", installationId: id });
const now = Date.parse("2026-11-17T12:00:00Z");

function admitted(backoff: CredentialBackoff, id: number, at = now) {
  const slot = backoff.admit(locator(id), at);
  assert.ok("release" in slot);
  return slot;
}

describe("progress provider backoff", () => {
  it("reads Retry-After seconds and HTTP dates and caps the provider delay", () => {
    assert.equal(retryAfterMs(new Headers({ "retry-after": "37" }), now), 37_000);
    assert.equal(retryAfterMs(new Headers({ "retry-after": "2000" }), now), 900_000);
    assert.equal(
      retryAfterMs(new Headers({ "retry-after": new Date(now + 42000).toUTCString() }), now),
      42_000,
    );
    assert.equal(
      retryAfterMs(new Headers({ "retry-after": new Date(now - 42000).toUTCString() }), now),
      0,
    );
    assert.equal(retryAfterMs(new Headers({ "retry-after": "bad" }), now), undefined);
  });

  it("honors the rate limit reset only if the provider reported zero remaining", () => {
    const headers = new Headers({
      "x-ratelimit-reset": String(now / 1000 + 60),
      "x-ratelimit-remaining": "0",
    });
    assert.equal(retryAfterMs(headers, now), 60_000);
    headers.set("x-ratelimit-remaining", "1");
    assert.equal(retryAfterMs(headers, now), undefined);
  });

  it("caps concurrent calls at four and spaces mutations on one credential by one second", () => {
    const gate = new CredentialBackoff();
    const releases = [1, 2, 3, 4].map((id) => admitted(gate, id));
    assert.ok("waitUntil" in gate.admit(locator(5), now));
    assert.ok("waitUntil" in gate.admit(locator(1), now));
    gate.sent(locator(1), now);
    releases[0]!.release();
    admitted(gate, 5).release();
    assert.deepEqual(gate.admit(locator(1), now + 999), { waitUntil: now + 1000 });
    admitted(gate, 1, now + 1000).release();
  });

  it("shares rate limits and the ten-minute credential circuit only across the same credential", () => {
    const gate = new CredentialBackoff();
    const slot = admitted(gate, 1);
    const logs: string[] = [];
    const rejected = { status: "unavailable", code: "credential_rejected" } as const;
    gate.result(locator(1), now, { status: "retry", afterMs: 55_000, notCreated: true }, () => {});
    slot.release();
    assert.deepEqual(gate.admit(locator(1), now), { waitUntil: now + 55_000 });
    admitted(gate, 2).release();
    const later = now + 55_000;
    const next = admitted(gate, 1, later);
    gate.result(locator(1), later, rejected, () => logs.push("rejected"));
    gate.result(locator(1), later, rejected, () => logs.push("rejected"));
    next.release();
    assert.deepEqual(logs, ["rejected"]);
    assert.deepEqual(gate.admit(locator(1), later + 599_999), { rejected: true });
    admitted(gate, 1, later + 600_000).release();
    admitted(gate, 2, later).release();
  });

  it("applies bounded jitter and resets the exponential delay after success", () => {
    let seed = 13;
    const gate = new CredentialBackoff(() => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    });
    const slot = admitted(gate, 1);
    for (const base of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      const delay = gate.result(locator(1), now, "transient", () => {}) - now;
      assert.ok(delay >= base * 0.8 && delay <= Math.min(600_000, base * 1.2));
    }
    gate.result(locator(1), now, { status: "ok" }, () => {});
    const reset = gate.result(locator(1), now, "transient", () => {}) - now;
    assert.ok(reset >= 24000 && reset <= 36000);
    slot.release();
  });
});
