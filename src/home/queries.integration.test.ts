import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as org,
  type TimelinePostgresHarness,
} from "../db/test-utils/run-timeline-postgres.js";
import { FAILED_RUN_STATUSES } from "../triggers/run-status.js";
import { TRIGGER_RUN_SUMMARY_SQL } from "./queries.js";

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
