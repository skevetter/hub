import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { describe, it, vi } from "vitest";
import { ProjectConfigurationStore } from "../../configuration/store.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createPostgresTestRuntime } from "../../db/test-utils/runtime.js";
import type {
  ConnectionStartAuthority,
  Database,
  DurableProviderEvent,
  LinearConnectionRecord,
  ProviderEventAcceptance,
} from "../../db/types.js";
import { LINEAR_REQUIRED_SCOPES } from "../../providers/linear/client.js";
import { acceptingAgentValidator } from "../../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../store.js";
import { createLinearTriggerProvider } from "./provider.js";
import { createLinearWebhookSource } from "./webhook.js";

const organizationId = "route-test";
const otherOrganizationId = "other-route-test";
const applicationId = "fixture-app";
const signingSecret = "fixture-signing-secret";
const now = new Date("2026-08-06T11:00:00.000Z");

interface Fixture {
  database: Database;
  close(): Promise<void>;
  connect(workspace: string, scopes?: string[]): Promise<LinearConnectionRecord>;
  disconnect(id: string): Promise<unknown>;
  assertRouteCounts?(connection: LinearConnectionRecord, count: number): Promise<void>;
}

const authority: ConnectionStartAuthority = {
  organizationId,
  userId: "fixture-user",
  sessionId: "fixture-session",
  membershipId: "fixture-member",
  returnRoute: "/",
};

describe.each([
  ["memory", memoryFixture],
  ["PostgreSQL", postgresFixture],
] as const)("Linear connection routes in %s", (_store, createFixture) => {
  it("routes signed deliveries across connect, reauthorize, and disconnect", async () => {
    const fixture = await createFixture();
    const { database } = fixture;
    try {
      await enrollTestDaemon(database, organizationId);
      const store = new OrganizationTriggerStore(
        database,
        organizationId,
        acceptingAgentValidator(),
      );
      const trigger = await store.save({ yaml: triggerYaml("late"), userId: null });
      await store.save({ yaml: triggerYaml("disabled", false), userId: null });
      const revision = await store.activeRevision(trigger);
      await database.saveOrganizationTrigger({
        organizationId: otherOrganizationId,
        name: "other-trigger",
        enabled: true,
        format: "single_run",
        yaml: revision.yaml,
        normalizedConfiguration: revision.normalizedConfiguration,
        contentHash: revision.contentHash,
        sourceKind: "manual",
        sourceEvidence: {},
        createdByUserId: null,
        routes: [],
      });

      const first = await fixture.connect("workspace-one");
      await assertRouted(database, first, [trigger.runtimeProjectId]);
      await fixture.assertRouteCounts?.(first, 1);

      const pinned = await store.save({
        yaml: triggerYaml("pinned", true, ", project: project-1"),
        userId: null,
      });
      const second = await fixture.connect("workspace-two");
      await assertRouted(database, second, [trigger.runtimeProjectId]);
      await assertRouted(database, first, [trigger.runtimeProjectId, pinned.runtimeProjectId]);
      await fixture.assertRouteCounts?.(first, 2);
      await fixture.assertRouteCounts?.(second, 1);

      const provider = createLinearTriggerProvider({
        configurationStoreForProject: (id) => new ProjectConfigurationStore(database, id),
      });
      const rejected = await deliver(database, first.linearOrganizationId, "another-sender");
      assert.equal(rejected.events.length, 2);
      for (const event of rejected.events) {
        assert.equal(await provider.match(event), "trigger_filters_rejected");
      }

      assert.equal((await fixture.connect(first.linearOrganizationId, ["read"])).id, first.id);
      const revoked = await deliver(database, first.linearOrganizationId);
      assert.equal(revoked.acceptance?.status, "dropped");
      assert.equal(revoked.acceptance.reason, "configuration_unavailable");
      assert.equal((await fixture.connect(first.linearOrganizationId)).id, first.id);
      await assertRouted(database, first, [trigger.runtimeProjectId, pinned.runtimeProjectId]);
      await fixture.assertRouteCounts?.(first, 2);

      await fixture.disconnect(first.id);
      assert.equal(await database.findLinearConnection(first.linearOrganizationId), undefined);
      await fixture.assertRouteCounts?.(first, 0);
      const disconnected = await deliver(database, first.linearOrganizationId);
      assert.equal(disconnected.acceptance?.status, "dropped");
      assert.equal(disconnected.acceptance.reason, "linear_unbound");
      assert.deepEqual(disconnected.events, []);
      await assertRouted(database, second, [trigger.runtimeProjectId]);

      const replacement = await fixture.connect(first.linearOrganizationId);
      assert.notEqual(replacement.id, first.id);
      await assertRouted(database, replacement, [trigger.runtimeProjectId]);
      await fixture.assertRouteCounts?.(replacement, 1);

      const savedAfter = await store.save({ yaml: triggerYaml("saved-after"), userId: null });
      await assertRouted(database, second, [trigger.runtimeProjectId, savedAfter.runtimeProjectId]);
      await assertRouted(database, replacement, [
        trigger.runtimeProjectId,
        savedAfter.runtimeProjectId,
      ]);
    } finally {
      await fixture.close();
    }
  }, 120_000);

  it("uses current connections when the binding commits after validation and before persistence", async () => {
    const fixture = await createFixture();
    const { database } = fixture;
    const continueSave = Promise.withResolvers<void>();
    try {
      await enrollTestDaemon(database, organizationId);
      const store = new OrganizationTriggerStore(
        database,
        organizationId,
        acceptingAgentValidator(),
      );
      const reachedWrite =
        Promise.withResolvers<Parameters<Database["saveOrganizationTrigger"]>[0]>();
      const persist = database.saveOrganizationTrigger.bind(database);
      vi.spyOn(database, "saveOrganizationTrigger").mockImplementationOnce(async (input) => {
        reachedWrite.resolve(input);
        await continueSave.promise;
        return persist(input);
      });
      const save = store.save({ yaml: triggerYaml("concurrent-save"), userId: null });
      try {
        const ready = await Promise.race([
          reachedWrite.promise,
          save.then(() => assert.fail("save did not reach the persistence boundary")),
        ]);
        assert.deepEqual(ready.routes, []);
        const connection = await fixture.connect("workspace-one");
        assert.deepEqual(await store.list(), []);
        continueSave.resolve();
        const trigger = await save;
        await assertRouted(database, connection, [trigger.runtimeProjectId]);
        await fixture.assertRouteCounts?.(connection, 1);
      } finally {
        continueSave.resolve();
        await Promise.allSettled([save]);
      }
    } finally {
      await fixture.close();
    }
  }, 120_000);
});

async function assertRouted(
  database: Database,
  connection: LinearConnectionRecord,
  projectIds: string[],
) {
  const { acceptance, events } = await deliver(database, connection.linearOrganizationId);
  assert.equal(acceptance?.status, "accepted", "Webhook acceptance: " + JSON.stringify(acceptance));
  assert.deepEqual(
    events.map((event) => event.projectId).sort((left, right) => left.localeCompare(right)),
    projectIds.sort((left, right) => left.localeCompare(right)),
  );
  for (const event of events) {
    assert.equal(event.organizationId, organizationId);
    assert.equal(event.connectionId, connection.id);
  }
}

function triggerYaml(name: string, enabled = true, scope = "") {
  return `name: ${name}
enabled: ${String(enabled)}
on:
  linear.comment_created:
    filters: { from_users: [sender]${scope} }
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle the comment
  max_runtime: 1h
  idle_timeout: 5m
`;
}

async function deliver(database: Database, workspace: string, actorId = "sender") {
  const id = randomUUID();
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    organizationId: workspace,
    webhookTimestamp: now.getTime(),
    actor: { id: actorId, name: "Sender" },
    data: { id, issueId: "issue", body: "Please investigate" },
  });
  let acceptance: ProviderEventAcceptance | undefined;
  const events: DurableProviderEvent[] = [];
  const source = createLinearWebhookSource({
    signingSecret,
    now: () => now.getTime(),
    accept: async (input) => (acceptance = await database.acceptLinearEvent(input)),
    resolveIssue: async () => ({
      id: "issue",
      identifier: "ENG-1",
      title: "Issue",
      description: null,
      projectId: "project-1",
      stateId: null,
      assigneeId: null,
      labelIds: [],
    }),
  });
  await source.start(async (event) => {
    events.push(event);
  });
  const response = await source.handle(
    new Request("http://hub.test/linear", {
      method: "POST",
      body,
      headers: {
        "linear-delivery": id,
        "linear-event": "Comment",
        "linear-signature": createHmac("sha256", signingSecret).update(body).digest("hex"),
      },
    }),
  );
  await source.stop();
  assert.equal(response.status, 200);
  return { acceptance, events };
}

async function memoryFixture(): Promise<Fixture> {
  const database = createMemoryDatabase({ organizationIds: [organizationId, otherOrganizationId] });
  return {
    database,
    close: () => database.close(),
    disconnect: (id: string) => database.removeLinearConnection(organizationId, id),
    async connect(workspace: string, scopes = [...LINEAR_REQUIRED_SCOPES]) {
      const existing = await database.findLinearConnection(workspace);
      const connection: LinearConnectionRecord = {
        id: existing?.id ?? randomUUID(),
        organizationId,
        slug: workspace,
        providerApplicationId: applicationId,
        linearOrganizationId: workspace,
        linearOrganizationName: workspace,
        appUserId: "app-user",
        accessToken: "fixture-token",
        refreshToken: null,
        accessTokenExpiresAt: null,
        scopes,
      };
      await database.setLinearConnection(connection);
      return connection;
    },
  };
}

async function postgresFixture(): Promise<Fixture> {
  const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  try {
    const { database, runtime } = await createPostgresTestRuntime(postgres.getConnectionUri());
    const close = async () => {
      await database.close();
      await postgres.stop();
    };
    try {
      await runtime.query(`
        insert into "user" (id, name, email, email_verified, created_at, updated_at)
        values ('fixture-user', 'Fixture', 'fixture@example.test', true, now(), now());
        insert into organization (id, name, slug)
        values ('route-test', 'Fixture', 'route-test'), ('other-route-test', 'Other Fixture', 'other-route-test');
        insert into session (id, token, user_id, active_organization_id, expires_at)
        values ('fixture-session', 'fixture-session-token', 'fixture-user', 'route-test', now() + interval '1 hour');
        insert into member (id, organization_id, user_id, role)
        values ('fixture-member', 'route-test', 'fixture-user', 'owner');
        insert into runtime_provider_activation (provider, provider_application_id, configuration_version)
        values ('linear', 'fixture-app', 0);
      `);
    } catch (error) {
      await database.close();
      throw error;
    }
    return {
      database,
      close,
      async assertRouteCounts(connection: LinearConnectionRecord, count: number) {
        const result = await runtime.query<{ organization_routes: number; project_routes: number }>(
          `select
             (select count(*)::int from organization_trigger_routes where connection_id = $1) as organization_routes,
             (select count(*)::int from project_trigger_routes where connection_id = $1) as project_routes`,
          [connection.id],
        );
        assert.deepEqual(result.rows, [{ organization_routes: count, project_routes: count }]);
      },
      disconnect: (id: string) => database.disconnectConnection("linear", id, authority),
      async connect(workspace: string, scopes = [...LINEAR_REQUIRED_SCOPES]) {
        const stateVerifier = randomUUID();
        await database.startConnectionAttempt({
          provider: "linear",
          stateVerifier,
          access: authority,
          lifetimeMinutes: 10,
          configurationVersion: 0,
          providerApplicationId: applicationId,
          callbackOrigin: "https://hub.test",
          configurationSnapshot: { provider: "linear" },
          expectedConfigurationVersion: null,
          activateConfiguration: false,
        });
        await database.bindLinearConnection({
          stateVerifier,
          phase: "linear_authorization",
          access: authority,
          providerApplicationId: applicationId,
          linearOrganizationId: workspace,
          linearOrganizationName: workspace,
          appUserId: "app-user",
          accessToken: "fixture-token",
          scopes,
        });
        const connection = await database.findLinearConnection(workspace);
        assert.ok(connection);
        return connection;
      },
    };
  } catch (error) {
    await postgres.stop();
    throw error;
  }
}
