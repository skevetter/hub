import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as org,
  type TimelinePostgresHarness,
} from "../db/test-utils/run-timeline-postgres.js";
import type {
  AcceptedTriggerRunRecord,
  Database,
  DurableProviderEvent,
  OrganizationTriggerRoute,
} from "../db/types.js";
import { enrollTestDaemon } from "../test-utils/project-configuration.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { PROVIDERS, RECENT_PROVIDER_EVENTS_SQL, TRIGGER_MATCHES_SQL } from "./trigger-matches.js";
import { FAILED_RUN_STATUSES } from "../triggers/run-status.js";
import { FAILED_RUNS_SQL, WAITING_SESSIONS_SQL } from "./queries.js";

let pg: TimelinePostgresHarness;
let template: AcceptedTriggerRunRecord;
const since = new Date("2026-01-01T00:00:00Z");
const otherOrg = "other";

beforeAll(async () => {
  pg = await createTimelinePostgresHarness();
  template = await pg.createRun();
  await pg.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    otherOrg,
  ]);
  for (const [userId, role] of [
    ["reader", "member"],
    ["owner", "owner"],
    ["admin", "admin"],
  ]) {
    await pg.runtime.query('insert into "user" (id, name, email) values ($1, $1, $1)', [userId]);
    await pg.runtime.query(
      "insert into member (id, organization_id, user_id, role) values ($1, $2, $1, $3)",
      [userId, org, role],
    );
  }
}, 60_000);

afterAll(async () => pg?.close());

async function seedRun(name: string, status: string, seconds: number) {
  await pg.runtime.query(
    `with receipt as (
      insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload, received_at)
      values ($1, 'manual', $2, 'manual.run', '{}', $3)
      returning id
    )
    insert into trigger_runs (organization_id, project_id, configuration_revision_id,
      provider_event_receipt_id, configured_trigger_name, status, prompt, outcome, rejection, created_at, deadline_at)
    select $1, $4, $5, id, $2, $6, '', case when $6 = 'rejected' then 'rejected' else 'accepted' end,
      case when $6 = 'rejected' then '{}'::jsonb else null end, $7,
      case when $6 = 'rejected' then null else $7::timestamptz end from receipt`,
    [
      org,
      name,
      new Date(since.getTime() + seconds * 1000),
      template.projectId,
      template.configurationRevisionId,
      status,
      new Date("2030-01-01T00:00:00Z"),
    ],
  );
}

it("counts failure statuses by receipt time after the exact marker and within the window", async () => {
  await seedRun("Too old", "failed", -1);
  await seedRun("At cutoff", "failed", 0);
  await seedRun("Timed out", "timed_out", 1);
  await seedRun("Newest", "rejected", 2);
  await seedRun("Succeeded", "succeeded", 3);
  const { database } = pg;
  expect(await database.countFailedRunsSince(org, since, null)).toEqual({
    count: 3,
    newest: { triggerName: "Newest", receivedAt: new Date(since.getTime() + 2000) },
  });
  expect((await database.countFailedRunsSince(org, since, "2026-01-01T00:00:01Z")).count).toBe(1);
  expect(await database.countFailedRunsSince(org, since, "2026-01-01T00:00:02Z")).toEqual({
    count: 0,
    newest: null,
  });
  expect(await database.countFailedRunsSince(otherOrg, since, null)).toEqual({
    count: 0,
    newest: null,
  });
  await pg.runtime.query(
    `insert into organization_triggers (organization_id, name, format, runtime_project_id)
     values ($1, 'One', 'single_run', $2), ($1, 'Two', 'single_run', $2)`,
    [org, template.projectId],
  );
  expect(await database.countFailedRunsSince(org, since, null)).toMatchObject({
    count: 3,
    newest: { triggerName: "Newest" },
  });
});

it("stores one marker for each account and organization using database time", async () => {
  const { database, runtime } = pg;
  const before = await runtime.query<{ now: Date }>("select clock_timestamp() as now");
  expect(await database.readFailedRunsSeenThrough("reader", org)).toBeNull();
  await Promise.all([
    database.markFailedRunsSeen("reader", org),
    database.markFailedRunsSeen("reader", org),
  ]);
  const after = await runtime.query<{ now: Date }>("select clock_timestamp() as now");
  const mark = await database.readFailedRunsSeenThrough("reader", org);
  assert.ok(mark !== null && before.rows[0] && after.rows[0]);
  expect(Date.parse(mark)).toBeGreaterThanOrEqual(before.rows[0].now.getTime());
  expect(Date.parse(mark)).toBeLessThanOrEqual(after.rows[0].now.getTime());
  expect((await runtime.query("select * from account_attention_state")).rowCount).toBe(1);
  expect(await database.readFailedRunsSeenThrough("reader", otherOrg)).toBeNull();
  expect(await database.readFailedRunsSeenThrough("owner", org)).toBeNull();
  expect((await database.countFailedRunsSince(org, since, mark)).count).toBe(0);
});

it("models a monotonic scoped marker in memory", async () => {
  let now = since;
  const database = createMemoryDatabase({ now: () => now });
  await database.markFailedRunsSeen("reader", org);
  now = new Date(since.getTime() - 1000);
  await database.markFailedRunsSeen("reader", org);
  expect(await database.readFailedRunsSeenThrough("reader", org)).toBe(since.toISOString());
  expect(await database.readFailedRunsSeenThrough("reader", otherOrg)).toBeNull();
  expect(await database.readFailedRunsSeenThrough("owner", org)).toBeNull();
});

async function seedSessions() {
  const { database, runtime } = pg;
  await enrollTestDaemon(database, org);
  const [daemon] = await database.listDaemonsForOrganization(org);
  assert.ok(daemon);
  await database.setDaemonPresence(daemon.id, "connected");
  const now = new Date();
  const owner = { organizationId: org, userId: "owner", role: "owner" } as const;
  const profile = await database.saveSessionProfile({
    principal: owner,
    id: null,
    version: null,
    daemonId: daemon.id,
    name: "Attention profile",
    cwd: "/repo",
    worktree: null,
    provider: "codex",
    providerOptions: {},
    model: null,
    mode: null,
    thinkingOptionId: null,
    fullAccessAcknowledged: false,
    status: "active",
    now,
  });
  assert.notEqual(typeof profile, "string");
  if (typeof profile === "string") throw new Error(profile);
  for (const [name, userId, origin, state, order] of [
    ["Mine", "reader", "web", "waiting_permission", 1],
    ["Owner's Web", "owner", "web", "waiting_permission", 2],
    ["Owner's Linear", "owner", "linear", "waiting_permission", 3],
    ["Idle", "reader", "web", "idle", 4],
  ] as const) {
    const result = await database.startInteractiveSession({
      principal: { ...owner, userId, role: userId === "reader" ? "member" : "owner" },
      profileId: profile.id,
      profileVersion: profile.version,
      idempotencyKey: randomUUID(),
      message: "hello",
      participants: [],
      usage: { periodStart: now, limit: 10 },
      maxActivePerDaemon: 4,
      bodyCutoff: null,
      now,
    });
    assert.equal(result.status, "created", JSON.stringify(result));
    await runtime.query(
      `update interactive_sessions set title = $2, origin = $3, state = $4,
        requester_identity_id = $5, last_activity_at = $6 where id = $1`,
      [
        result.session.id,
        name,
        origin,
        state,
        origin === "linear" ? randomUUID() : null,
        new Date(now.getTime() + order),
      ],
    );
  }
}

it("orders and counts only waiting sessions the current membership may view", async () => {
  await seedSessions();
  expect(await pg.database.hasActiveSessionProfile(org)).toBe(true);
  expect(await pg.database.hasActiveSessionProfile(otherOrg)).toBe(false);
  const read = (userId: string, limit = 3, organizationId = org) =>
    pg.database.listSessionsWaitingForPermission(
      org,
      { organizationId, userId, role: "owner" },
      limit,
    );
  expect(await read("reader")).toEqual({ count: 1, sessions: [{ name: "Mine" }] });
  expect(await read("admin")).toEqual({
    count: 2,
    sessions: [{ name: "Owner's Web" }, { name: "Mine" }],
  });
  expect(await read("owner", 1)).toEqual({ count: 3, sessions: [{ name: "Owner's Linear" }] });
  expect(await read("outsider")).toEqual({ count: 0, sessions: [] });
  expect(await read("owner", 3, otherOrg)).toEqual({ count: 0, sessions: [] });
});

it("uses indexed receipt and run lookups for a selective attention window", async () => {
  const { runtime } = pg;
  await runtime.query(
    `insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload, received_at)
     select $1, 'manual', n::text, 'manual.run', '{}', '2025-01-01' from generate_series(1, 15000) n`,
    [org],
  );
  await runtime.query(
    `insert into trigger_runs (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
        configured_trigger_name, status, prompt, deadline_at)
     select $1, $2, $3, id, 'old', 'succeeded', '', now() from provider_event_receipts where received_at = '2025-01-01'`,
    [org, template.projectId, template.configurationRevisionId],
  );
  await runtime.query("analyze provider_event_receipts, trigger_runs, interactive_sessions");
  const plan = await runtime.query(`explain (analyze, buffers) ${FAILED_RUNS_SQL}`, [
    org,
    since,
    null,
    [...FAILED_RUN_STATUSES],
  ]);
  const output = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
  expect(output).toContain("provider_event_receipts_organization_received_idx");
  expect(output).toContain("trigger_runs_receipt_project_configured_unique");
  const sessionsPlan = await runtime.query(`explain (analyze, buffers) ${WAITING_SESSIONS_SQL}`, [
    org,
    "reader",
    1,
  ]);
  const sessionsOutput = sessionsPlan.rows.map((row) => row["QUERY PLAN"]).join("\n");
  expect(sessionsOutput).toContain("interactive_sessions");
  process.stdout.write(`${output}\n${sessionsOutput}\n`);
});

const matchWindow = {
  previousStart: new Date("2026-02-01T00:00:00Z"),
  recentStart: new Date("2026-02-08T00:00:00Z"),
  now: new Date("2026-02-15T00:00:00Z"),
};

function slackConnection(organizationId: string) {
  return {
    id: randomUUID(),
    organizationId,
    teamId: organizationId,
    slug: organizationId,
    teamName: organizationId,
    botUserId: "bot",
    botAccessToken: "fixture",
    scopes: [],
    providerApplicationId: null,
  };
}

const matchConnections = [slackConnection(org), slackConnection(otherOrg)];
const matchGitHub = {
  id: randomUUID(),
  organizationId: org,
  slug: "github",
  installationId: 12,
  accountId: "fixture",
  accountLogin: "fixture",
  accountType: "Organization",
  status: "active" as const,
  providerApplicationId: null,
};

async function matchDatabase(engine: "postgres" | "memory") {
  if (engine === "memory")
    return createMemoryDatabase({
      organizationIds: [org, otherOrg],
      slackConnections: matchConnections,
      githubConnections: [matchGitHub],
    });
  for (const connection of matchConnections) {
    await pg.runtime.query(
      `insert into slack_connections
        (id, organization_id, team_id, slug, team_name, bot_user_id, bot_access_token)
       values ($1, $2, $2, $2, $2, 'bot', 'fixture')`,
      [connection.id, connection.organizationId],
    );
  }
  await pg.runtime.query(
    `insert into github_connections
       (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
     values ($1, $2, $3, 'github', 'fixture', 'fixture', 'Organization', 'active')`,
    [matchGitHub.id, org, matchGitHub.installationId],
  );
  return pg.database;
}

type MatchEvent = "slack.mention" | "github.issue_comment" | "github.notification" | "manual.run";
const MATCH_EVENT_FILTERS: Record<MatchEvent, string> = {
  "slack.mention": '{ from_users: ["fixture"] }',
  "github.issue_comment": '{ from_users: ["fixture"] }',
  "github.notification": "{ repo: fixture/repo, reason: author }",
  "manual.run": "{}",
};

interface MatchFixture {
  id?: string;
  name: string;
  events: readonly MatchEvent[];
  enabled?: boolean;
  organizationId?: string;
}

function matchRoutes(events: readonly MatchEvent[], organizationId: string) {
  const slack = matchConnections.find((connection) => connection.organizationId === organizationId);
  assert.ok(slack);
  return events.flatMap<OrganizationTriggerRoute>((configuredEventName) => {
    if (configuredEventName === "slack.mention")
      return [
        {
          configuredEventName,
          provider: "slack" as const,
          connectionId: slack.id,
          resourceId: null,
        },
      ];
    if (configuredEventName === "github.issue_comment")
      return [
        {
          configuredEventName,
          provider: "github" as const,
          connectionId: matchGitHub.id,
          resourceId: null,
        },
      ];
    return [];
  });
}

async function matchTrigger(database: Database, fixture: MatchFixture) {
  const { name, enabled = true, organizationId = org } = fixture;
  const eventYaml = fixture.events
    .map((event) => `  ${event}: { filters: ${MATCH_EVENT_FILTERS[event]} }`)
    .join("\n");
  const yaml = `name: ${name}
enabled: ${String(enabled)}
on:
${eventYaml}
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Run task
`;
  const compiled = compileTriggerDocument(yaml);
  const trigger = await database.saveOrganizationTrigger({
    ...(fixture.id === undefined ? {} : { triggerId: fixture.id }),
    organizationId,
    name,
    enabled,
    format: "single_run",
    yaml,
    normalizedConfiguration: { environments: [compiled.environment], triggers: compiled.events },
    contentHash: compiled.authoredHash,
    sourceKind: "manual",
    sourceEvidence: {},
    createdByUserId: null,
    routes: matchRoutes(fixture.events, organizationId),
  });
  return { trigger, events: compiled.events };
}

type MatchTrigger = Awaited<ReturnType<typeof matchTrigger>>;

async function matchedReceipt(
  database: Database,
  { organizationId, runtimeProjectId: projectId }: MatchTrigger["trigger"],
  on: MatchEvent,
  receivedAt: Date,
): Promise<DurableProviderEvent> {
  const input = { deliveryId: randomUUID(), source: on, payload: {}, receivedAt };
  if (on === "manual.run") {
    const result = await database.persistManualEvent({ ...input, organizationId, projectId });
    assert.equal(result.status, "accepted");
    return result.event;
  }
  const result =
    on === "slack.mention"
      ? await database.acceptSlackEvent({ ...input, teamId: organizationId })
      : await database.acceptGitHubEvent({ ...input, installationId: matchGitHub.installationId });
  assert.equal(result.status, "accepted");
  const event = result.events.find((route) => route.projectId === projectId);
  assert.ok(event);
  return event;
}

async function matchRun(
  database: Database,
  fixture: MatchTrigger,
  input: { receivedAt: Date; on: MatchEvent; rejected?: boolean },
) {
  const { on, receivedAt, rejected } = input;
  const configured = fixture.events.find((event) => event.on === on);
  assert.ok(configured);
  const { organizationId, projectId, providerEventReceiptId, configurationRevisionId } =
    await matchedReceipt(database, fixture.trigger, on, receivedAt);
  const run = {
    organizationId,
    projectId,
    providerEventReceiptId,
    configurationRevisionId,
    configuredTriggerName: configured.name,
    prompt: "",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    createdAt: matchWindow.now,
  };
  if (rejected === true) {
    await database.createRejectedTriggerRun({
      ...run,
      rejection: { code: "missing_required", inputName: "fixture" },
    });
    return;
  }
  await database.createAcceptedTriggerRun({ ...run, deadlineAt: matchWindow.now, stepIds: [] });
}

async function deliverMatchEvent(database: Database, teamId: string, receivedAt: Date) {
  const event = await database.acceptSlackEvent({
    teamId,
    receivedAt,
    deliveryId: randomUUID(),
    source: "slack.mention",
    payload: {},
    dropReason: "no_project_route",
  });
  expect(event.status).toBe("dropped");
}

async function seedStoppedMatches(database: Database) {
  const { previousStart, recentStart, now } = matchWindow;
  const stopped = await matchTrigger(database, {
    name: "stopped",
    events: ["manual.run", "github.issue_comment", "slack.mention"],
  });
  await matchRun(database, stopped, {
    receivedAt: previousStart,
    on: "github.issue_comment",
    rejected: true,
  });
  await matchRun(database, stopped, {
    receivedAt: new Date(recentStart.getTime() - 1),
    on: "slack.mention",
  });
  await matchRun(database, stopped, {
    receivedAt: new Date(previousStart.getTime() - 1),
    on: "slack.mention",
  });
  await matchRun(database, stopped, { receivedAt: recentStart, on: "manual.run" });
  await matchRun(database, stopped, {
    receivedAt: new Date(now.getTime() + 1),
    on: "slack.mention",
  });

  const renamed = await matchTrigger(database, {
    id: stopped.trigger.id,
    name: "renamed",
    events: ["manual.run", "github.issue_comment", "slack.mention"],
  });
  expect(renamed.trigger.runtimeProjectId).toBe(stopped.trigger.runtimeProjectId);
}

async function seedMatchRuns(database: Database) {
  const { previousStart, recentStart, now } = matchWindow;
  await seedStoppedMatches(database);
  const still = await matchTrigger(database, {
    name: "deploy",
    events: ["github.issue_comment", "slack.mention"],
  });
  expect(still.events[1]?.name).toBe("deploy-event-2");
  await matchRun(database, still, { receivedAt: previousStart, on: "github.issue_comment" });
  await matchRun(database, still, { receivedAt: recentStart, on: "slack.mention" });
  const disabledFixture = { name: "disabled", events: ["slack.mention"] } as const;
  const disabled = await matchTrigger(database, disabledFixture);
  await matchRun(database, disabled, { receivedAt: previousStart, on: "slack.mention" });
  await matchTrigger(database, { ...disabledFixture, id: disabled.trigger.id, enabled: false });
  const unserved = await matchTrigger(database, {
    name: "unserved",
    events: ["github.issue_comment"],
  });
  await matchRun(database, unserved, { receivedAt: previousStart, on: "github.issue_comment" });
  await matchTrigger(database, {
    id: unserved.trigger.id,
    name: "unserved",
    events: ["github.notification"],
  });
  await matchTrigger(database, { name: "never", events: ["slack.mention"] });
  await matchTrigger(database, { name: "manual", events: ["manual.run"] });
  const foreign = await matchTrigger(database, {
    name: "foreign",
    events: ["slack.mention"],
    organizationId: otherOrg,
  });
  await matchRun(database, foreign, { receivedAt: previousStart, on: "slack.mention" });
  await deliverMatchEvent(database, org, new Date(recentStart.getTime() - 1));
  await deliverMatchEvent(database, org, now);
  await deliverMatchEvent(database, org, new Date(now.getTime() + 1));
  await deliverMatchEvent(database, otherOrg, recentStart);
}

it.each(["postgres", "memory"] as const)(
  "reads stop-rule window evidence on %s",
  async (engine) => {
    const database = await matchDatabase(engine);
    await seedMatchRuns(database);
    const counts = await database.listTriggerMatchActivity(org, matchWindow);
    expect(
      counts
        .map(({ id, ...evidence }) => {
          expect(id).toBeTruthy();
          return evidence;
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      {
        name: "deploy",
        previousMatches: 1,
        recentMatches: 1,
        providers: [
          { provider: "github", recentEvents: 0 },
          { provider: "slack", recentEvents: 2 },
        ],
      },
      {
        name: "never",
        previousMatches: 0,
        recentMatches: 0,
        providers: [{ provider: "slack", recentEvents: 2 }],
      },
      {
        name: "renamed",
        previousMatches: 2,
        recentMatches: 0,
        providers: [
          { provider: "github", recentEvents: 0 },
          { provider: "slack", recentEvents: 2 },
        ],
      },
      {
        name: "unserved",
        previousMatches: 1,
        recentMatches: 0,
        providers: [{ provider: "github_notification", recentEvents: 0 }],
      },
    ]);
  },
);

it("uses indexed receipt and run lookups for the stop rule", async () => {
  const { runtime } = pg;
  const { previousStart, recentStart, now } = matchWindow;
  const plans = await Promise.all([
    runtime.query(`explain (analyze, buffers) ${TRIGGER_MATCHES_SQL}`, [
      org,
      previousStart,
      recentStart,
      now,
      PROVIDERS,
    ]),
    runtime.query(`explain (analyze, buffers) ${RECENT_PROVIDER_EVENTS_SQL}`, [
      org,
      recentStart,
      now,
      PROVIDERS,
    ]),
  ]);
  const matchPlans = plans.map(({ rows }) => rows.map((row) => row["QUERY PLAN"]).join("\n"));
  expect(matchPlans[0]).toContain("trigger_runs_receipt_project_configured_unique");
  for (const plan of matchPlans) {
    expect(plan).toContain("provider_event_receipts_organization_received_idx");
  }
  process.stdout.write(`${matchPlans.join("\n")}\n`);
});
