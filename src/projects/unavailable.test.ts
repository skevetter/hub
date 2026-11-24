import assert from "node:assert/strict";
import { it } from "vitest";
import {
  ORGANIZATION_UNAVAILABLE,
  PROJECT_UNAVAILABLE,
  shouldRetryTenantRead,
} from "./unavailable.js";

it("stops at once when the address names no organization or project", () => {
  assert.equal(shouldRetryTenantRead(0, ORGANIZATION_UNAVAILABLE), false);
  assert.equal(shouldRetryTenantRead(0, PROJECT_UNAVAILABLE), false);
});

it("retries a load failure twice and then stops", () => {
  const message = "Hub couldn't load this organization. Reload the page to try again.";
  assert.equal(shouldRetryTenantRead(0, message), true);
  assert.equal(shouldRetryTenantRead(1, message), true);
  assert.equal(shouldRetryTenantRead(2, message), false);
});

it("retries a request that never reached the server", () => {
  assert.equal(shouldRetryTenantRead(0, null), true);
  assert.equal(shouldRetryTenantRead(2, null), false);
});
