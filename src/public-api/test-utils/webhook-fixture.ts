import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubApplication } from "../../app.js";
import { OrganizationApiKeys } from "../../auth/api-keys.js";
import type { ApiKeyScope, ApiKeyIdentityOptions } from "../../auth/api-key-contract.js";
import { OrganizationCliCredentials } from "../../auth/cli-credentials.js";
import { PublicCredentialAuthenticator } from "../../auth/public-credentials.js";
import { createDatabase } from "../../db/pg.js";
import { embeddedDatabaseRuntime } from "../../db/runtime/index.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";
import { createFetchServer } from "../../http/node-server.js";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../../triggers/store.js";
import { DEFAULT_WEBHOOK_OPTIONS, type WebhookOptions } from "../../webhook-config.js";

export async function webhookFixture(overrides: Partial<WebhookOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hub-webhook-api-"));
  const bundle = await embeddedDatabaseRuntime(join(directory, "database"));
  const runtime = bundle.runtime;
  await runtime.migrate();
  await runtime.query(
    "insert into organization (id,name,slug) values ('webhook-a','Webhook A','webhook-a'),('webhook-b','Webhook B','webhook-b')",
  );
  await runtime.query(
    "insert into \"user\" (id,name,email,email_verified) values ('webhook-owner','Owner','webhook@example.test',true)",
  );
  await runtime.query(
    "insert into member (id,organization_id,user_id,role) values ('webhook-member','webhook-a','webhook-owner','owner')",
  );
  const database = createDatabase(runtime, bundle.locks);
  await enrollTestDaemon(database, "webhook-a");
  const keys = new OrganizationApiKeys(runtime, bundle.locks);
  const authenticator = new PublicCredentialAuthenticator(
    keys,
    new OrganizationCliCredentials(runtime),
  );
  const settings = { ...DEFAULT_WEBHOOK_OPTIONS, burst: 1000, ...overrides };
  const application = createHubApplication({
    database,
    entitlements: createUnlimitedEntitlementsService(),
    publicApi: { status: "enabled", authenticator },
    webhookOptions: settings,
  });
  const store = new OrganizationTriggerStore(database, "webhook-a", acceptingAgentValidator());
  async function createKey(
    scopes: readonly ApiKeyScope[] = ["events:send"],
    identity: ApiKeyIdentityOptions = { actor: "sender" },
    organizationId = "webhook-a",
  ) {
    return keys.create(
      organizationId,
      "webhook-owner",
      `Sender ${randomUUID()}`,
      scopes,
      undefined,
      identity,
    );
  }
  const key = await createKey();
  await application.hub.start();
  const servers: Server[] = [];
  return {
    directory,
    runtime,
    database,
    application,
    keys,
    key,
    createKey,
    async save(
      name = "build-finished",
      options: {
        enabled?: boolean;
        actor?: string;
        filtered?: boolean;
        script?: boolean;
        event?: "manual.run" | "schedule.tick";
      } = {},
    ) {
      const eventYaml =
        options.event === "schedule.tick"
          ? "  schedule.tick:\n    recurrence:\n      start: '2099-01-01T00:00:00'\n      rule: FREQ=DAILY\n      timezone: UTC\n"
          : `  manual.run:\n    filters:\n      from_users: [${options.actor ?? "sender"}]\n${options.filtered ? "      inputs: { status: failed }\n" : ""}`;
      const runYaml = options.script
        ? "  script: printf ok\n"
        : "  agent: { provider: codex, mode: full-access }\n  prompt: '${{ paseo.prompt }} ${{ paseo.context }}'\n";
      const yaml = `name: ${name}\nenabled: ${String(options.enabled ?? true)}\non:\n${eventYaml}inputs:\n  status: { type: string, choices: [passed, failed], default: failed }\n  count: { type: number }\nrun:\n  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }\n${runYaml}`;
      return store.save({ yaml, userId: "webhook-owner" });
    },
    async send(
      name: string,
      body: unknown = { message: "build finished", status: "failed", count: 2 },
      options: { secret?: string | null; deliveryKey?: string; headers?: HeadersInit } = {},
    ) {
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
    },
    async cliCredential() {
      const id = randomUUID();
      const prefix = `paseo_cli_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const secret = `${prefix}_fake-test-secret`;
      await runtime.query(
        "insert into organization_cli_credentials (id,organization_id,prefix,verifier,created_by_user_id) values ($1,'webhook-a',$2,$3,'webhook-owner')",
        [id, prefix, createHash("sha256").update(secret).digest("base64url")],
      );
      return secret;
    },
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
      await application.hub.stop();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
