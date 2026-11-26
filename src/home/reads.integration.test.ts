import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  createTimelinePostgresHarness,
  type TimelinePostgresHarness,
} from "../db/test-utils/run-timeline-postgres.js";
import type { Database, DurableProviderEvent, OrganizationTriggerRoute } from "../db/types.js";
import type { ProviderEventDropReasonCode } from "../triggers/drop-reason.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { RUNS_PER_DAY_SQL } from "./runs-per-day.js";
import { PROVIDERS, stoppedTriggers, TRIGGER_MATCHES_SQL } from "./trigger-matches.js";

let pg: TimelinePostgresHarness;
const window = {
  previousStart: new Date("2026-02-01T00:00:00Z"),
  recentStart: new Date("2026-02-08T00:00:00Z"),
  now: new Date("2026-02-15T00:00:00Z"),
};
const ms = (at: Date, offset: number) => new Date(at.getTime() + offset);
const hours = (at: Date, count: number) => ms(at, count * 3_600_000);

beforeAll(async () => {
  pg = await createTimelinePostgresHarness();
  await pg.createRun();
}, 60_000);

afterAll(async () => pg?.close());

interface World {
  database: Database;
  org: string;
  other: string;
  slackIds: Record<string, string>;
  githubId: string;
  installationId: number;
}

type Engine = "postgres" | "memory";

/** Each test owns a pair of organizations, so no test reads another's rows. */
async function createWorld(engine: Engine): Promise<World> {
  const suffix = randomUUID().slice(0, 8);
  const [org, other] = [`home-${suffix}`, `home-other-${suffix}`];
  const slack = [org, other].map((organizationId) => ({
    id: randomUUID(),
    organizationId,
    teamId: organizationId,
    slug: organizationId,
    teamName: organizationId,
    botUserId: "bot",
    botAccessToken: "fixture",
    scopes: [],
    providerApplicationId: null,
  }));
  const installationId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const github = {
    id: randomUUID(),
    organizationId: org,
    slug: "github",
    installationId,
    accountId: "fixture",
    accountLogin: "fixture",
    accountType: "Organization",
    status: "active" as const,
    providerApplicationId: null,
  };
  const ids = {
    slackIds: Object.fromEntries(slack.map(({ organizationId, id }) => [organizationId, id])),
    githubId: github.id,
    installationId,
  };
  if (engine === "memory") {
    const database = createMemoryDatabase({
      organizationIds: [org, other],
      slackConnections: slack,
      githubConnections: [github],
    });
    return { database, org, other, ...ids };
  }
  for (const organizationId of [org, other])
    await pg.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
      organizationId,
    ]);
  for (const connection of slack)
    await pg.runtime.query(
      `insert into slack_connections
        (id, organization_id, team_id, slug, team_name, bot_user_id, bot_access_token)
       values ($1, $2, $2, $2, $2, 'bot', 'fixture')`,
      [connection.id, connection.organizationId],
    );
  await pg.runtime.query(
    `insert into github_connections
       (id, organization_id, installation_id, slug, account_id, account_login, account_type, status)
     values ($1, $2, $3, 'github', 'fixture', 'fixture', 'Organization', 'active')`,
    [github.id, org, installationId],
  );
  return { database: pg.database, org, other, ...ids };
}

type EventName = "slack.mention" | "github.issue_comment" | "manual.run";
const FILTERS: Record<EventName, string> = {
  "slack.mention": '{ from_users: ["fixture"] }',
  "github.issue_comment": '{ from_users: ["fixture"] }',
  "manual.run": "{}",
};

interface TriggerFixture {
  name: string;
  on: EventName;
  enabled?: boolean;
  organization?: "org" | "other";
}

function routesFor(world: World, on: EventName, organizationId: string) {
  const slackId = world.slackIds[organizationId];
  if (on === "github.issue_comment")
    return [
      {
        configuredEventName: on,
        provider: "github" as const,
        connectionId: world.githubId,
        resourceId: null,
      },
    ];
  if (on === "slack.mention" && slackId !== undefined)
    return [
      {
        configuredEventName: on,
        provider: "slack" as const,
        connectionId: slackId,
        resourceId: null,
      },
    ];
  return [];
}

async function createTrigger(world: World, fixture: TriggerFixture) {
  const { name, on, enabled = true, organization = "org" } = fixture;
  const organizationId = organization === "org" ? world.org : world.other;
  const yaml = `name: ${name}
enabled: ${String(enabled)}
on:
  ${on}: { filters: ${FILTERS[on]} }
run:
  target: { daemon: devbox, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Run task
`;
  const compiled = compileTriggerDocument(yaml);
  const routes: OrganizationTriggerRoute[] = routesFor(world, on, organizationId);
  const trigger = await world.database.saveOrganizationTrigger({
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
    routes,
  });
  return { trigger, on, configuredName: compiled.events[0]?.name ?? name };
}

type Trigger = Awaited<ReturnType<typeof createTrigger>>;

/** Delivers one event that routes to the trigger's project, as the ingest path does. */
async function deliver(
  world: World,
  fixture: Trigger,
  receivedAt: Date,
): Promise<DurableProviderEvent> {
  const { organizationId, runtimeProjectId: projectId } = fixture.trigger;
  const input = { deliveryId: randomUUID(), source: fixture.on, payload: {}, receivedAt };
  if (fixture.on === "manual.run") {
    const result = await world.database.persistManualEvent({ ...input, organizationId, projectId });
    assert.equal(result.status, "accepted");
    return result.event;
  }
  const result =
    fixture.on === "slack.mention"
      ? await world.database.acceptSlackEvent({ ...input, teamId: organizationId })
      : await world.database.acceptGitHubEvent({ ...input, installationId: world.installationId });
  assert.equal(result.status, "accepted");
  const event = result.events.find((route) => route.projectId === projectId);
  assert.ok(event);
  return event;
}

type RunOutcome = "succeeded" | "failed" | "timed_out" | "rejected" | "running";

async function startRun(
  world: World,
  fixture: Trigger,
  at: Date,
  outcome: RunOutcome = "succeeded",
) {
  const event = await deliver(world, fixture, at);
  const run = {
    organizationId: event.organizationId,
    projectId: event.projectId,
    providerEventReceiptId: event.providerEventReceiptId,
    configurationRevisionId: event.configurationRevisionId,
    configuredTriggerName: fixture.configuredName,
    prompt: "",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    createdAt: at,
  };
  if (outcome === "rejected") {
    await world.database.createRejectedTriggerRun({
      ...run,
      rejection: { code: "missing_required", inputName: "fixture" },
    });
    return;
  }
  const { run: created } = await world.database.createAcceptedTriggerRun({
    ...run,
    deadlineAt: ms(window.now, 86_400_000),
    stepIds: ["only"],
  });
  if (outcome === "succeeded") await world.database.succeedTriggerRun(created.id);
  if (outcome === "failed" || outcome === "timed_out")
    await world.database.failWorkflowRun(created.id, outcome, "fixture");
}

/** A receipt the filters turned away after it was routed to the trigger: no run exists. */
async function filterDrop(
  world: World,
  fixture: Trigger,
  at: Date,
  reason: ProviderEventDropReasonCode = "trigger_filters_rejected",
) {
  const event = await deliver(world, fixture, at);
  await world.database.markProviderEventDropped(event.providerEventReceiptId, reason);
}

async function deliverSlackNoise(world: World, organizationId: string, receivedAt: Date) {
  const result = await world.database.acceptSlackEvent({
    teamId: organizationId,
    receivedAt,
    deliveryId: randomUUID(),
    source: "slack.mention",
    payload: {},
    dropReason: "no_project_route",
  });
  expect(result.status).toBe("dropped");
}

const slackActivity = (
  name: string,
  previousMatches: number,
  recentMatches: number,
  recentEvents: number,
) => ({
  name,
  previousMatches,
  recentMatches,
  providers: [{ provider: "slack", recentEvents }],
});

async function activityOf(world: World, organizationId = world.org) {
  const activity = await world.database.listTriggerMatchActivity(organizationId, window);
  return activity.map(({ id, ...rest }) => {
    expect(id).toBeTruthy();
    return rest;
  });
}

describe.each(["postgres", "memory"] as const)("trigger match activity on %s", (engine) => {
  it("counts a run and a filter drop as matches and skips other drop reasons", async () => {
    const world = await createWorld(engine);
    const subject = await createTrigger(world, { name: "subject", on: "slack.mention" });
    await startRun(world, subject, window.previousStart);
    await filterDrop(world, subject, hours(window.previousStart, 1));
    await filterDrop(world, subject, hours(window.previousStart, 2), "unsupported_event");
    await deliverSlackNoise(world, world.org, hours(window.recentStart, 1));
    expect(await activityOf(world)).toEqual([slackActivity("subject", 2, 0, 1)]);
  });

  it("counts a trigger whose only matches were dropped by its filters", async () => {
    const world = await createWorld(engine);
    const dropped = await createTrigger(world, { name: "dropped-only", on: "slack.mention" });
    await filterDrop(world, dropped, hours(window.previousStart, 30));
    await deliverSlackNoise(world, world.org, hours(window.recentStart, 1));
    const activity = await world.database.listTriggerMatchActivity(world.org, window);
    expect(
      stoppedTriggers(activity).map(({ name, previousMatches }) => [name, previousMatches]),
    ).toEqual([["dropped-only", 1]]);
  });

  it("puts a receipt on the window edges in the week it belongs to", async () => {
    const world = await createWorld(engine);
    const edges = await createTrigger(world, { name: "edges", on: "slack.mention" });
    const { previousStart, recentStart, now } = window;
    for (const at of [ms(previousStart, -1), previousStart, ms(recentStart, -1)])
      await filterDrop(world, edges, at);
    for (const at of [recentStart, now, ms(now, 1)]) await filterDrop(world, edges, at);
    expect(await activityOf(world)).toEqual([slackActivity("edges", 2, 2, 2)]);
  });

  it("does not flag a trigger whose app sent nothing, or one that still matches", async () => {
    const world = await createWorld(engine);
    const quiet = await createTrigger(world, { name: "quiet-app", on: "github.issue_comment" });
    await startRun(world, quiet, window.previousStart);
    const active = await createTrigger(world, { name: "active", on: "slack.mention" });
    await startRun(world, active, window.previousStart, "failed");
    await startRun(world, active, window.recentStart);
    const activity = await world.database.listTriggerMatchActivity(world.org, window);
    expect(activity.find(({ name }) => name === "quiet-app")).toMatchObject({
      previousMatches: 1,
      recentMatches: 0,
      providers: [{ provider: "github", recentEvents: 0 }],
    });
    expect(stoppedTriggers(activity)).toEqual([]);
  });

  it("leaves out disabled triggers and other organizations", async () => {
    const world = await createWorld(engine);
    const mine = await createTrigger(world, { name: "mine", on: "slack.mention" });
    await startRun(world, mine, window.previousStart);
    await createTrigger(world, { name: "off", on: "slack.mention", enabled: false });
    const theirs = await createTrigger(world, {
      name: "theirs",
      on: "slack.mention",
      organization: "other",
    });
    await startRun(world, theirs, window.previousStart);
    await filterDrop(world, theirs, window.previousStart);
    await deliverSlackNoise(world, world.other, window.recentStart);
    expect(await activityOf(world)).toEqual([slackActivity("mine", 1, 0, 0)]);
    expect(await activityOf(world, world.other)).toEqual([slackActivity("theirs", 2, 0, 1)]);
  });
});
async function seedRunDays(world: World) {
  const daily = await createTrigger(world, { name: "daily", on: "manual.run" });
  const run = (at: string, outcome: RunOutcome) => startRun(world, daily, new Date(at), outcome);
  await run("2026-02-01T23:59:59.999Z", "failed");
  await run("2026-02-02T00:00:00.000Z", "succeeded");
  await run("2026-02-02T09:00:00.000Z", "failed");
  await run("2026-02-02T10:00:00.000Z", "timed_out");
  await run("2026-02-03T00:00:00.000Z", "rejected");
  await run("2026-02-03T23:30:00.000Z", "running");
  await run("2026-02-04T23:59:59.999Z", "succeeded");
  await run("2026-02-05T00:00:00.000Z", "failed");
  const foreign = await createTrigger(world, {
    name: "foreign",
    on: "manual.run",
    organization: "other",
  });
  await startRun(world, foreign, new Date("2026-02-02T12:00:00.000Z"), "failed");
}

describe.each(["postgres", "memory"] as const)("runs per day on %s", (engine) => {
  const since = new Date("2026-02-02T00:00:00Z");
  const until = new Date("2026-02-05T00:00:00Z");

  it("groups by UTC day, counts runs that did not finish and keeps to the window", async () => {
    const world = await createWorld(engine);
    await seedRunDays(world);
    expect(await world.database.listRunsPerDay(world.org, since, until)).toEqual([
      { day: "2026-02-02", total: 3, failed: 2 },
      { day: "2026-02-03", total: 2, failed: 0 },
      { day: "2026-02-04", total: 1, failed: 0 },
    ]);
  });

  it("never reads another organization's runs", async () => {
    const world = await createWorld(engine);
    await seedRunDays(world);
    expect(await world.database.listRunsPerDay(world.other, since, until)).toEqual([
      { day: "2026-02-02", total: 1, failed: 1 },
    ]);
    expect(await world.database.listRunsPerDay("absent", since, until)).toEqual([]);
  });
});

async function seedPlanHistory(world: World, fixture: Trigger) {
  const { runtimeProjectId: projectId } = fixture.trigger;
  const project = await world.database.findProjectById(projectId);
  assert.ok(project?.activeConfigurationRevisionId);
  const route = JSON.stringify([
    {
      projectId,
      configurationRevisionId: project.activeConfigurationRevisionId,
      connectionId: null,
      resourceId: null,
    },
  ]);
  return { projectId, revisionId: project.activeConfigurationRevisionId, route };
}

async function seedWindowHistory(world: World, fixture: Trigger) {
  const { projectId, revisionId, route } = await seedPlanHistory(world, fixture);
  // Mostly old history, a small window: the plan must follow the window, not the table.
  await pg.runtime.query(
    `with receipts as (
       insert into provider_event_receipts
         (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason,
          accepted_routes)
       select $1, 'slack', gen_random_uuid()::text, 'slack.mention', '{}',
         case when n <= 5000 then $2::timestamptz - interval '40 days'
              when n <= 5032 then $2::timestamptz + interval '1 day'
              else $3::timestamptz + interval '1 day' end,
         case when n > 5032 then 'trigger_filters_rejected' end,
         case when n > 5032 then $6::jsonb end
       from generate_series(1, 5064) n returning id, received_at, dropped_reason
     )
     insert into trigger_runs
       (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
        configured_trigger_name, status, prompt, deadline_at, created_at)
     select $1, $4, $5, id, 'plan', 'succeeded', '', received_at + interval '1 hour', received_at
     from receipts where dropped_reason is null`,
    [world.org, window.previousStart, window.recentStart, projectId, revisionId, route],
  );
  await pg.runtime.query("analyze provider_event_receipts, trigger_runs");
}

describe("read plans", () => {
  it("follows the window for the match read and counts filter drops with run matches", async () => {
    const world = await createWorld("postgres");
    const plan = await createTrigger(world, { name: "plan", on: "slack.mention" });
    await seedWindowHistory(world, plan);
    const activity = (await world.database.listTriggerMatchActivity(world.org, window)).find(
      ({ name }) => name === "plan",
    );
    expect(activity).toMatchObject({
      previousMatches: 32,
      recentMatches: 32,
      providers: [{ provider: "slack", recentEvents: 32 }],
    });
    const { rows } = await pg.runtime.query(`explain (analyze, buffers) ${TRIGGER_MATCHES_SQL}`, [
      world.org,
      window.previousStart,
      window.recentStart,
      window.now,
      PROVIDERS,
    ]);
    const output = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(output).toContain("trigger_runs_receipt_project_configured_unique");
    expect(output).toContain("provider_event_receipts_organization_received_idx");
    expect(output).not.toMatch(/Seq Scan on provider_event_receipts/u);
    process.stdout.write(`${output}\n`);
  });

  it("scans only the window's runs for the daily read", async () => {
    const world = await createWorld("postgres");
    const plan = await createTrigger(world, { name: "plan", on: "slack.mention" });
    await seedWindowHistory(world, plan);
    const { rows } = await pg.runtime.query(`explain (analyze, buffers) ${RUNS_PER_DAY_SQL}`, [
      world.org,
      ms(window.previousStart, 8 * 86_400_000),
      ms(window.previousStart, 20 * 86_400_000),
      ["failed", "timed_out"],
    ]);
    const output = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(output).toContain("trigger_runs_organization_created_id_idx");
    expect(output).not.toMatch(/Seq Scan on trigger_runs/u);
    process.stdout.write(`${output}\n`);
  });
});
