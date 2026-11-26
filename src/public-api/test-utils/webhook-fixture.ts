import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubApplication } from "../../app.js";
import { OrganizationApiKeys, type CreatedApiKey } from "../../auth/api-keys.js";
import {
  apiKeyCreateSchema,
  type ApiKeyScope,
  type ApiKeyIdentityOptions,
} from "../../auth/api-key-contract.js";
import { OrganizationCliCredentials } from "../../auth/cli-credentials.js";
import { PublicCredentialAuthenticator } from "../../auth/public-credentials.js";
import {
  readWebhookSigningSettings,
  type WebhookSigningSettings,
} from "../../auth/webhook-signatures.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "../../db/runtime/index.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";
import { createFetchServer } from "../../http/node-server.js";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import { DEFAULT_WEBHOOK_OPTIONS, type WebhookOptions } from "../../webhook-config.js";

export function testSigningSettings(overrides: Partial<WebhookSigningSettings> = {}) {
  return {
    ...readWebhookSigningSettings({
      PASEO_HUB_WEBHOOK_HMAC_ENABLED: "true",
      PASEO_HUB_WEBHOOK_GITHUB_SIGNATURES_ENABLED: "true",
      PASEO_HUB_WEBHOOK_HMAC_ORGANIZATION_IDS: '["webhook-a"]',
      PASEO_HUB_WEBHOOK_HMAC_KEYRING: JSON.stringify({
        "test-master": Buffer.alloc(32, 0x77).toString("base64"),
      }),
      PASEO_HUB_WEBHOOK_HMAC_ACTIVE_KEY_ID: "test-master",
    }),
    ...overrides,
  };
}

interface FixtureOptions {
  signing?: WebhookSigningSettings;
  memory?: boolean;
  bundle?: DatabaseRuntimeBundle;
}

interface SaveOptions {
  enabled?: boolean;
  actor?: string;
  filtered?: boolean;
  script?: boolean;
  triggerId?: string;
  event?: "manual.run" | "schedule.tick";
}

type FixtureRuntime = DatabaseRuntimeBundle["runtime"];
type FixtureApplication = ReturnType<typeof createHubApplication>;

async function seedWebhookRows(runtime: FixtureRuntime) {
  await runtime.query(
    "insert into organization (id,name,slug) values ('webhook-a','Webhook A','webhook-a'),('webhook-b','Webhook B','webhook-b')",
  );
  await runtime.query(
    "insert into \"user\" (id,name,email,email_verified) values ('webhook-owner','Owner','webhook@example.test',true)",
  );
  await runtime.query(
    "insert into member (id,organization_id,user_id,role) values ('webhook-member','webhook-a','webhook-owner','owner')",
  );
}

function keyFactory(keys: OrganizationApiKeys) {
  return (
    scopes: readonly ApiKeyScope[] = ["events:send"],
    identity: ApiKeyIdentityOptions = { actor: "sender" },
    organizationId = "webhook-a",
  ) =>
    keys.create({
      organizationId,
      createdByUserId: "webhook-owner",
      name: `Sender ${randomUUID()}`,
      scopes,
      identity,
    });
}

function triggerYaml(name: string, options: SaveOptions): string {
  const eventYaml =
    options.event === "schedule.tick"
      ? "  schedule.tick:\n    recurrence:\n      start: '2099-01-01T00:00:00'\n      rule: FREQ=DAILY\n      timezone: UTC\n"
      : `  manual.run:\n    filters:\n      from_users: [${options.actor ?? "sender"}]\n${options.filtered ? "      inputs: { status: failed }\n" : ""}`;
  const runYaml = options.script
    ? "  script: printf ok\n"
    : "  agent: { provider: codex, mode: full-access }\n  prompt: '${{ paseo.prompt }} ${{ paseo.context }}'\n";
  return `name: ${name}\nenabled: ${String(options.enabled ?? true)}\non:\n${eventYaml}inputs:\n  status: { type: string, choices: [passed, failed], default: failed }\n  count: { type: number }\nrun:\n  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }\n${runYaml}`;
}

function saveTriggerWith(context: {
  store: OrganizationTriggerStore;
  postgres: ReturnType<typeof createDatabase>;
  memory: boolean;
  mirroredTargets: Map<string, string>;
}) {
  return async (name = "build-finished", options: SaveOptions = {}) => {
    const yaml = triggerYaml(name, options);
    const trigger = await context.store.save({
      yaml,
      userId: "webhook-owner",
      ...(options.triggerId === undefined ? {} : { triggerId: options.triggerId }),
    });
    if (context.memory) {
      const mirroredId =
        options.triggerId === undefined
          ? undefined
          : context.mirroredTargets.get(options.triggerId);
      const mirrored = await new OrganizationTriggerStore(
        context.postgres,
        "webhook-a",
        acceptingAgentValidator(),
      ).save({
        yaml,
        userId: "webhook-owner",
        ...(mirroredId === undefined ? {} : { triggerId: mirroredId }),
      });
      context.mirroredTargets.set(trigger.id, mirrored.id);
    }
    return trigger;
  };
}

function createSignerWith(context: {
  runtime: FixtureRuntime;
  keys: OrganizationApiKeys;
  memory: boolean;
  mirroredTargets: Map<string, string>;
}) {
  return async (targetTriggerId: string, actor = "sender") => {
    const authentication = {
      mode: "hmac",
      profile: "github_sha256",
      targetTriggerId: context.mirroredTargets.get(targetTriggerId) ?? targetTriggerId,
    } as const;
    const input = apiKeyCreateSchema.parse({
      name: "Test signer",
      actor,
      scopes: ["events:send"],
      authentication,
    });
    return context.runtime.transaction(async (client) => {
      const issued = await context.keys.createSigned({
        client,
        organizationId: "webhook-a",
        createdByUserId: "webhook-owner",
        input,
        authentication,
      });
      if (context.memory) {
        // Memory dispatch has its own identifiers; credential persistence stays in SQL.
        await client.query(
          "update organization_api_keys set webhook_target_trigger_id = $1 where id = $2",
          [targetTriggerId, issued.summary.id],
        );
        issued.summary.authentication.targetTriggerId = targetTriggerId;
      }
      return issued;
    });
  };
}

function sendWith(application: FixtureApplication, key: CreatedApiKey) {
  return async (
    name: string,
    body: unknown = { message: "build finished", status: "failed", count: 2 },
    options: { secret?: string | null; deliveryKey?: string; headers?: HeadersInit } = {},
  ) => {
    const headers = new Headers(options.headers);
    if (options.secret !== null)
      headers.set("authorization", `Bearer ${options.secret ?? key.secret}`);
    if (!headers.has("content-type"))
      headers.set("content-type", typeof body === "string" ? "text/plain" : "application/json");
    if (options.deliveryKey !== undefined) headers.set("idempotency-key", options.deliveryKey);
    return application.publicApi.handle(
      new Request(`http://hub.test/api/v1/hooks/${name}`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  };
}

async function insertCliCredential(runtime: FixtureRuntime) {
  const id = randomUUID();
  const prefix = `paseo_cli_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const secret = `${prefix}_fake-test-secret`;
  await runtime.query(
    "insert into organization_cli_credentials (id,organization_id,prefix,verifier,created_by_user_id) values ($1,'webhook-a',$2,$3,'webhook-owner')",
    [id, prefix, createHash("sha256").update(secret).digest("base64url")],
  );
  return secret;
}

function testServers(application: FixtureApplication) {
  const servers: Server[] = [];
  return {
    async listen() {
      const server = createFetchServer((request) => application.publicApi.handle(request));
      servers.push(server);
      const listening = Promise.withResolvers<void>();
      server.once("error", listening.reject);
      server.listen(0, "127.0.0.1", listening.resolve);
      await listening.promise;
      server.off("error", listening.reject);
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("test server has no port");
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      for (const server of servers) {
        server.closeAllConnections();
        const closing = Promise.withResolvers<void>();
        server.close((error) => (error === undefined ? closing.resolve() : closing.reject(error)));
        await closing.promise;
      }
    },
  };
}

export async function webhookFixture(
  overrides: Partial<WebhookOptions> = {},
  fixtureOptions: FixtureOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "hub-webhook-api-"));
  const bundle =
    fixtureOptions.bundle ?? (await embeddedDatabaseRuntime(join(directory, "database")));
  const { runtime, locks } = bundle;
  await runtime.migrate();
  await seedWebhookRows(runtime);
  const memory = fixtureOptions.memory === true;
  const postgres = createDatabase(runtime, locks);
  const database = memory ? createMemoryDatabase() : postgres;
  await enrollTestDaemon(database, "webhook-a");
  if (memory) await enrollTestDaemon(postgres, "webhook-a");
  const keys = new OrganizationApiKeys(runtime, locks, fixtureOptions.signing);
  const authenticator = new PublicCredentialAuthenticator(
    keys,
    new OrganizationCliCredentials(runtime),
  );
  const application = createHubApplication({
    database,
    entitlements: createUnlimitedEntitlementsService(),
    publicApi: { status: "enabled", authenticator, webhookKeys: keys },
    webhookOptions: { ...DEFAULT_WEBHOOK_OPTIONS, burst: 1000, ...overrides },
  });
  const store = new OrganizationTriggerStore(database, "webhook-a", acceptingAgentValidator());
  const createKey = keyFactory(keys);
  const key = await createKey();
  await application.hub.start();
  const mirroredTargets = new Map<string, string>();
  const servers = testServers(application);
  return {
    directory,
    runtime,
    locks,
    database,
    application,
    keys,
    key,
    createKey,
    createSigner: createSignerWith({ runtime, keys, memory, mirroredTargets }),
    save: saveTriggerWith({ store, postgres, memory, mirroredTargets }),
    send: sendWith(application, key),
    cliCredential: () => insertCliCredential(runtime),
    listen: () => servers.listen(),
    async close() {
      await servers.close();
      await application.hub.stop();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
