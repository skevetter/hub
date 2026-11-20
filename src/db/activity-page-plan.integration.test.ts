import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organizationId,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";
import type { ActivityRunPageRecord } from "./types.js";

const INDEX = "trigger_runs_organization_created_id_idx";

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

describe("organization activity page plans", () => {
  let harness: TimelinePostgresHarness;
  let projectIds: string[] = [];
  const captured: { sql: string; params: unknown[] }[] = [];

  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
    const seed = await harness.createRun();
    const { rows } = await harness.runtime.query<{ revision: string }>(
      "select configuration_revision_id as revision from trigger_runs where id = $1",
      [seed.id],
    );
    const other = "plan-other-organization";
    await harness.runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Other', 'plan-other')",
      [other],
    );
    // Eight projects in this organization and one in another: the shape of a shared table.
    const owners = [...Array.from({ length: 7 }, () => organizationId), other];
    const projects = [{ id: seed.projectId, revision: rows[0]!.revision, owner: organizationId }];
    for (const [index, owner] of owners.entries()) {
      const project = await harness.database.createProject({
        organizationId: owner,
        name: `Plan ${index}`,
        slug: `plan-${index}`,
        createdByUserId: null,
      });
      const revision = await harness.database.insertProjectConfigurationRevision({
        projectId: project.id,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: `plan-${index}`,
      });
      projects.push({ id: project.id, revision: revision.id, owner });
    }
    projectIds = projects.slice(0, 7).map(({ id }) => id);
    for (const [index, project] of projects.entries()) {
      await harness.runtime.query(
        `with receipt as (
           insert into provider_event_receipts (id, organization_id, provider, delivery_id, source, payload, received_at)
           select md5('plan-receipt-' || $3 || '-' || n)::uuid, $1, 'manual', 'plan-' || $3 || '-' || n,
                  'manual.run', '{}'::jsonb, timestamptz '2026-01-01' + (n / 8) * interval '1 second'
           from generate_series(1, 3000) n
           returning id, delivery_id, received_at
         )
         insert into trigger_runs (id, organization_id, project_id, configuration_revision_id,
                                   provider_event_receipt_id, configured_trigger_name, status, prompt,
                                   deadline_at, created_at)
         select md5('plan-run-' || delivery_id)::uuid, $1, $2, $4, id,
                case when split_part(delivery_id, '-', 3)::int % 2 = 0 then 'selected' else 'other' end,
                'succeeded', '', received_at + interval '1 hour', received_at
         from receipt`,
        [project.owner, project.id, String(index), project.revision],
      );
    }
    await harness.runtime.query("analyze trigger_runs");
    await harness.runtime.query("analyze provider_event_receipts");
    const connection = await harness.connect();
    const run = connection.runtime.query.bind(connection.runtime);
    connection.runtime.query = (sql, params) => {
      captured.push({ sql, params: [...(params ?? [])] });
      return run(sql, params);
    };
    const scopes = [
      ...projectIds.slice(0, 5).map((projectId) => ({ projectId })),
      ...projectIds.slice(5).map((projectId) => ({ projectId, triggerName: "selected" })),
    ];
    const read = (
      position?: Parameters<typeof connection.database.listOrganizationActivityPage>[2]["position"],
    ) =>
      connection.database.listOrganizationActivityPage(organizationId, scopes, {
        limit: 25,
        ...(position === undefined ? {} : { position }),
      });
    const first: ActivityRunPageRecord = await read();
    const second = await read({ direction: "before", key: first.older! });
    await read({ direction: "after", key: second.newer! });
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  it("serves the newest, older and newer page reads from the organization index without a sort", async () => {
    const pages = captured.filter(({ sql }) => /order by runs\.created_at/u.test(sql));
    assert.equal(pages.length, 3);
    for (const { sql, params } of pages) {
      const plan = await harness.runtime.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
        `explain (format json) ${sql}`,
        params,
      );
      const used = nodes(plan.rows[0]!["QUERY PLAN"][0].Plan);
      assert.ok(
        used.some((node) => node["Index Name"] === INDEX),
        `expected ${INDEX} in ${JSON.stringify(used.map((node) => node["Node Type"]))}`,
      );
      assert.ok(
        used.every((node) => node["Node Type"] !== "Sort"),
        "the page read should come ordered from the index",
      );
    }
  });
});
