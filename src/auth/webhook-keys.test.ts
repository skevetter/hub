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
  apiKeyCreateResultSchema,
  defaultApiKeyActor,
  type ApiKeyIdentityOptions,
  webhookSigningSummarySchema,
} from "./api-key-contract.js";
import { createDatabase } from "../db/pg.js";
import type { Locks } from "../db/runtime/locks/index.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { readWebhookSigningSettings, type WebhookSigningSettings } from "./webhook-signatures.js";
import { createAuthServer, type AuthServer } from "./server.js";

const ORIGIN = "http://localhost:3000";
const signingSettings = readWebhookSigningSettings({
  PASEO_HUB_WEBHOOK_HMAC_ENABLED: "true",
  PASEO_HUB_WEBHOOK_GITHUB_SIGNATURES_ENABLED: "true",
  PASEO_HUB_WEBHOOK_HMAC_ORGANIZATION_IDS: '["identity-a"]',
  PASEO_HUB_WEBHOOK_HMAC_KEYRING: JSON.stringify({
    "test-key": Buffer.alloc(32, 0x14).toString("base64"),
  }),
  PASEO_HUB_WEBHOOK_HMAC_ACTIVE_KEY_ID: "test-key",
});
const keySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  actor: apiKeyActorSchema.nullable(),
  allowedTriggers: apiKeyAllowedTriggersSchema.nullable(),
  scopes: z.array(z.string()),
});
const keyResponseSchema = z.object({ key: keySummarySchema, secret: z.string() });

const signedKeyResponseSchema = z
  .object({
    key: keySummarySchema.extend({ authentication: webhookSigningSummarySchema }),
    signingSecret: z.string(),
  })
  .strict();

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
  let locks: Locks;
  let auth: AuthServer;
  let cookie: string;
  let targetTriggerId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hub-webhook-keys-"));
    const bundle = await embeddedDatabaseRuntime(join(directory, "database"));
    runtime = bundle.runtime;
    locks = bundle.locks;
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
    const database = createDatabase(runtime, locks);
    await enrollTestDaemon(database, "identity-a");
    const target = await new OrganizationTriggerStore(
      database,
      "identity-a",
      acceptingAgentValidator(),
    ).save({
      userId: "identity-owner-a",
      yaml: `name: signed-trigger
on:
  manual.run:
    filters:
      from_users: [ci-partner]
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  script: printf ok
`,
    });
    targetTriggerId = target.id;
    auth = createTestAuth(signingSettings);
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

  it.each([false, true])(
    "parses the ordinary browser account reply when signing enabled is %s",
    async (enabled) => {
      const server = createTestAuth(enabled ? signingSettings : readWebhookSigningSettings({}));
      try {
        const name = "Browser Bearer";
        const response = await server.browserAccount!(
          new Request(ORIGIN + "/api/auth/paseo/api-keys", {
            method: "POST",
            headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
            body: JSON.stringify({ name, scopes: ["events:send"] }),
          }),
        );
        assert.equal(response.status, 201);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("pragma"), "no-cache");
        const created = apiKeyCreateResultSchema.parse(await response.json());
        assert.ok("secret" in created);
        assert.equal(created.key.name, name);
        assert.equal(created.key.authentication, undefined);
        assert.equal(
          (await server.apiKeys!.authorize(bearerRequest(created.secret), "events:send")).status,
          "authorized",
        );
      } finally {
        await server.close();
      }
    },
  );

  it("accepts a 72-hour signing overlap and rejects one second beyond it", async () => {
    const issued = await browserRequest("/api/auth/paseo/api-keys", signedKeyInput("Overlap cap"));
    assert.equal(issued.status, 201);
    const { key } = signedKeyResponseSchema.parse(await issued.json());
    const input = { id: key.id, expectedCurrentVersionId: key.authentication.currentVersionId };
    const route = "/api/auth/paseo/rotate-api-key-signing-secret";
    const limit = 72 * 3600;
    const rejected = await browserRequest(route, { ...input, overlapSeconds: limit + 1 });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: "invalid_request" });
    const accepted = await browserRequest(route, { ...input, overlapSeconds: limit });
    assert.equal(accepted.status, 200);
    const rotated = z
      .object({ authentication: webhookSigningSummarySchema })
      .parse(await accepted.json());
    assert.equal(rotated.authentication.previousVersionId, input.expectedCurrentVersionId);
    assert.notEqual(rotated.authentication.currentVersionId, input.expectedCurrentVersionId);
  });

  it("denies signing key creation, rotation and retirement in an excluded organization", async () => {
    const created = await browserRequest(
      "/api/auth/paseo/api-keys",
      signedKeyInput("Excluded signer"),
    );
    assert.equal(created.status, 201);
    const { key } = signedKeyResponseSchema.parse(await created.json());
    const id = key.id;
    const rotated = await browserRequest("/api/auth/paseo/rotate-api-key-signing-secret", {
      id,
      expectedCurrentVersionId: key.authentication.currentVersionId,
    });
    assert.equal(rotated.status, 200);
    const { authentication } = z
      .object({ authentication: webhookSigningSummarySchema })
      .parse(await rotated.json());
    const excluded = createTestAuth({
      ...signingSettings,
      organizationIds: new Set(["identity-b"]),
    });
    try {
      const before = await excluded.apiKeys!.list("identity-a");
      for (const [path, input] of [
        ["/api/auth/paseo/api-keys", signedKeyInput("Denied signer")],
        [
          "/api/auth/paseo/rotate-api-key-signing-secret",
          { id, expectedCurrentVersionId: authentication.currentVersionId },
        ],
        [
          "/api/auth/paseo/retire-api-key-signing-secret",
          { id, expectedPreviousVersionId: authentication.previousVersionId },
        ],
      ] as const) {
        const response = await browserRequest(path, input, excluded);
        assert.equal(response.status, 403, path);
        assert.deepEqual(await response.json(), { error: "signature_authentication_disabled" });
      }
      assert.deepEqual(await excluded.apiKeys!.list("identity-a"), before);
    } finally {
      await excluded.close();
    }
  });

  it("reveals a signed key only on same-origin creation and rotation, and retires by version", async () => {
    const createPath = "/api/auth/paseo/api-keys";
    const rotatePath = "/api/auth/paseo/rotate-api-key-signing-secret";
    const retirePath = "/api/auth/paseo/retire-api-key-signing-secret";
    const input = signedKeyInput("GitHub signer");
    const forbiddenRequest = (path: string, data: unknown) =>
      new Request(ORIGIN + path, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://cross-origin.test",
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      });
    assert.equal((await auth.handle(forbiddenRequest(createPath, input))).status, 403);
    assert.equal((await auth.browserAccount!(forbiddenRequest(createPath, input))).status, 403);
    const invalid = await browserRequest(createPath, {
      ...input,
      scopes: ["events:send", "runs:read"],
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (
        await browserRequest(createPath, {
          ...input,
          authentication: { ...input.authentication, targetTriggerId: randomUUID() },
        })
      ).status,
      404,
    );
    const issued = await browserRequest(createPath, input);
    assert.equal(issued.status, 201, await issued.clone().text());
    assert.equal(issued.headers.get("cache-control"), "no-store");
    assert.equal(issued.headers.get("pragma"), "no-cache");
    const created = signedKeyResponseSchema.parse(await issued.json());
    assert.deepEqual(created.key.allowedTriggers, ["signed-trigger"]);
    assert.equal(created.key.authentication.targetTriggerId, targetTriggerId);
    const id = created.key.id;
    const previous = created.key.authentication.currentVersionId;
    const listingBefore = await browserRequest(createPath);
    assert.equal(listingBefore.status, 200);
    assert.ok(!(await listingBefore.text()).includes(created.signingSecret));
    const rotationInput = { id, expectedCurrentVersionId: previous };
    assert.equal((await auth.handle(forbiddenRequest(rotatePath, rotationInput))).status, 403);
    const rotated = await browserRequest(rotatePath, rotationInput);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers.get("cache-control"), "no-store");
    assert.equal(rotated.headers.get("pragma"), "no-cache");
    const next = z
      .object({ authentication: webhookSigningSummarySchema, signingSecret: z.string() })
      .parse(await rotated.json());
    assert.notEqual(next.signingSecret, created.signingSecret);
    assert.equal(next.authentication.previousVersionId, previous);
    const stale = await browserRequest(rotatePath, rotationInput);
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "signing_version_changed" });
    const retireInput = { id, expectedPreviousVersionId: previous };
    assert.equal((await auth.handle(forbiddenRequest(retirePath, retireInput))).status, 403);
    assert.equal(
      (await browserRequest(retirePath, { id, expectedPreviousVersionId: randomUUID() })).status,
      409,
    );
    assert.equal((await browserRequest(retirePath, retireInput)).status, 200);
    const listingAfter = await browserRequest(createPath);
    const listed = await listingAfter.text();
    for (const secret of [
      created.signingSecret,
      next.signingSecret,
      "master_key_id",
      "verifier",
      "salt",
    ]) {
      assert.ok(!listed.includes(secret));
    }
    assert.equal((await browserRequest("/api/auth/paseo/revoke-api-key", { id })).status, 200);
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

  function signedKeyInput(name: string) {
    return {
      name,
      actor: "ci-partner",
      scopes: ["events:send"],
      authentication: { mode: "hmac", profile: "github_sha256", targetTriggerId },
    };
  }

  function createTestAuth(webhookSigning: WebhookSigningSettings): AuthServer {
    return createAuthServer({
      database: runtime,
      locks,
      entitlements: createUnlimitedEntitlementsService(),
      secret: "webhook-key-test-auth-secret-at-least-32-characters",
      baseURL: ORIGIN,
      webhookSigning,
      policy: { registrationMode: "open", organizationCreation: "disabled", bootstrap: undefined },
    });
  }

  async function browserRequest(path: string, body?: unknown, server = auth): Promise<Response> {
    return server.handle(
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
