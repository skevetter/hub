import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { composeEntitlements } from "./entitlements.js";
import { createAuthServer, type AuthServer } from "./server.js";

const baseURL = "https://hub.example.test";
const cookie = { cookie: "session=test" };
const missingOrigin = { message: "Missing or null Origin", code: "MISSING_OR_NULL_ORIGIN" };
const invalidOrigin = { message: "Invalid origin", code: "INVALID_ORIGIN" };

interface CookieMutationCase {
  name: string;
  method?: string;
  headers?: HeadersInit;
  requireOrigin?: boolean;
  expected?: { message: string; code: string };
}

describe("cookie mutation origin checks", () => {
  let auth: AuthServer;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "hub-cookie-mutation-"));
    const { runtime, locks } = await embeddedDatabaseRuntime(join(directory, "database"));
    const entitlements = composeEntitlements(createDatabase(runtime, locks), runtime);
    cleanup = async () => {
      await entitlements.close();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    };
    auth = createAuthServer({
      database: runtime,
      locks,
      entitlements: entitlements.service,
      secret: "cookie-mutation-test-secret".padEnd(32, "-"),
      baseURL,
    });
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it.each<CookieMutationCase>([
    { name: "allows non-POST requests", method: "GET", headers: cookie, requireOrigin: true },
    { name: "allows a cookieless POST by default" },
    {
      name: "requires an origin for a cookieless POST when requested",
      requireOrigin: true,
      expected: missingOrigin,
    },
    {
      name: "checks fetch metadata before looking for an origin",
      headers: { ...cookie, "sec-fetch-site": "cross-site" },
      expected: {
        message: "Cross-site navigation login blocked. This request appears to be a CSRF attack.",
        code: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
      },
    },
    { name: "rejects a missing origin and referer", headers: cookie, expected: missingOrigin },
    {
      name: "rejects a null origin even with a referer",
      headers: { ...cookie, origin: "null", referer: baseURL },
      expected: missingOrigin,
    },
    { name: "allows a matching origin", headers: { ...cookie, origin: baseURL } },
    {
      name: "falls back to the referer URL by default",
      headers: { ...cookie, referer: `${baseURL}/account` },
    },
    {
      name: "ignores the referer when an origin is required",
      headers: { ...cookie, referer: baseURL },
      requireOrigin: true,
      expected: missingOrigin,
    },
    {
      name: "allows an exact origin when required",
      headers: { origin: baseURL },
      requireOrigin: true,
    },
    {
      name: "requires an exact origin rather than a URL",
      headers: { origin: `${baseURL}/account` },
      requireOrigin: true,
      expected: invalidOrigin,
    },
    {
      name: "rejects an origin from another site",
      headers: { ...cookie, origin: "https://other.example.test" },
      expected: invalidOrigin,
    },
    {
      name: "rejects a malformed origin",
      headers: { ...cookie, origin: "not a URL" },
      expected: invalidOrigin,
    },
  ])("$name", async ({ method = "POST", headers, requireOrigin = false, expected }) => {
    const request = new Request(`${baseURL}/account`, {
      method,
      ...(headers === undefined ? {} : { headers }),
    });
    const rejected = auth.rejectCookieMutation(request, { requireOrigin });
    if (expected === undefined) {
      assert.equal(rejected, undefined);
    } else {
      assert.equal(rejected?.status, 403);
      assert.deepEqual(await rejected.json(), expected);
    }
  });
});
