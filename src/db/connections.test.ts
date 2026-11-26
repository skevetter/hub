import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ConnectionRepository } from "./connections.js";
import { ConnectionAccessDeniedError } from "./errors.js";
import { embeddedDatabaseRuntime } from "./runtime/index.js";
import type { QueryHandle } from "./runtime/index.js";
import type { StartConnectionAttemptInput } from "./types.js";

const account = { sessionId: "session", userId: "operator" };
const access = { ...account, membershipId: "member", organizationId: "org", returnRoute: "/" };

it("checks Linear activation authority and rolls back a configuration conflict", async () => {
  await withConnections(async (connections, query) => {
    const binding = {
      phase: "linear_authorization",
      access: account,
      providerApplicationId: "linear-app",
      linearOrganizationId: "workspace",
      linearOrganizationName: "Workspace",
      appUserId: "bot",
      scopes: ["read"],
    } as const;
    const complete = (stateVerifier: string, expectedVersion?: number) =>
      connections.completeLinearProviderApplication({
        ...binding,
        stateVerifier,
        accessToken: stateVerifier,
        scopes: [...binding.scopes],
        providerConfiguration: {
          configuration: {},
          identity: { id: binding.providerApplicationId },
          expectedVersion,
          updatedByUserId: account.userId,
        },
      });
    await startAttempt(connections, {
      provider: "linear",
      stateVerifier: "initial",
      configurationVersion: 1,
    });
    await query.query(
      `insert into runtime_provider_activation (provider, provider_application_id, configuration_version)
       values ('linear', 'linear-env', 0)`,
    );
    await expect(complete("initial")).rejects.toMatchObject({
      name: "ProviderApplicationChangedError",
      message: "provider application changed",
    });
    expect(await connections.findLinear("workspace")).toBeUndefined();
    await query.query(`delete from runtime_provider_activation where provider = 'linear'`);
    await complete("initial");

    await startAttempt(connections, {
      provider: "linear",
      stateVerifier: "conflict",
      configurationVersion: 1,
      expectedConfigurationVersion: 1,
    });
    await expect(complete("conflict")).rejects.toMatchObject({
      name: "ProviderConfigurationConflictError",
      message: "provider configuration changed",
    });
    expect(await connections.findLinear("workspace")).toMatchObject({ accessToken: "initial" });

    await startAttempt(connections, {
      provider: "linear",
      stateVerifier: "rotation",
      configurationVersion: 2,
      expectedConfigurationVersion: 1,
    });
    await complete("rotation", 1);
    expect(await connections.findLinear("workspace")).toMatchObject({ accessToken: "rotation" });
    expect(await query.query(`select version from runtime_provider_configuration`)).toMatchObject({
      rows: [{ version: 2 }],
    });
  });
}, 30_000);

it("rebinds Slack and disconnects it only for the owning organization", async () => {
  await withConnections(async (connections, query) => {
    await query.query(
      `insert into runtime_provider_activation (provider, provider_application_id, configuration_version)
       values ('slack', 'slack-app', 0)`,
    );
    for (const stateVerifier of ["initial", "rebound"]) {
      await startAttempt(connections, {
        provider: "slack",
        stateVerifier,
        configurationVersion: 0,
        activateConfiguration: false,
      });
      await connections.bindSlack({
        stateVerifier,
        phase: "slack_authorization",
        access: account,
        providerApplicationId: "slack-app",
        teamId: "team",
        teamName: "Team",
        botUserId: "bot",
        botAccessToken: stateVerifier,
        scopes: ["chat:write"],
      });
    }
    const connection = await connections.findSlack("team");
    expect(connection?.botAccessToken).toBe("rebound");
    if (connection === undefined) throw new Error("expected Slack connection");
    const other = { ...access, membershipId: "other-member", organizationId: "other" };
    await expect(connections.disconnect("slack", connection.id, other)).rejects.toBeInstanceOf(
      ConnectionAccessDeniedError,
    );
    expect(await connections.findSlack("team")).toEqual(connection);
    await expect(connections.disconnect("slack", connection.id, access)).resolves.toEqual({
      provider: "slack",
      teamId: "team",
      botAccessToken: "rebound",
    });
    expect(await connections.findSlack("team")).toBeUndefined();
  });
}, 30_000);

type Attempt = Pick<
  StartConnectionAttemptInput,
  "provider" | "stateVerifier" | "configurationVersion"
> &
  Partial<
    Pick<StartConnectionAttemptInput, "activateConfiguration" | "expectedConfigurationVersion">
  >;

function startAttempt(connections: ConnectionRepository, attempt: Attempt): Promise<void> {
  return connections.startAttempt({
    access,
    lifetimeMinutes: 10,
    providerApplicationId: `${attempt.provider}-app`,
    callbackOrigin: "https://hub.example.test",
    configurationSnapshot: {},
    expectedConfigurationVersion: null,
    activateConfiguration: true,
    ...attempt,
  });
}

async function withConnections(
  run: (connections: ConnectionRepository, query: QueryHandle) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hub-connections-"));
  try {
    const { runtime, locks } = await embeddedDatabaseRuntime(directory);
    try {
      await runtime.migrate();
      await seedAuthority(runtime);
      await run(new ConnectionRepository(runtime, locks), runtime);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedAuthority(query: QueryHandle): Promise<void> {
  await query.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                         must_change_password, is_instance_operator)
     values ('operator', 'Operator', 'operator@example.test', true, now(), now(), false, true)`,
  );
  await query.query(
    `insert into organization (id, name, slug) values ('org', 'Org', 'org'), ('other', 'Other', 'other')`,
  );
  await query.query(
    `insert into session (id, token, user_id, active_organization_id, expires_at)
     values ('session', 'token', 'operator', 'org', now() + interval '1 hour')`,
  );
  await query.query(
    `insert into member (id, organization_id, user_id, role)
     values ('member', 'org', 'operator', 'owner'), ('other-member', 'other', 'operator', 'owner')`,
  );
}
