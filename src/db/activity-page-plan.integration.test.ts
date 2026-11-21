import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organizationId,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";
import type { ActivityRunPageRequest } from "./types.js";

const INDEX = "trigger_runs_organization_created_id_idx";

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

function nodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

describe("organization activity page plans", () => {
  let harness: TimelinePostgresHarness;
  let projectIds: string[] = [];

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
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  it("serves every Activity page read and adjacent probe from the organization index without a sort or sequential scan", async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
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
    const read = (position?: ActivityRunPageRequest["position"]) =>
      connection.database.listOrganizationActivityPage(organizationId, scopes, {
        limit: 25,
        ...(position === undefined ? {} : { position }),
      });

    async function expectPlans(...expected: [kind: string, pattern: RegExp][]) {
      const statements = captured.splice(0);
      assert.equal(statements.length, expected.length, expected.map(([kind]) => kind).join(", "));
      for (const [index, [kind, pattern]] of expected.entries()) {
        const { sql, params } = statements[index]!;
        assert.match(sql, pattern, `${kind}: unexpected SQL`);
        const { rows } = await harness.runtime.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
          `explain (format json) ${sql}`,
          params,
        );
        const used = nodes(rows[0]!["QUERY PLAN"][0].Plan);
        for (const node of used) {
          const type = node["Node Type"];
          const relation = node["Relation Name"];
          assert.ok(!type.endsWith("Sort"), `${kind}: unexpected ${type} node`);
          assert.ok(
            type !== "Seq Scan" ||
              (relation !== "trigger_runs" && relation !== "provider_event_receipts"),
            `${kind}: unexpected sequential scan of ${relation}`,
          );
        }
        assert.ok(
          used.some(
            (node) =>
              node["Index Name"] === INDEX &&
              (node["Node Type"] === "Index Scan" || node["Node Type"] === "Index Only Scan"),
          ),
          `${kind}: expected an ordered scan using ${INDEX}`,
        );
      }
    }

    const first = await read();
    await expectPlans([
      "newest page read",
      /^select runs\.\*,[\s\S]*order by runs\.created_at desc/u,
    ]);
    assert.ok(first.older);

    const second = await read({ direction: "before", key: first.older });
    await expectPlans(
      ["older page read", /^select runs\.\*,[\s\S]*and \(runs\.created_at, runs\.id\) </u],
      [
        "newer availability probe",
        /^select 1\b[\s\S]*and \(runs\.created_at, runs\.id\) >[\s\S]*limit 1$/u,
      ],
    );
    assert.ok(second.newer);

    await read({ direction: "after", key: second.newer });
    await expectPlans(
      ["newer page read", /^select runs\.\*,[\s\S]*and \(runs\.created_at, runs\.id\) >/u],
      [
        "older availability probe",
        /^select 1\b[\s\S]*and \(runs\.created_at, runs\.id\) <[\s\S]*limit 1$/u,
      ],
    );
  }, 30_000);
});
