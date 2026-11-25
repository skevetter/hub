import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as org,
  type TimelinePostgresHarness,
} from "../db/test-utils/run-timeline-postgres.js";
import { FAILED_RUN_STATUSES } from "../triggers/run-status.js";
import { ACTIVE_TRIGGER_REVISIONS_SQL, TRIGGER_RUN_SUMMARY_SQL } from "./queries.js";

let pg: TimelinePostgresHarness;
const since = new Date("2026-01-08T00:00:00Z");
const otherOrg = "other";
const DELIVERY = "summary:";
let projectCount = 0;

beforeAll(async () => {
  pg = await createTimelinePostgresHarness();
  await pg.runtime.query("insert into organization (id, name, slug) values ($1, $1, $1)", [
    otherOrg,
  ]);
}, 60_000);

afterAll(async () => pg?.close());

beforeEach(async () => {
  await pg.runtime.query("delete from trigger_runs where configured_trigger_name like 'seed:%'");
  await pg.runtime.query("delete from provider_event_receipts where delivery_id like $1", [
    `${DELIVERY}%`,
  ]);
  await pg.runtime.query("delete from organization_triggers where name like 'seed:%'");
});

type Run = [status: string, secondsAfterSince: number];

/** A trigger with its own runtime project, and the runs it started at fixed times. */
async function seedTrigger(name: string, runs: readonly Run[], organizationId = org) {
  const { database, runtime } = pg;
  projectCount += 1;
  const project = await database.createProject({
    organizationId,
    name: `seed ${String(projectCount)}`,
    slug: `seed-${String(projectCount)}`,
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: `seed-${String(projectCount)}`,
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const {
    rows: [trigger],
  } = await runtime.query<{ id: string }>(
    `insert into organization_triggers (organization_id, name, format, runtime_project_id)
     values ($1, $2, 'single_run', $3) returning id`,
    [organizationId, `seed:${name}`, project.id],
  );
  for (const [index, [status, seconds]] of runs.entries()) {
    await seedRun({
      organizationId,
      projectId: project.id,
      revisionId: revision.id,
      name,
      index,
      status,
      seconds,
    });
  }
  return trigger!.id;
}

async function seedRun(run: {
  organizationId: string;
  projectId: string;
  revisionId: string;
  name: string;
  index: number;
  status: string;
  seconds: number;
}) {
  const at = new Date(since.getTime() + run.seconds * 1000);
  await pg.runtime.query(
    `with receipt as (
       insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload, received_at)
       values ($1, 'manual', $2, 'manual.run', '{}', $3) returning id
     )
     insert into trigger_runs (organization_id, project_id, configuration_revision_id,
       provider_event_receipt_id, configured_trigger_name, status, prompt, outcome, rejection,
       created_at, completed_at, deadline_at)
     select $1, $4, $5, id, $6, $7, '', case when $7 = 'rejected' then 'rejected' else 'accepted' end,
       case when $7 = 'rejected' then '{}'::jsonb else null end, $3,
       case when $7 = 'running' then null else $3::timestamptz end,
       case when $7 = 'rejected' then null else '2030-01-01'::timestamptz end from receipt`,
    [
      run.organizationId,
      `${DELIVERY}${run.name}:${String(run.index)}`,
      at,
      run.projectId,
      run.revisionId,
      `seed:${run.name}`,
      run.status,
    ],
  );
}

describe("per-trigger run summaries", () => {
  it("tallies the window by outcome and reports the newest run whatever its age", async () => {
    const id = await seedTrigger("mixed", [
      ["failed", -86_400],
      ["succeeded", 0],
      ["failed", 10],
      ["timed_out", 20],
      ["rejected", 30],
      ["canceled", 40],
      ["succeeded", 50],
      ["running", 60],
    ]);
    const summaries = await pg.database.summarizeTriggerRuns(org, since);
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    expect({ ...summary, latest: summary?.latest && { ...summary.latest, id: "run" } }).toEqual({
      triggerId: id,
      total: 7,
      failed: 3,
      latest: { id: "run", status: "running", createdAt: new Date("2026-01-08T00:01:00Z") },
    });
  });

  it("keeps how a quiet trigger last ended and lists triggers that never ran", async () => {
    const quiet = await seedTrigger("quiet", [["failed", -86_400 * 20]]);
    const never = await seedTrigger("never", []);
    const byId = new Map(
      (await pg.database.summarizeTriggerRuns(org, since)).map((entry) => [entry.triggerId, entry]),
    );
    expect(byId.get(quiet)).toMatchObject({ total: 0, failed: 0, latest: { status: "failed" } });
    expect(byId.get(never)).toEqual({ triggerId: never, total: 0, failed: 0, latest: null });
  });

  it("counts a run created exactly at the window start and orders ties by id", async () => {
    const id = await seedTrigger("edge", [
      ["succeeded", -1],
      ["succeeded", 0],
      ["failed", 5],
      ["succeeded", 5],
    ]);
    const [summary] = await pg.database.summarizeTriggerRuns(org, since);
    expect(summary).toMatchObject({ triggerId: id, total: 3, failed: 1 });
    const high = "ffffffff-ffff-4fff-8fff-fffffffffff";
    const low = "00000000-0000-4000-8000-00000000000";
    const give = async (status: string, runId: string) =>
      pg.runtime.query("update trigger_runs set id = $1 where status = $2 and created_at = $3", [
        runId,
        status,
        new Date(since.getTime() + 5000),
      ]);
    await give("failed", `${high}1`);
    await give("succeeded", `${low}1`);
    const failedWins = await pg.database.summarizeTriggerRuns(org, since);
    expect(failedWins[0]?.latest).toMatchObject({ id: `${high}1`, status: "failed" });
    await give("failed", `${low}2`);
    await give("succeeded", `${high}2`);
    const succeededWins = await pg.database.summarizeTriggerRuns(org, since);
    expect(succeededWins[0]?.latest).toMatchObject({ id: `${high}2`, status: "succeeded" });
  });

  it("never reports another organization's triggers or runs", async () => {
    const mine = await seedTrigger("mine", [["succeeded", 1]]);
    const theirs = await seedTrigger(
      "theirs",
      [
        ["failed", 1],
        ["failed", 2],
      ],
      otherOrg,
    );
    expect(
      (await pg.database.summarizeTriggerRuns(org, since)).map((entry) => entry.triggerId),
    ).toEqual([mine]);
    const [summary] = await pg.database.summarizeTriggerRuns(otherOrg, since);
    expect(summary).toMatchObject({ triggerId: theirs, total: 2, failed: 2 });
    expect(await pg.database.summarizeTriggerRuns("absent", since)).toEqual([]);
  });

  it("walks the project and time index for each trigger instead of the run table", async () => {
    const { database, runtime } = pg;
    const projects: string[] = [];
    const revisions: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const project = await database.createProject({
        organizationId: org,
        name: `explain ${String(index)}`,
        slug: `explain-${String(index)}`,
        createdByUserId: null,
      });
      const revision = await database.insertProjectConfigurationRevision({
        projectId: project.id,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: `explain-${String(index)}`,
      });
      await database.activateProjectConfigurationRevision(project.id, revision.id, []);
      await runtime.query(
        `insert into organization_triggers (organization_id, name, format, runtime_project_id)
         values ($1, $2, 'single_run', $3)`,
        [org, `seed:explain-${String(index)}`, project.id],
      );
      projects.push(project.id);
      revisions.push(revision.id);
    }
    // The pool cancels a statement after a few seconds, so history goes in as small batches.
    for (let batch = 0; batch < 8; batch += 1) {
      await runtime.query(
        `insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload, received_at)
         select $1, 'manual', $2 || n::text, $3, '{}', '2025-01-01'
         from generate_series($4::int, $4::int + 1999) n`,
        [org, `${DELIVERY}explain:`, `batch-${String(batch)}`, batch * 2000],
      );
      await runtime.query(
        `insert into trigger_runs (organization_id, project_id, configuration_revision_id,
           provider_event_receipt_id, configured_trigger_name, status, prompt, deadline_at, created_at)
         select $1, ($2::uuid[])[slot], ($3::uuid[])[slot], id, 'seed:old', 'succeeded', '', now(),
           '2025-01-01'
         from (
           select id, 1 + (row_number() over () % 40)::int as slot
           from provider_event_receipts where source = $4
         ) numbered`,
        [org, projects, revisions, `batch-${String(batch)}`],
      );
    }
    await runtime.query("analyze provider_event_receipts, trigger_runs, organization_triggers");
    const plan = await runtime.query(`explain (analyze, buffers) ${TRIGGER_RUN_SUMMARY_SQL}`, [
      org,
      since,
      [...FAILED_RUN_STATUSES],
    ]);
    const output = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(output).toContain("trigger_runs_project_created_idx");
    expect(output).not.toMatch(/Seq Scan on trigger_runs/u);
  });
});

async function seedRevisions(name: string, versions: number, organizationId = org) {
  const {
    rows: [trigger],
  } = await pg.runtime.query<{ id: string }>(
    `insert into organization_triggers (organization_id, name, format)
     values ($1, $2, 'legacy_multistep') returning id`,
    [organizationId, `seed:${name}`],
  );
  const ids: string[] = [];
  for (let version = 1; version <= versions; version += 1) {
    const {
      rows: [revision],
    } = await pg.runtime.query<{ id: string }>(
      `insert into organization_trigger_revisions
         (trigger_id, organization_id, version, yaml, normalized_configuration, content_hash,
          source_kind, source_evidence)
       values ($1, $2, $3, $4, '{}'::jsonb, $5, 'manual', '{}'::jsonb) returning id`,
      [
        trigger!.id,
        organizationId,
        version,
        `name: ${name} v${String(version)}`,
        `${name}-${String(version)}`,
      ],
    );
    ids.push(revision!.id);
  }
  return { triggerId: trigger!.id, revisionIds: ids };
}

async function activate({ triggerId, revisionIds }: Awaited<ReturnType<typeof seedRevisions>>) {
  await pg.runtime.query("update organization_triggers set active_revision_id = $2 where id = $1", [
    triggerId,
    revisionIds.at(-1),
  ]);
}

describe("active trigger revisions", () => {
  it("returns each trigger's active revision once, for the organization only", async () => {
    const first = await seedRevisions("first", 3);
    const second = await seedRevisions("second", 1);
    await seedRevisions("draft", 2);
    const theirs = await seedRevisions("theirs", 2, otherOrg);
    await Promise.all([first, second, theirs].map(activate));

    const revisions = await pg.database.listActiveOrganizationTriggerRevisions(org);
    const ownIds = new Set([first.triggerId, second.triggerId]);
    const mine = revisions.filter(({ triggerId }) => ownIds.has(triggerId));

    expect(mine.map(({ id }) => id).sort()).toEqual(
      [first, second].map(({ revisionIds }) => revisionIds.at(-1)!).sort(),
    );
    expect(mine.find(({ triggerId }) => triggerId === first.triggerId)).toMatchObject({
      version: 3,
      yaml: "name: first v3",
      organizationId: org,
    });
    expect(revisions.some(({ yaml }) => yaml.startsWith("name: draft"))).toBe(false);
    expect(revisions.some(({ triggerId }) => triggerId === theirs.triggerId)).toBe(false);
    expect(await pg.database.listActiveOrganizationTriggerRevisions("absent")).toEqual([]);
  });

  it("looks each revision up by key instead of scanning the revisions table", async () => {
    const { runtime } = pg;
    for (const [organizationId, count] of [
      [org, 40],
      [otherOrg, 2000],
    ] as const) {
      await runtime.query(
        `insert into organization_triggers (organization_id, name, format)
         select $1, 'seed:plan-' || n, 'legacy_multistep' from generate_series(1, $2::int) n`,
        [organizationId, count],
      );
    }
    await runtime.query(`insert into organization_trigger_revisions
        (trigger_id, organization_id, version, yaml, normalized_configuration, content_hash,
         source_kind, source_evidence)
      select id, organization_id, 1, '', '{}'::jsonb, 'plan-' || id, 'manual', '{}'::jsonb
      from organization_triggers where name like 'seed:plan-%'`);
    await runtime.query(`insert into organization_trigger_revisions
        (trigger_id, organization_id, version, yaml, normalized_configuration, content_hash,
         source_kind, source_evidence)
      select id, organization_id, 2, '', '{}'::jsonb, 'plan-2-' || id, 'manual', '{}'::jsonb
      from organization_triggers where name like 'seed:plan-%'`);
    await runtime.query(`update organization_triggers trigger set active_revision_id = revision.id
      from organization_trigger_revisions revision
      where revision.trigger_id = trigger.id and revision.version = 2
        and trigger.name like 'seed:plan-%'`);
    await runtime.query("analyze organization_triggers, organization_trigger_revisions");
    const plan = await runtime.query(`explain (analyze, buffers) ${ACTIVE_TRIGGER_REVISIONS_SQL}`, [
      org,
    ]);
    const output = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(output).toMatch(/Index (Only )?Scan using organization_trigger_revisions_/u);
    expect(output).toMatch(/Index Cond: \(\(?id = trigger\.active_revision_id\)/u);
    expect(output).not.toMatch(/Seq Scan on organization_trigger_revisions/u);
  });
});
