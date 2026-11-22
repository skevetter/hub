import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { matchTriggers } from "../triggers/github/match.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import { HomeDashboard } from "./dashboard.js";
import { HOME_OPEN_SESSIONS_LIMIT } from "./limits.js";
import { thingsToTry } from "./things-to-try.js";

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

  it("reports a reply output only when the stored trigger event grants it", async () => {
    const database = memberDatabase();
    for (const [name, run] of [
      ["agent-reply", triggerYaml.slice(triggerYaml.indexOf("run:\n"))],
      [
        "script-no-reply",
        `run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  script: echo hello
`,
      ],
    ] as const) {
      const yaml = `name: ${name}
on:
  github.issue_comment_created:
    filters: { from_users: [octocat] }
${run}`;
      const compiled = compileTriggerDocument(yaml);
      await database.saveOrganizationTrigger({
        organizationId: "org-1",
        name,
        enabled: true,
        format: "single_run",
        yaml,
        normalizedConfiguration: {
          environments: [compiled.environment],
          triggers: compiled.events,
        },
        contentHash: compiled.authoredHash,
        sourceKind: "manual",
        sourceEvidence: {},
        createdByUserId: "user-1",
        routes: [],
      });
    }
    const snapshot = await new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");
    assert.partialDeepStrictEqual(
      snapshot.triggers.find(({ name }) => name === "agent-reply"),
      {
        event: "github.issue_comment_created",
        hasReplyOutput: true,
      },
    );
    assert.equal(
      Object.hasOwn(
        snapshot.triggers.find(({ name }) => name === "script-no-reply") ?? {},
        "hasReplyOutput",
      ),
      false,
    );
  });

  it("makes a copied comment match the real GitHub matcher and links to scoped triggers", async () => {
    const database = memberDatabase();
    const agent = triggerYaml.slice(triggerYaml.indexOf("run:\n"));
    const connections = [
      { provider: "github" as const, slug: "fixture", label: "Fixture", needsAuthorization: false },
      {
        provider: "linear" as const,
        slug: "linear",
        label: "Linear Fixture",
        needsAuthorization: false,
      },
    ];
    const dashboard = new HomeDashboard(database, accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    });
    for (const [name, event, filters] of [
      [
        "review",
        "github.pull_request_comment_created",
        'from_users: ["*"], pattern: "/paseo", contains: "@hub"',
      ],
      [
        "team-review",
        "github.pull_request_comment_created",
        'from_users: ["octocat"], labels: ["review"]',
      ],
      ["linear-comment", "linear.comment_created", 'from_users: ["operator"], pattern: "/paseo"'],
    ]) {
      const yaml = `name: ${name}
on:
  ${event}:
    filters: { ${filters} }
${agent}`;
      const compiled = compileTriggerDocument(yaml);
      const saved = await database.saveOrganizationTrigger({
        organizationId: "org-1",
        name: compiled.authored.name,
        enabled: true,
        format: "single_run",
        yaml,
        normalizedConfiguration: {
          environments: [compiled.environment],
          triggers: compiled.events,
        },
        contentHash: compiled.authoredHash,
        sourceKind: "manual",
        sourceEvidence: {},
        createdByUserId: "user-1",
        routes: [],
      });
      const snapshot = await dashboard.snapshot(request, "acme");
      const surface = thingsToTry({
        ...snapshot,
        connections,
        triggers: snapshot.triggers.filter(({ id }) => id === saved.id),
      }).find(({ key }) => key === (name === "linear-comment" ? "linear" : "github"));
      assert.ok(surface);
      if (name === "review") {
        const body = surface.examples[0]?.prompt;
        assert.ok(body);
        assert.equal(
          matchTriggers(
            { triggers: compiled.events },
            {
              id: "delivery-1",
              type: "issue_comment",
              repo: "fixture/repo",
              repositoryId: 7,
              installationId: 42,
              createdAt: NOW.toISOString(),
              payload: {
                action: "created",
                issue: {
                  number: 12,
                  title: "Fixture change",
                  user: { login: "author" },
                  pull_request: {},
                },
                comment: { id: 123, body, user: { login: "octocat" } },
                sender: { login: "octocat" },
              },
            },
          ).length,
          1,
          body,
        );
      } else {
        assert.match(surface.where, /only starts for comments that match its filters/u);
        assert.equal(surface.next?.path, `triggers/${saved.id}`);
        assert.deepEqual(surface.examples, []);
      }
    }
  });

  it("reports no session facts while interactive sessions are off", async () => {
    const snapshot = await new HomeDashboard(memberDatabase(), accountAuth(), APPS_CONFIGURED, {
      now: () => NOW,
    }).snapshot(request, "acme");

    assert.equal(snapshot.sessions, null);
  });

  it("counts the reader's open sessions and the active profiles when sessions are on", async () => {
    const database = await withSessions({
      profiles: ["active", "active", "disabled"],
      open: 2,
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
  });

  it("caps the open count and keeps the session step done with only closed sessions", async () => {
    const capped = await new HomeDashboard(
      await withSessions({ profiles: ["active"], open: HOME_OPEN_SESSIONS_LIMIT + 1 }),
      accountAuth(),
      APPS_CONFIGURED,
      { now: () => NOW, interactiveSessions: true },
    ).snapshot(request, "acme");
    assert.deepEqual(capped.sessions, {
      profiles: 1,
      open: HOME_OPEN_SESSIONS_LIMIT,
      openCapped: true,
      started: true,
    });

    const none = await new HomeDashboard(
      await withSessions({ profiles: ["active"], open: 0, closed: 1 }),
      accountAuth(),
      APPS_CONFIGURED,
      { now: () => NOW, interactiveSessions: true },
    ).snapshot(request, "acme");
    assert.deepEqual(none.sessions, { profiles: 1, open: 0, openCapped: false, started: true });
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

async function withSessions({
  profiles,
  open,
  closed = 0,
}: {
  profiles: readonly ("active" | "disabled")[];
  open: number;
  closed?: number;
}): Promise<Database> {
  const database = memberDatabase();
  const principal = { organizationId: "org-1", userId: "user-1", role: "owner" } as const;
  await enrollTestDaemon(database, principal.organizationId);
  await database.setDaemonPresence(TEST_DAEMON_ID, "connected");
  const savedProfiles = await Promise.all(
    profiles.map(async (status, index) => {
      const profile = await database.saveSessionProfile({
        principal,
        id: null,
        version: null,
        daemonId: TEST_DAEMON_ID,
        name: `Profile ${String(index + 1)}`,
        cwd: "/repo",
        worktree: null,
        provider: "codex",
        providerOptions: {},
        model: null,
        mode: null,
        thinkingOptionId: null,
        fullAccessAcknowledged: false,
        status,
        now: NOW,
      });
      if (typeof profile === "string") throw new Error(profile);
      return profile;
    }),
  );
  const profile = savedProfiles.find(({ status }) => status === "active");
  assert.ok(profile);
  for (let index = 0; index < open + closed; index += 1) {
    const started = await database.startInteractiveSession({
      principal,
      profileId: profile.id,
      profileVersion: profile.version,
      idempotencyKey: randomUUID(),
      message: "hello",
      participants: [],
      usage: { periodStart: NOW, limit: open + closed },
      maxActivePerDaemon: open + closed,
      bodyCutoff: null,
      now: NOW,
    });
    assert.equal(started.status, "created");
    if (index >= open) {
      const result = await database.acceptInteractiveSessionCommand({
        principal,
        sessionId: started.session.id,
        generation: started.session.generation,
        idempotencyKey: randomUUID(),
        kind: "close",
        bodyCutoff: null,
        now: NOW,
      });
      assert.equal(result.status, "accepted");
    }
  }
  return database;
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
