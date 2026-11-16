import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { z } from "zod";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "../db/runtime/index.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import {
  apiKeyActorSchema,
  apiKeyAllowedTriggersSchema,
  apiKeyCreateSchema,
  defaultApiKeyActor,
  type ApiKeyIdentityOptions,
} from "./api-key-contract.js";
import { createAuthServer, type AuthServer } from "./server.js";

const ORIGIN = "http://localhost:3000";
const keySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  actor: apiKeyActorSchema.nullable(),
  allowedTriggers: apiKeyAllowedTriggersSchema.nullable(),
  scopes: z.array(z.string()),
});
const keyResponseSchema = z.object({ key: keySummarySchema, secret: z.string() });

const invalidIdentities: ApiKeyIdentityOptions[] = [
  { actor: "Uppercase" },
  { actor: ".leading-dot" },
  { actor: "-leading-hyphen" },
  { actor: "has space" },
  { actor: "" },
  { actor: "a".repeat(64) },
  { actor: null },
  { allowedTriggers: ["Uppercase"] },
  { allowedTriggers: ["1-leading-digit"] },
  { allowedTriggers: ["contains.dot"] },
  { allowedTriggers: [""] },
  { allowedTriggers: ["duplicate", "duplicate"] },
  { allowedTriggers: Array.from({ length: 51 }, (_, index) => `trigger-${index}`) },
];

describe("API key identity contracts", () => {
  it.each([
    ["  CI Partner / Build  ", "ci-partner-build"],
    ["--CI...Partner__Build--", "ci...partner__build"],
    ["9 Builds", "9-builds"],
    ["a".repeat(70), "a".repeat(63)],
    ["!!!", ""],
    [".CI Partner", ".ci-partner"],
  ])("normalizes the actor slug for %s", (name, expected) => {
    assert.equal(defaultApiKeyActor(name), expected);
  });

  it("validates actor defaults and explicit identity overrides", () => {
    assert.deepEqual(apiKeyCreateSchema.parse({ name: " CI Partner ", scopes: ["events:send"] }), {
      name: "CI Partner",
      scopes: ["events:send"],
      actor: "ci-partner",
      allowedTriggers: null,
    });
    for (const name of ["!!!", ".leading", "_leading"]) {
      assert.equal(apiKeyCreateSchema.safeParse({ name, scopes: ["events:send"] }).success, false);
      assert.equal(
        apiKeyCreateSchema.safeParse({ name, scopes: ["events:send"], actor: "explicit" }).success,
        true,
      );
    }
    assert.equal(
      apiKeyCreateSchema.safeParse({
        name: "Reader",
        scopes: ["projects:read"],
        actor: null,
      }).success,
      true,
    );
    assert.equal(
      apiKeyCreateSchema.safeParse({
        name: "Sender",
        scopes: ["events:send", "events:send"],
      }).success,
      false,
    );
    assert.equal(
      apiKeyCreateSchema.safeParse({
        name: "Sender",
        scopes: ["events:send"],
        unexpected: true,
      }).success,
      false,
    );
    assert.equal(apiKeyAllowedTriggersSchema.safeParse([]).success, true);
    assert.equal(
      apiKeyAllowedTriggersSchema.safeParse(
        Array.from({ length: 50 }, (_, index) => `trigger_${index}`),
      ).success,
      true,
    );
    assert.equal(apiKeyActorSchema.safeParse("0.actor_name-1").success, true);
    assert.equal(apiKeyActorSchema.safeParse("a".repeat(63)).success, true);
    for (const identity of invalidIdentities) {
      assert.equal(
        apiKeyCreateSchema.safeParse({
          name: "Sender",
          scopes: ["events:send"],
          ...identity,
        }).success,
        false,
      );
    }
  });
});

describe("embedded API key identities", () => {
  let directory: string;
  let runtime: DatabaseRuntime;
  let auth: AuthServer;
  let cookie: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hub-webhook-keys-"));
    const bundle = await embeddedDatabaseRuntime(join(directory, "database"));
    runtime = bundle.runtime;
    await runtime.migrate();
    await runtime.query(`
      insert into organization (id, name, slug) values
        ('identity-a', 'Identity A', 'identity-a'),
        ('identity-b', 'Identity B', 'identity-b');
    `);
    await runtime.query(`
      insert into "user" (id, name, email, email_verified) values
        ('identity-owner-a', 'Owner A', 'identity-a@example.test', true),
        ('identity-owner-b', 'Owner B', 'identity-b@example.test', true);
    `);
    await runtime.query(`
      insert into member (id, organization_id, user_id, role) values
        ('identity-member-a', 'identity-a', 'identity-owner-a', 'owner'),
        ('identity-member-b', 'identity-b', 'identity-owner-b', 'owner');
    `);
    auth = createAuthServer({
      database: runtime,
      locks: bundle.locks,
      entitlements: createUnlimitedEntitlementsService(),
      secret: "webhook-key-test-auth-secret-at-least-32-characters",
      baseURL: ORIGIN,
      policy: { registrationMode: "open", organizationCreation: "disabled", bootstrap: undefined },
    });
    const signup = await auth.handle(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Browser owner",
          email: "identity-browser@example.test",
          password: "identity-browser-password",
        }),
      }),
    );
    assert.equal(signup.status, 200);
    const sessionCookie = signup.headers.get("set-cookie")?.match(/^[^;]+/u)?.[0];
    assert.ok(sessionCookie);
    cookie = sessionCookie;
    await runtime.query(`
      insert into member (id, organization_id, user_id, role)
      select 'identity-browser-member', 'identity-a', id, 'owner'
      from "user" where email = 'identity-browser@example.test'
    `);
    const selected = await browserRequest("/api/auth/paseo/select-organization", {
      organizationId: "identity-a",
    });
    assert.equal(selected.status, 200);
  }, 120_000);

  afterAll(async () => {
    await auth?.close();
    await runtime?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }, 120_000);

  it("rejects invalid actors and trigger lists at creation without storing keys", async () => {
    const before = (await auth.apiKeys!.list("identity-a")).length;
    for (const identity of invalidIdentities) {
      await assert.rejects(
        auth.apiKeys!.create(
          "identity-a",
          "identity-owner-a",
          "Invalid sender",
          ["events:send"],
          undefined,
          identity,
        ),
        z.ZodError,
      );
      const response = await browserRequest("/api/auth/paseo/api-keys", {
        name: "Invalid sender",
        scopes: ["events:send"],
        ...identity,
      });
      assert.equal(response.status, 400);
    }
    await assert.rejects(
      auth.apiKeys!.create("identity-a", "identity-owner-a", "!!!", ["events:send"]),
      z.ZodError,
    );
    assert.equal((await auth.apiKeys!.list("identity-a")).length, before);
  });

  it("serializes default and explicit identities on create and list without revealing stored secrets", async () => {
    const createdResponse = await browserRequest("/api/auth/paseo/api-keys", {
      name: "Partner Build",
      scopes: ["events:send"],
      actor: "ci-partner",
      allowedTriggers: ["build-finished", "release_ready"],
    });
    assert.equal(createdResponse.status, 201);
    const created = keyResponseSchema.parse(await createdResponse.json());
    assert.equal(created.key.actor, "ci-partner");
    assert.deepEqual(created.key.allowedTriggers, ["build-finished", "release_ready"]);
    const defaultResponse = await browserRequest("/api/auth/paseo/api-keys", {
      name: "Default Sender",
      scopes: ["events:send"],
    });
    assert.equal(defaultResponse.status, 201);
    const defaultKey = keyResponseSchema.parse(await defaultResponse.json());
    assert.equal(defaultKey.key.actor, "default-sender");
    assert.equal(defaultKey.key.allowedTriggers, null);
    const listedResponse = await browserRequest("/api/auth/paseo/api-keys");
    assert.equal(listedResponse.status, 200);
    const listedBody: unknown = await listedResponse.json();
    const listed = z.object({ keys: z.array(keySummarySchema) }).parse(listedBody);
    assert.deepEqual(
      listed.keys.find(({ id }) => id === created.key.id),
      created.key,
    );
    assert.equal(JSON.stringify(listedBody).includes(created.secret), false);
    assert.equal(JSON.stringify(listedBody).includes(defaultKey.secret), false);
    const stored = (await auth.apiKeys!.list("identity-a")).find(({ id }) => id === created.key.id);
    assert.equal(stored?.actor, "ci-partner");
    assert.deepEqual(stored?.allowedTriggers, created.key.allowedTriggers);
  });

  it("preserves positional transactions and permits identities on other scopes", async () => {
    const positional = await runtime.transaction((client) =>
      auth.apiKeys!.create(
        "identity-a",
        "identity-owner-a",
        "Positional reader",
        ["projects:read"],
        client,
      ),
    );
    assert.equal(positional.summary.actor, "positional-reader");
    assert.equal(positional.summary.allowedTriggers, null);
    const explicit = await auth.apiKeys!.create(
      "identity-a",
      "identity-owner-a",
      "Bound dispatcher",
      ["runs:dispatch"],
      undefined,
      { actor: "ci-partner", allowedTriggers: [] },
    );
    assert.equal(explicit.summary.actor, "ci-partner");
    assert.deepEqual(explicit.summary.allowedTriggers, []);
    const unbound = await auth.apiKeys!.create(
      "identity-a",
      "identity-owner-a",
      "Unbound reader",
      ["projects:read"],
      undefined,
      { actor: null },
    );
    assert.equal(unbound.summary.actor, null);
  });

  it("keeps API-key authorization tenant-scoped, header-only, scope-checked, and revocable", async () => {
    const created = await auth.apiKeys!.create(
      "identity-a",
      "identity-owner-a",
      "Tenant sender",
      ["events:send"],
      undefined,
      { actor: "tenant-a", allowedTriggers: ["build-finished"] },
    );
    const other = await auth.apiKeys!.create("identity-b", "identity-owner-b", "Tenant sender", [
      "events:send",
    ]);
    const authorized = await auth.publicCredentials!.authorize(
      bearerRequest(created.secret),
      "events:send",
    );
    assert.deepEqual(authorized, {
      status: "authorized",
      access: {
        kind: "apiKey",
        credentialId: created.summary.id,
        organizationId: "identity-a",
        scopes: ["events:send"],
        actor: "tenant-a",
        allowedTriggers: ["build-finished"],
      },
    });
    const otherAuthorization = await auth.publicCredentials!.authorize(
      bearerRequest(other.secret),
      "events:send",
    );
    assert.equal(otherAuthorization.status, "authorized");
    if (otherAuthorization.status === "authorized") {
      assert.equal(otherAuthorization.access.organizationId, "identity-b");
    }
    assert.equal(
      (await auth.apiKeys!.list("identity-a")).some(({ id }) => id === other.summary.id),
      false,
    );
    assert.equal(
      (await auth.publicCredentials!.authorize(bearerRequest(created.secret), "runs:dispatch"))
        .status,
      "forbidden",
    );
    assert.equal(
      (
        await auth.publicCredentials!.authorize(
          bearerRequest(`${created.summary.prefix}_wrong`),
          "events:send",
        )
      ).status,
      "unauthorized",
    );
    const queryCredential = new URL(`${ORIGIN}/api/v1/hooks/build-finished`);
    queryCredential.searchParams.set("api_key", created.secret);
    assert.equal(
      (await auth.publicCredentials!.authorize(new Request(queryCredential), "events:send")).status,
      "unauthorized",
    );
    assert.equal(await auth.apiKeys!.revoke("identity-b", created.summary.id), false);
    assert.equal(await auth.apiKeys!.revoke("identity-a", created.summary.id), true);
    assert.equal(
      (await auth.publicCredentials!.authorize(bearerRequest(created.secret), "events:send"))
        .status,
      "unauthorized",
    );
  });

  it("preserves null identity on raw legacy rows and omits identity on CLI authorization", async () => {
    const legacyId = randomUUID();
    const legacyPrefix = "paseo_pk_legacy000001";
    const legacySecret = `${legacyPrefix}_fake-legacy-secret`;
    await runtime.query(
      `insert into organization_api_keys
         (id, organization_id, name, prefix, verifier, scopes, created_by_user_id)
       values ($1, 'identity-a', 'Legacy key', $2, $3, $4, 'identity-owner-a')`,
      [legacyId, legacyPrefix, verifier(legacySecret), ["runs:dispatch"]],
    );
    const listed = (await auth.apiKeys!.list("identity-a")).find(({ id }) => id === legacyId);
    assert.equal(listed?.actor, null);
    assert.equal(listed?.allowedTriggers, null);
    const response = await browserRequest("/api/auth/paseo/api-keys");
    assert.equal(response.status, 200);
    const browserList = z.object({ keys: z.array(keySummarySchema) }).parse(await response.json());
    const browserLegacy = browserList.keys.find(({ id }) => id === legacyId);
    assert.equal(browserLegacy?.actor, null);
    assert.equal(browserLegacy?.allowedTriggers, null);
    const legacy = await auth.publicCredentials!.authorize(
      bearerRequest(legacySecret),
      "runs:dispatch",
    );
    assert.equal(legacy.status, "authorized");
    if (legacy.status === "authorized") {
      assert.equal(legacy.access.actor, null);
      assert.equal(legacy.access.allowedTriggers, null);
    }
    const cliId = randomUUID();
    const cliPrefix = "paseo_cli_legacy000001";
    const cliSecret = `${cliPrefix}_fake-cli-secret`;
    await runtime.query(
      `insert into organization_cli_credentials
         (id, organization_id, prefix, verifier, created_by_user_id)
       values ($1, 'identity-a', $2, $3, 'identity-owner-a')`,
      [cliId, cliPrefix, verifier(cliSecret)],
    );
    const cli = await auth.publicCredentials!.authorize(bearerRequest(cliSecret), "events:send");
    assert.equal(cli.status, "authorized");
    if (cli.status === "authorized") {
      assert.equal(cli.access.kind, "cliCredential");
      assert.equal(Object.hasOwn(cli.access, "actor"), false);
      assert.equal(Object.hasOwn(cli.access, "allowedTriggers"), false);
    }
  });

  it("writes last use once per minute under a burst and refreshes stale rows only after successful authorization", async () => {
    const created = await auth.apiKeys!.create("identity-a", "identity-owner-a", "Burst sender", [
      "events:send",
    ]);
    const lastUsed = async () =>
      (await auth.apiKeys!.list("identity-a")).find(({ id }) => id === created.summary.id)
        ?.lastUsedAt;
    assert.equal(await lastUsed(), null);
    assert.equal(
      (
        await auth.apiKeys!.authorize(
          bearerRequest(`${created.summary.prefix}_wrong`),
          "events:send",
        )
      ).status,
      "unauthorized",
    );
    assert.equal(
      (await auth.apiKeys!.authorize(bearerRequest(created.secret), "runs:dispatch")).status,
      "forbidden",
    );
    assert.equal(await lastUsed(), null);
    assert.equal(
      (await auth.apiKeys!.authorize(bearerRequest(created.secret), "events:send")).status,
      "authorized",
    );
    assert.ok((await lastUsed()) instanceof Date);
    await runtime.query(
      `update organization_api_keys set last_used_at = now() - interval '30 seconds'
       where id = $1`,
      [created.summary.id],
    );
    const recent = await lastUsed();
    const burst = await Promise.all(
      Array.from({ length: 20 }, () =>
        auth.apiKeys!.authorize(bearerRequest(created.secret), "events:send"),
      ),
    );
    assert.ok(burst.every(({ status }) => status === "authorized"));
    assert.deepEqual(await lastUsed(), recent);
    await runtime.query(
      `update organization_api_keys set last_used_at = now() - interval '2 minutes'
       where id = $1`,
      [created.summary.id],
    );
    const stale = await lastUsed();
    assert.ok(stale instanceof Date);
    assert.equal(
      (await auth.apiKeys!.authorize(bearerRequest(created.secret), "events:send")).status,
      "authorized",
    );
    const refreshed = await lastUsed();
    assert.ok(refreshed instanceof Date);
    assert.ok(refreshed.getTime() - stale.getTime() >= 60_000);
    await auth.apiKeys!.revoke("identity-a", created.summary.id);
    assert.equal(
      (await auth.apiKeys!.authorize(bearerRequest(created.secret), "events:send")).status,
      "unauthorized",
    );
    assert.deepEqual(await lastUsed(), refreshed);
  });

  async function browserRequest(path: string, body?: unknown): Promise<Response> {
    return auth.handle(
      new Request(`${ORIGIN}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
});

function bearerRequest(secret: string): Request {
  return new Request(`${ORIGIN}/api/v1/hooks/build-finished`, {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function verifier(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}
