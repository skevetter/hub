import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { FAILED_RUNS_SQL, MARK_FAILED_RUNS_SEEN_SQL, WAITING_SESSIONS_SQL } from "./queries.js";

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

interface SeededRun {
  name: string;
  status: string;
  /** Seconds after `since` that the event arrived. */
  received: number;
  /** Seconds after `since` that the run ended; a running run has none. */
  ended?: number;
}

const SEEDED_DELIVERY = "seed:";

async function seedRun({ name, status, received, ended = received }: SeededRun) {
  const at = (seconds: number) => new Date(since.getTime() + seconds * 1000);
  await pg.runtime.query(
    `with receipt as (
      insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload, received_at)
      values ($1, 'manual', $2, 'manual.run', '{}', $3)
      returning id
    )
    insert into trigger_runs (organization_id, project_id, configuration_revision_id,
      provider_event_receipt_id, configured_trigger_name, status, prompt, outcome, rejection,
      created_at, completed_at, deadline_at)
    select $1, $4, $5, id, $9, $6, '', case when $6 = 'rejected' then 'rejected' else 'accepted' end,
      case when $6 = 'rejected' then '{}'::jsonb else null end, $3,
      case when $6 = 'running' then null else $7::timestamptz end,
      case when $6 = 'rejected' then null else $8::timestamptz end from receipt`,
    [
      org,
      `${SEEDED_DELIVERY}${name}`,
      at(received),
      template.projectId,
      template.configurationRevisionId,
      status,
      at(ended),
      new Date("2030-01-01T00:00:00Z"),
      name,
    ],
  );
}

async function clearSeededRuns() {
  await pg.runtime.query(
    `delete from trigger_runs where provider_event_receipt_id in (
       select id from provider_event_receipts where delivery_id like $1)`,
    [`${SEEDED_DELIVERY}%`],
  );
  await pg.runtime.query("delete from provider_event_receipts where delivery_id like $1", [
    `${SEEDED_DELIVERY}%`,
  ]);
  await pg.runtime.query("delete from account_attention_state");
}

const iso = (seconds: number) => new Date(since.getTime() + seconds * 1000).toISOString();

describe("failed runs by the time they ended", () => {
  beforeEach(clearSeededRuns);

  it("counts failure statuses by end time after the exact marker and within the window", async () => {
    await seedRun({ name: "Too old", status: "failed", received: -1 });
    await seedRun({ name: "At cutoff", status: "failed", received: 0 });
    await seedRun({ name: "Timed out", status: "timed_out", received: 1 });
    await seedRun({ name: "Newest", status: "rejected", received: 2 });
    await seedRun({ name: "Succeeded", status: "succeeded", received: 3 });
    const { database } = pg;
    expect(await database.countFailedRunsSince(org, since, null)).toEqual({
      count: 3,
      newest: { triggerName: "Newest", failedAt: new Date(iso(2)) },
    });
    expect((await database.countFailedRunsSince(org, since, iso(1))).count).toBe(1);
    expect(await database.countFailedRunsSince(org, since, iso(2))).toEqual({
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
    await pg.runtime.query("delete from organization_triggers where name in ('One', 'Two')");
  });

  it("counts a run whose event arrived before the marker and which failed or timed out after it", async () => {
    const { database } = pg;
    await seedRun({ name: "Failed later", status: "failed", received: 5, ended: 20 });
    await seedRun({ name: "Timed out later", status: "timed_out", received: 2, ended: 30 });
    await seedRun({ name: "Failed before", status: "failed", received: 5, ended: 8 });
    await seedRun({ name: "Rejected before", status: "rejected", received: 9 });
    await seedRun({ name: "Still running", status: "running", received: 4, ended: 40 });
    expect(await database.countFailedRunsSince(org, since, iso(10))).toEqual({
      count: 2,
      newest: { triggerName: "Timed out later", failedAt: new Date(iso(30)) },
    });
    expect((await database.countFailedRunsSince(org, since, iso(25))).count).toBe(1);
    expect((await database.countFailedRunsSince(org, since, iso(30))).count).toBe(0);
    expect((await database.countFailedRunsSince(otherOrg, since, iso(10))).count).toBe(0);
  });

  it("falls back to the creation time for a run that never recorded when it ended", async () => {
    await seedRun({ name: "Legacy", status: "failed", received: 5, ended: 5 });
    await pg.runtime.query(
      "update trigger_runs set completed_at = null, created_at = $1 where configured_trigger_name = 'Legacy'",
      [iso(12)],
    );
    expect(await pg.database.countFailedRunsSince(org, since, iso(10))).toMatchObject({
      count: 1,
      newest: { failedAt: new Date(iso(12)) },
    });
  });

  it("moves the marker to the newest end time in the window, never past it", async () => {
    const { database, runtime } = pg;
    expect(await database.readFailedRunsSeenThrough("reader", org)).toBeNull();
    await database.markFailedRunsSeen("reader", org, since);
    expect(await database.readFailedRunsSeenThrough("reader", org)).toBeNull();
    expect((await runtime.query("select * from account_attention_state")).rowCount).toBe(0);

    await seedRun({ name: "Old failure", status: "failed", received: -5, ended: 50 });
    await seedRun({ name: "First", status: "failed", received: 5, ended: 10 });
    await seedRun({ name: "Second", status: "timed_out", received: 6, ended: 20 });
    await seedRun({ name: "Still running", status: "running", received: 7, ended: 90 });
    await Promise.all([
      database.markFailedRunsSeen("reader", org, since),
      database.markFailedRunsSeen("reader", org, since),
    ]);
    const mark = await database.readFailedRunsSeenThrough("reader", org);
    assert.ok(mark !== null);
    expect(Date.parse(mark)).toBe(since.getTime() + 20_000);
    expect((await runtime.query("select * from account_attention_state")).rowCount).toBe(1);
    expect((await database.countFailedRunsSince(org, since, mark)).count).toBe(0);

    await seedRun({ name: "Fails after the click", status: "failed", received: 6, ended: 21 });
    expect(await database.countFailedRunsSince(org, since, mark)).toMatchObject({
      count: 1,
      newest: { triggerName: "Fails after the click" },
    });
    await database.markFailedRunsSeen("reader", org, since);
    const advanced = await database.readFailedRunsSeenThrough("reader", org);
    assert.ok(advanced !== null);
    expect(Date.parse(advanced)).toBe(since.getTime() + 21_000);
    await database.markFailedRunsSeen("reader", org, new Date(since.getTime() + 60_000));
    expect(await database.readFailedRunsSeenThrough("reader", org)).toBe(advanced);
  });

  it("keeps the marker scoped to one account and one organization", async () => {
    const { database } = pg;
    await seedRun({ name: "Scoped", status: "failed", received: 5, ended: 10 });
    await database.markFailedRunsSeen("reader", org, since);
    await database.markFailedRunsSeen("reader", otherOrg, since);
    expect(await database.readFailedRunsSeenThrough("reader", otherOrg)).toBeNull();
    expect(await database.readFailedRunsSeenThrough("owner", org)).toBeNull();
    const mark = await database.readFailedRunsSeenThrough("reader", org);
    assert.ok(mark !== null);
    expect((await database.countFailedRunsSince(org, since, null)).count).toBe(1);
    expect((await database.countFailedRunsSince(org, since, mark)).count).toBe(0);
  });
});

describe("the in-memory marker", () => {
  async function acceptedRun(database: Database, name: string) {
    const project = await database.createProject({
      organizationId: org,
      name,
      slug: name,
      createdByUserId: null,
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: name,
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id, []);
    const receipt = await database.persistManualEvent({
      organizationId: org,
      projectId: project.id,
      deliveryId: randomUUID(),
      source: "manual.run",
      payload: {},
      receivedAt: new Date(since.getTime() + 5000),
    });
    assert.equal(receipt.status, "accepted");
    const { run } = await database.createAcceptedTriggerRun({
      organizationId: org,
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: name,
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date(since.getTime() + 3_600_000),
      stepIds: ["work"],
    });
    return run;
  }

  it("is scoped, monotonic and follows when runs end", async () => {
    let now = new Date(since.getTime() + 10_000);
    const database = createMemoryDatabase({ now: () => now });
    const early = await acceptedRun(database, "early");
    const late = await acceptedRun(database, "late");
    await database.markFailedRunsSeen("reader", org, since);
    expect(await database.readFailedRunsSeenThrough("reader", org)).toBeNull();

    await database.failWorkflowRun(early.id, "failed", "Fixture", "work");
    now = new Date(since.getTime() + 20_000);
    await database.markFailedRunsSeen("reader", org, since);
    const mark = await database.readFailedRunsSeenThrough("reader", org);
    expect(mark).toBe(iso(10));
    expect((await database.countFailedRunsSince(org, since, mark)).count).toBe(0);
    expect(await database.readFailedRunsSeenThrough("reader", otherOrg)).toBeNull();
    expect(await database.readFailedRunsSeenThrough("owner", org)).toBeNull();

    now = new Date(since.getTime() + 30_000);
    await database.failWorkflowRun(late.id, "timed_out", "Fixture", "work");
    expect(await database.countFailedRunsSince(org, since, mark)).toMatchObject({
      count: 1,
      newest: { triggerName: "late", failedAt: new Date(iso(30)) },
    });
    await database.markFailedRunsSeen("reader", org, since);
    expect(await database.readFailedRunsSeenThrough("reader", org)).toBe(iso(30));
    await database.markFailedRunsSeen("reader", org, new Date(since.getTime() + 60_000));
    expect(await database.readFailedRunsSeenThrough("reader", org)).toBe(iso(30));
  });
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
  const markPlan = await runtime.query(`explain ${MARK_FAILED_RUNS_SEEN_SQL}`, [
    "reader",
    org,
    since,
    [...FAILED_RUN_STATUSES],
  ]);
  const markOutput = markPlan.rows.map((row) => row["QUERY PLAN"]).join("\n");
  expect(markOutput).toContain("provider_event_receipts_organization_received_idx");
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

async function seedStopRulePlan(window: typeof matchWindow) {
  const { database, runtime } = pg;
  const { trigger } = await matchTrigger(database, {
    name: "plan",
    events: ["github.notification"],
  });
  const { runtimeProjectId: projectId } = trigger;
  const project = await database.findProjectById(projectId);
  assert.ok(project?.activeConfigurationRevisionId);
  await runtime.query(
    `with receipts as (
       insert into provider_event_receipts
         (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
       select $1, 'github_notification', gen_random_uuid()::text, 'github.notification', '{}',
         case when n <= 5000 then $2::timestamptz - interval '40 days'
              when n <= 5032 then $2::timestamptz + interval '1 day'
              else $3::timestamptz + interval '1 day' end,
         case when n > 5032 then 'trigger_filters_rejected' end
       from generate_series(1, 5064) n returning id, received_at, dropped_reason
     )
     insert into trigger_runs
       (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
        configured_trigger_name, status, prompt, deadline_at, created_at)
     select $1, $4, $5, id, 'plan', 'succeeded', '', received_at + interval '1 hour', received_at
     from receipts where dropped_reason is null`,
    [
      org,
      window.previousStart,
      window.recentStart,
      projectId,
      project.activeConfigurationRevisionId,
    ],
  );
  await runtime.query("analyze provider_event_receipts, trigger_runs");
}

it("uses indexed receipt and run lookups for the stop rule", async () => {
  const { database, runtime } = pg;
  const window = {
    previousStart: new Date("2026-07-01T00:00:00Z"),
    recentStart: new Date("2026-07-08T00:00:00Z"),
    now: new Date("2026-07-15T00:00:00Z"),
  };
  await seedStopRulePlan(window);
  const activity = (await database.listTriggerMatchActivity(org, window)).find(
    ({ name }) => name === "plan",
  );
  expect(activity).toMatchObject({
    previousMatches: 32,
    recentMatches: 0,
    providers: [{ provider: "github_notification", recentEvents: 32 }],
  });
  const { previousStart, recentStart, now } = window;
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
