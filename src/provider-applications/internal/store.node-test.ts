import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { embeddedDatabaseRuntime } from "../../db/runtime/index.js";
import type { ProviderApplicationStore } from "../index.js";
import { createProviderApplicationStore } from "./store.js";

async function withStore(work: (store: ProviderApplicationStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hub-provider-store-"));
  try {
    const { runtime, locks } = await embeddedDatabaseRuntime(root);
    try {
      await runtime.migrate();
      await runtime.query(
        `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                             must_change_password, is_instance_operator)
         values ('operator', 'Operator', 'operator@example.test', true, now(), now(), false, true)`,
      );
      await runtime.query(
        `insert into organization (id, name, slug)
         values ('org', 'Org', 'org'), ('other', 'Other', 'other')`,
      );
      await work(createProviderApplicationStore(runtime, locks));
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true });
  }
}

void test("orders application persistence by provider and enforces configuration versions", () =>
  withStore(async (store) => {
    const github = {
      provider: "github" as const,
      configuration: {
        provider: "github" as const,
        appId: "42",
        appSlug: "paseo",
        clientId: "client",
        clientSecret: "secret",
        privateKey: "key",
      },
      identity: { provider: "github" as const, id: "42", name: "App", ownerLogin: "acme" },
      updatedByUserId: "operator",
    };
    assert.equal(await store.read("github"), undefined);
    assert.deepEqual(await store.readAll(), []);
    assert.equal((await store.save({ ...github, expectedVersion: undefined })).version, 1);
    await assert.rejects(store.save({ ...github, expectedVersion: undefined }), {
      name: "ProviderConfigurationConflictError",
      message: "provider configuration changed",
    });
    assert.equal((await store.save({ ...github, expectedVersion: 1 })).version, 2);
    assert.equal((await store.read("github"))?.version, 2);
    await store.activate({
      provider: "github",
      identity: github.identity,
      configurationVersion: 2,
    });
    assert.deepEqual(
      (await store.readAll()).map(({ provider, version }) => [provider, version]),
      [["github", 2]],
    );
  }));

void test("Slack Socket Mode refuses stale writes and workspaces owned by a different organization", () =>
  withStore(async (store) => {
    const input = {
      configuration: {
        provider: "slack" as const,
        transport: "socket" as const,
        appId: "A1",
        appToken: "xapp-test",
      },
      identity: { provider: "slack" as const, id: "A1", name: "App" },
      updatedByUserId: "operator",
      organizationId: "org",
      installation: {
        appId: "A1",
        teamId: "T1",
        teamName: "Team",
        botUserId: "B1",
        botAccessToken: "xoxb-test",
        scopes: ["chat:write"],
      },
    };
    assert.equal(
      (await store.completeSlackSocketApplication({ ...input, expectedVersion: undefined }))
        .version,
      1,
    );
    await assert.rejects(store.completeSlackSocketApplication({ ...input, expectedVersion: 0 }), {
      name: "ProviderConfigurationConflictError",
      message: "provider configuration changed",
    });
    await assert.rejects(
      store.completeSlackSocketApplication({
        ...input,
        organizationId: "other",
        expectedVersion: 1,
      }),
      {
        name: "ProviderApplicationIdentityConflictError",
        message: "Slack workspace belongs to another organization",
      },
    );
    assert.equal(
      (await store.completeSlackSocketApplication({ ...input, expectedVersion: 1 })).version,
      2,
    );
    await assert.rejects(
      store.activate({
        provider: "slack",
        identity: { ...input.identity, id: "other" },
        configurationVersion: 3,
      }),
      {
        name: "ProviderApplicationIdentityConflictError",
        message: "provider application identity conflicts with active connections",
      },
    );
    assert.equal((await store.read("slack"))?.version, 2);
  }));
