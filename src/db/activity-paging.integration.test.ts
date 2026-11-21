import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { PAGE_SIZES } from "../components/app/page-size.js";
import { ACTIVITY_STATUSES } from "../triggers/activity-query.js";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "./runtime/index.js";
import { createPostgresTestRuntime } from "./test-utils/runtime.js";
import type { ActivityRunPageRequest, ActivityRunScope, Database } from "./types.js";

const ORGANIZATION = "activity-paging-org";
const OTHER_ORGANIZATION = "activity-paging-other";
const NEWEST = new Date("2026-01-01T00:06:00Z");

describe.each(["postgres", "pglite"] as const)("activity page SQL on %s", (engine) => {
  let runtime: DatabaseRuntime;
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let scopes: ActivityRunScope[];

  beforeAll(async () => {
    if (engine === "postgres") {
      const container = await new PostgreSqlContainer("postgres:17-alpine").start();
      close = async () => {
        await container.stop();
      };
      ({ runtime, database } = await createPostgresTestRuntime(container.getConnectionUri()));
    } else {
      const directory = await mkdtemp(join(tmpdir(), "hub-activity-paging-"));
      close = () => rm(directory, { recursive: true, force: true });
      const bundle = await embeddedDatabaseRuntime(directory);
      runtime = bundle.runtime;
      await runtime.migrate();
      database = createDatabase(runtime, bundle.locks);
    }
    scopes = await seedActivity(database, runtime, engine === "postgres" ? 3000 : 240);
  }, 60_000);

  afterAll(async () => {
    try {
      await runtime?.close();
    } finally {
      await close?.();
    }
  });

  it("applies status, provider, legacy trigger and time filters before limiting", async () => {
    const read = (request: Partial<ActivityRunPageRequest>, inScopes = scopes) =>
      database.listOrganizationActivityPage(ORGANIZATION, inScopes, { limit: 15, ...request });
    for (const status of ACTIVITY_STATUSES) {
      const { records } = await read({ status });
      assert.equal(records.length, 15);
      assert.ok(records.every(({ run }) => run.status === status));
    }
    for (const provider of ["webhook", "manual", "github"] as const) {
      const { records } = await read({ provider });
      assert.equal(records.length, 15);
      const source = { manual: "manual.run", webhook: "webhook.received", github: "github.push" };
      assert.ok(records.every(({ receipt }) => receipt.source === source[provider]));
    }
    const selected = scopes.at(-1)!;
    const { records } = await read({}, [selected]);
    assert.equal(records.length, 15);
    assert.ok(
      records.every(
        ({ run }) =>
          run.projectId === selected.projectId && run.configuredTriggerName === "selected",
      ),
    );
    assert.equal(
      (await read({ createdSince: new Date("2026-01-01T00:00:25Z") })).records.length,
      15,
    );
    assert.deepEqual((await read({ createdSince: new Date("2026-01-02T00:00:00Z") })).records, []);
    const combined = await read({
      status: "succeeded",
      provider: "manual",
      createdSince: new Date("2026-01-01T00:00:15Z"),
    });
    assert.equal(combined.records.length, 15);
    assert.ok(
      combined.records.every(
        ({ run, receipt }) =>
          run.status === "succeeded" &&
          receipt.source === "manual.run" &&
          run.createdAt >= new Date("2026-01-01T00:00:15Z"),
      ),
    );
    const foreign = await database.listOrganizationActivityPage(OTHER_ORGANIZATION, scopes, {
      limit: 15,
    });
    assert.deepEqual(foreign.records, []);
  });

  it.each(PAGE_SIZES)("walks tied keys both ways at size %i", async (limit) => {
    const [firstScope] = scopes;
    assert.ok(firstScope);
    const fixtureCount = engine === "postgres" ? 3000 : 240;
    const cutoff = new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor((fixtureCount - 133) / 8)));
    const expected = await runtime.query<{ id: string }>(
      `select id from trigger_runs where project_id = $1 and created_at >= $2::timestamptz
       order by created_at desc, id desc`,
      [firstScope.projectId, cutoff.toISOString()],
    );
    const read = (position?: ActivityRunPageRequest["position"]) =>
      database.listOrganizationActivityPage(ORGANIZATION, [firstScope], {
        limit,
        createdSince: cutoff,
        ...(position === undefined ? {} : { position }),
      });
    const all = expected.rows.map(({ id }) => id);
    assert.ok(all.length > 100);
    let page = await read();
    let offset = 0;
    const ids = () => page.records.map(({ run }) => run.id);
    for (;;) {
      assert.deepEqual(ids(), all.slice(offset, offset + limit));
      if (page.older === null) break;
      offset += limit;
      page = await read({ direction: "before", key: page.older });
    }
    assert.equal(offset + page.records.length, all.length);
    while (page.newer !== null) {
      page = await read({ direction: "after", key: page.newer });
      offset -= limit;
      assert.deepEqual(ids(), all.slice(offset, offset + limit));
    }
    assert.equal(offset, 0);
  });

  if (engine === "postgres") {
    it("checks the plans for default and filtered page reads over 27,000 runs", async () => {
      const { rows } = await runtime.query<{ runs: number }>(
        "select count(*)::int as runs from trigger_runs",
      );
      assert.equal(rows[0]?.runs, 27000);
      const observed = vi.spyOn(runtime, "query");
      try {
        const samples = [
          { label: "default", request: {}, scopes },
          { label: "status", request: { status: "failed" }, scopes },
          { label: "trigger", request: {}, scopes: [scopes.at(-1)!] },
          { label: "provider", request: { provider: "github" }, scopes },
          { label: "time", request: { createdSince: NEWEST }, scopes },
          {
            label: "combined",
            request: { status: "succeeded", provider: "manual", createdSince: NEWEST },
            scopes,
          },
        ] as const;
        for (const sample of samples) {
          observed.mockClear();
          const first = await database.listOrganizationActivityPage(ORGANIZATION, sample.scopes, {
            limit: 15,
            ...sample.request,
          });
          await explain(sample.label, observed.mock.calls[0]);
          assert.ok(first.older);
          observed.mockClear();
          const second = await database.listOrganizationActivityPage(ORGANIZATION, sample.scopes, {
            limit: 15,
            ...sample.request,
            position: { direction: "before", key: first.older },
          });
          await explain(`${sample.label} Older`, observed.mock.calls[0]);
          assert.ok(second.newer);
          observed.mockClear();
          await database.listOrganizationActivityPage(ORGANIZATION, sample.scopes, {
            limit: 15,
            ...sample.request,
            position: { direction: "after", key: second.newer },
          });
          await explain(`${sample.label} Newer`, observed.mock.calls[0]);
        }
        const {
          rows: [deep],
        } = await runtime.query<{ id: string; createdAt: string }>(
          `select id, created_at::text as "createdAt" from trigger_runs
           where organization_id = $1 and project_id = any($2::uuid[])
           order by created_at desc, id desc offset 11000 limit 1`,
          [ORGANIZATION, scopes.slice(0, 4).map(({ projectId }) => projectId)],
        );
        assert.ok(deep);
        const captures = [];
        observed.mockClear();
        await database.listOrganizationActivityPage(ORGANIZATION, scopes, { limit: 15 });
        captures.push({ label: "review default first", calls: [...observed.mock.calls] });
        for (const direction of ["before", "after"] as const) {
          observed.mockClear();
          await database.listOrganizationActivityPage(ORGANIZATION, scopes, {
            limit: 15,
            position: { direction, key: deep },
          });
          captures.push({
            label: `review default deep ${direction}`,
            calls: [...observed.mock.calls],
          });
        }
        for (const { label, calls } of captures) {
          for (const [index, call] of calls.entries()) {
            await explain(`${label} ${index}`, call);
          }
        }
        assert.deepEqual(
          captures.map(({ calls }) => calls.length),
          [1, 2, 2],
        );
        for (const { label, calls } of captures) {
          assert.ok(
            calls.every(([sql]) => !/\bcount\s*\(/iu.test(sql)),
            label,
          );
        }
      } finally {
        observed.mockRestore();
      }
    });
  }

  async function explain(label: string, call: Parameters<DatabaseRuntime["query"]> | undefined) {
    assert.ok(call);
    const [sql, params] = call;
    const { rows } = await runtime.query<{ "QUERY PLAN": string }>(
      `explain (analyze, buffers, settings) ${sql}`,
      params,
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    const directory = process.env["HUB_ACTIVITY_EXPLAIN_DIR"];
    if (directory !== undefined) {
      await writeFile(
        join(directory, `${label.toLowerCase().replaceAll(" ", "-")}.txt`),
        `${plan}\n`,
      );
    }
    if (!label.startsWith("default") && !label.startsWith("review default")) return;
    assert.match(
      plan,
      /Index Scan (?:Backward )?using trigger_runs_organization_created_id_idx/u,
      label,
    );
    assert.doesNotMatch(
      plan,
      /Seq Scan on (?:trigger_runs|provider_event_receipts)|->\s+Sort\s/u,
      label,
    );
  }
});

async function seedActivity(database: Database, runtime: DatabaseRuntime, runsPerProject: number) {
  await runtime.query(
    "insert into organization (id, name, slug) values ($1, 'Activity', 'activity'), ($2, 'Foreign', 'foreign')",
    [ORGANIZATION, OTHER_ORGANIZATION],
  );
  const scopes: ActivityRunScope[] = [];
  for (let index = 0; index < 9; index += 1) {
    const organizationId = index === 8 ? OTHER_ORGANIZATION : ORGANIZATION;
    const project = await database.createProject({
      organizationId,
      name: `Fixture ${index}`,
      slug: `fixture-${index}`,
      createdByUserId: null,
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: `fixture-${index}`,
    });
    await runtime.query(
      `with fixture as (
        select n, $4::text || '-' || n as delivery_id,
          timestamptz '2026-01-01Z' + (n / 8) * interval '1 second' + ((n % 8) / 4) * interval '100 microseconds' as at,
          (array['running', 'succeeded', 'failed', 'timed_out', 'canceled', 'rejected'])[n % 6 + 1] as status,
          (array['manual.run', 'webhook.received', 'github.push'])[n % 5 % 3 + 1] as source
        from generate_series(1, $5::int) n
      ), receipts as (
        insert into provider_event_receipts (organization_id, provider, delivery_id, source, payload, received_at)
        select $1, case when source = 'github.push' then 'github' else 'manual' end, delivery_id, source, '{}'::jsonb, at
        from fixture returning id, delivery_id
      )
      insert into trigger_runs (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
          configured_trigger_name, status, outcome, rejection, prompt, deadline_at, created_at)
      select md5('run-' || fixture.delivery_id)::uuid, $1, $2, $3, receipts.id,
        case when n % 2 = 0 then 'selected' else 'other' end, status,
        case when status = 'rejected' then 'rejected' else 'accepted' end,
        case when status = 'rejected' then '{"code":"missing_required","inputName":"fixture"}'::jsonb end,
        '', case when status <> 'rejected' then at + interval '1 hour' end, at
      from fixture join receipts using (delivery_id)`,
      [organizationId, project.id, revision.id, String(index), runsPerProject],
    );
    if (index < 6)
      scopes.push(
        index < 4 ? { projectId: project.id } : { projectId: project.id, triggerName: "selected" },
      );
  }
  await runtime.query("analyze trigger_runs");
  await runtime.query("analyze provider_event_receipts");
  return scopes;
}
