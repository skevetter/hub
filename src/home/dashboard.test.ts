import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import { buildLaunchMachineIntent } from "../dispatcher/index.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import {
  enrollTestDaemon,
  TEST_DAEMON_ID,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import { HomeDashboard } from "./dashboard.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const APPS_CONFIGURED = () => true;
const request = new Request("https://hub.test/o/acme/home");

describe("home read model", () => {
  it("describes a fresh organization as nothing connected and nothing run", async () => {
    const database = memberDatabase({ slack: false });
    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.equal(snapshot.appsConfigured, true);
    assert.deepEqual(snapshot.connections, []);
    assert.deepEqual(snapshot.daemons, []);
    assert.deepEqual(snapshot.triggers, []);
    assert.deepEqual(snapshot.runs, []);
    assert.deepEqual(snapshot.dropped, []);
    assert.equal(snapshot.windowDays, 7);
  });

  it("reads daemons with whether they can run agents, triggers with their event, and recent runs with the agent that ran", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    await enrollConnectedOnlyDaemon(database);
    await database.setDaemonPresence(TEST_DAEMON_ID, "connected");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: triggerYaml, userId: "user-1" });
    await recordRun(database, trigger.runtimeProjectId, "first", "succeeded", 120_000);
    await recordRun(database, trigger.runtimeProjectId, "second", "failed", 60_000);

    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.deepEqual(snapshot.connections, [
      { provider: "slack", slug: "acme-slack", label: "Acme Slack", needsAuthorization: true },
    ]);
    assert.deepEqual(snapshot.daemons, [
      { id: TEST_DAEMON_ID, slug: TEST_DAEMON_SLUG, presence: "connected", canExecute: true },
      { id: CONNECTED_ONLY_DAEMON_ID, slug: "laptop", presence: "offline", canExecute: false },
    ]);
    assert.deepEqual(snapshot.triggers, [
      { id: trigger.id, name: "manual-task", event: "manual.run", enabled: true },
    ]);
    assert.deepEqual(
      snapshot.runs.map(({ triggerName, provider, source, status, agent }) => ({
        triggerName,
        provider,
        source,
        status,
        agent,
      })),
      [
        {
          triggerName: "manual-task",
          provider: "manual",
          source: "manual.run",
          status: "failed",
          agent: { provider: "codex", model: "gpt-5.4" },
        },
        {
          triggerName: "manual-task",
          provider: "manual",
          source: "manual.run",
          status: "succeeded",
          agent: { provider: "codex", model: "gpt-5.4" },
        },
      ],
    );
  });

  it("names a run after its trigger, not after the event within the trigger that started it", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: scheduledTriggerYaml, userId: "user-1" });
    await recordRun(
      database,
      trigger.runtimeProjectId,
      "tick",
      "succeeded",
      60_000,
      "schedule.tick",
    );

    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.deepEqual(
      snapshot.runs.map(({ triggerName }) => triggerName),
      ["manual-task"],
    );
  });

  it("counts dropped receipts by reason group and provider inside the window", async () => {
    const database = memberDatabase();
    await dropSlackEvent(database, "recent-1", new Date("2026-09-20T12:00:00.000Z"));
    await dropSlackEvent(database, "recent-2", new Date("2026-09-21T09:00:00.000Z"));
    await dropSlackEvent(database, "stale", new Date("2026-09-01T12:00:00.000Z"));
    await dropSlackEvent(
      database,
      "filtered",
      new Date("2026-09-21T10:00:00.000Z"),
      "trigger_filters_rejected",
    );

    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.deepEqual(snapshot.dropped, [
      { provider: "slack", reason: "routing", count: 2 },
      { provider: "slack", reason: "trigger_filters_rejected", count: 1 },
    ]);
  });

  it("counts runs started in the last 24 hours and the last 30 days by outcome", async () => {
    const database = memberDatabase();
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({ yaml: triggerYaml, userId: "user-1" });
    const hour = 3_600_000;
    await recordRun(database, trigger.runtimeProjectId, "hour", "succeeded", hour);
    await recordRun(database, trigger.runtimeProjectId, "two-hours", "failed", 2 * hour);
    await recordRun(database, trigger.runtimeProjectId, "three-days", "succeeded", 72 * hour);
    await recordRun(database, trigger.runtimeProjectId, "forty-days", "succeeded", 960 * hour);

    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.deepEqual(snapshot.runCounts, {
      day: { total: 2, succeeded: 1, failed: 1 },
      month: { total: 3, succeeded: 2, failed: 1 },
    });
  });

  it("does not flag a connection whose grant covers what Hub needs", async () => {
    const database = memberDatabase({ slackScopes: [...SLACK_REQUIRED_BOT_SCOPES] });
    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.deepEqual(
      snapshot.connections.map(({ needsAuthorization }) => needsAuthorization),
      [false],
    );
  });

  it("reports no session facts while interactive sessions are off", async () => {
    const snapshot = await new HomeDashboard(memberDatabase(), accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.equal(snapshot.sessions, null);
  });

  it("counts the reader's open sessions and the active profiles when sessions are on", async () => {
    const asked: unknown[] = [];
    const database = withSessions(memberDatabase(), {
      profiles: ["active", "active", "disabled"],
      open: 2,
      asked,
    });
    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
      interactiveSessions: true,
    }).snapshot(request, "acme");

    assert.deepEqual(snapshot.sessions, {
      profiles: 2,
      open: 2,
      openCapped: false,
      started: true,
    });
    assert.deepEqual(asked[0], {
      organizationId: "org-1",
      principal: { organizationId: "org-1", userId: "user-1", role: "owner" },
      filter: "active",
    });
  });

  it("caps the open session count and asks once more only to learn whether any session exists", async () => {
    const capped = await new HomeDashboard(
      withSessions(memberDatabase(), { profiles: ["active"], open: 80, asked: [] }),
      accountAuth(),
      APPS_CONFIGURED,
      { now: () => NOW, interactiveSessions: true },
    ).snapshot(request, "acme");
    assert.deepEqual(capped.sessions, { profiles: 1, open: 50, openCapped: true, started: true });

    const asked: { filter?: string }[] = [];
    const none = await new HomeDashboard(
      withSessions(memberDatabase(), { profiles: [], open: 0, closed: 1, asked }),
      accountAuth(),
      APPS_CONFIGURED,
      { now: () => NOW, interactiveSessions: true },
    ).snapshot(request, "acme");
    assert.deepEqual(none.sessions, { profiles: 0, open: 0, openCapped: false, started: true });
    assert.deepEqual(
      asked.map(({ filter }) => filter),
      ["active", "all"],
    );
  });

  it("asks the provider registrations whether any app is configured, with the organization's bindings", async () => {
    const database = memberDatabase();
    const seen: unknown[] = [];
    const snapshot = await new HomeDashboard(
      database,
      accountAuth(),
      (bindings) => {
        seen.push(bindings.slack.map(({ slug }) => slug));
        return false;
      },
      { now: () => NOW },
    ).snapshot(request, "acme");

    assert.equal(snapshot.appsConfigured, false);
    assert.deepEqual(seen, [["acme-slack"]]);
  });
});

const CONNECTED_ONLY_DAEMON_ID = "20000000-0000-4000-8000-000000000002";

/**
 * The memory database with canned session reads. Seeding a real session needs a daemon, a
 * profile and a coordinator; the read model only asks two questions of the store.
 */
function withSessions(
  database: Database,
  canned: {
    profiles: readonly ("active" | "disabled")[];
    open: number;
    closed?: number;
    asked: unknown[];
  },
): Database {
  const sessions = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index }));
  const reads: Record<string, unknown> = {
    listSessionProfiles: () => Promise.resolve(canned.profiles.map((status) => ({ status }))),
    listInteractiveSessions: (
      organizationId: string,
      principal: unknown,
      page: { filter: "active" | "all"; limit: number },
    ) => {
      canned.asked.push({ organizationId, principal, filter: page.filter });
      const total = canned.open + (page.filter === "all" ? (canned.closed ?? 0) : 0);
      return Promise.resolve({
        sessions: sessions(Math.min(total, page.limit)),
        nextCursor: total > page.limit ? {} : null,
      });
    },
  };
  return new Proxy(database, {
    get: (target, property): unknown =>
      typeof property === "string" && property in reads
        ? reads[property]
        : Reflect.get(target, property, target),
  });
}

function memberDatabase({
  slack = true,
  slackScopes = ["app_mentions:read"],
}: { slack?: boolean; slackScopes?: string[] } = {}): Database {
  return createMemoryDatabase({
    now: () => NOW,
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role: "owner",
      },
    ],
    slackConnections: slack
      ? [
          {
            id: "slack-1",
            organizationId: "org-1",
            slug: "acme-slack",
            teamId: "T-ACME",
            teamName: "Acme Slack",
            botUserId: "UBOT",
            botAccessToken: "token",
            scopes: slackScopes,
            providerApplicationId: null,
          },
        ]
      : [],
  });
}

/** A daemon enrolled with the CLI's default answer of No to running Hub automations. */
async function enrollConnectedOnlyDaemon(database: Database): Promise<void> {
  await database.issueEnrollmentToken({
    id: "connected-only-token",
    verifier: "connected-only-verifier",
    organizationId: "org-1",
    expiresAt: new Date("2026-09-22T00:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    tokenVerifier: "connected-only-verifier",
    daemonId: CONNECTED_ONLY_DAEMON_ID,
    idempotencyKey: "connected-only",
    suggestedSlug: "laptop",
    serverId: "server-2",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    permissions: [],
    now: new Date("2026-09-21T11:00:00.000Z"),
  });
}

async function recordRun(
  database: Database,
  projectId: string,
  deliveryId: string,
  status: "succeeded" | "failed",
  ageMs: number,
  event = "manual.run",
): Promise<void> {
  const revision = await database.findActiveProjectConfiguration(projectId);
  assert.ok(revision);
  const configured = parseCompiledHubConfig(revision.normalizedConfiguration).triggers.find(
    ({ on }) => on === event,
  );
  assert.ok(configured);
  const receipt = await database.persistManualEvent({
    organizationId: "org-1",
    projectId,
    deliveryId,
    source: "manual.run",
    payload: {},
    receivedAt: new Date(NOW.getTime() - ageMs),
  });
  assert.equal(receipt.status, "accepted");
  if (receipt.status !== "accepted") return;
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: "org-1",
    projectId,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: configured.name,
    prompt: "run it",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: new Date(NOW.getTime() + 3_600_000),
    stepIds: ["run"],
    createdAt: new Date(NOW.getTime() - ageMs),
  });
  const executionId = `execution-${deliveryId}`;
  await database.createWorkflowStepExecution({
    triggerRunId: run.id,
    stepId: "run",
    ordinal: 0,
    executionId,
    execution: {
      id: executionId,
      organizationId: "org-1",
      projectId,
      machineId: null,
      daemonId: TEST_DAEMON_ID,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: revision.id,
      deadlineAt: new Date(NOW.getTime() + 3_600_000),
      idleDeadlineAt: new Date(NOW.getTime() + 600_000),
      startedAt: new Date(NOW.getTime() - 30_000),
      launchIntent: buildLaunchMachineIntent({
        organizationId: "org-1",
        projectId,
        triggerRunId: run.id,
        configurationRevisionId: revision.id,
        triggerName: "manual-task",
        environmentName: "target",
        environment: {
          kind: "daemon",
          daemonId: TEST_DAEMON_ID,
          authoredSlug: TEST_DAEMON_SLUG,
          cwd: "/workspace",
        },
        prompt: "run it",
        agent: { provider: "codex", model: "gpt-5.4", mode: "full-access" },
        allowOutputs: [],
        autoArchive: true,
        background: false,
        triggerContext: {},
        outputContext: {},
        hubConfig: {},
      }),
    },
  });
  if (status === "succeeded") await database.succeedTriggerRun(run.id);
  else await database.failWorkflowRun(run.id, "failed", "agent_interrupted", "run");
}

async function dropSlackEvent(
  database: Database,
  deliveryId: string,
  receivedAt: Date,
  reason: ProviderEventDropReasonCode = "no_project_route",
): Promise<void> {
  const accepted = await database.acceptSlackEvent({
    teamId: "T-ACME",
    deliveryId,
    source: "slack.mention",
    payload: {},
    receivedAt,
    dropReason: reason,
  });
  assert.equal(accepted.status, "dropped");
}

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, model: gpt-5.4, mode: full-access }
  prompt: Handle it
`;

/** A schedule declared before the manual event, so the schedule compiles under an internal name. */
const scheduledTriggerYaml = triggerYaml.replace(
  "on:\n",
  `on:
  schedule.tick:
    recurrence: { start: "2026-01-01T09:00:00", rule: "FREQ=DAILY", timezone: UTC }
`,
);

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
