import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organizationId,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";
import type { ActivityRunKey, ActivityRunPageRecord } from "./types.js";

const TOTAL = 9;

describe("organization activity pages on PostgreSQL", () => {
  let harness: TimelinePostgresHarness;
  let projectId = "";
  let expected: string[] = [];

  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
    for (let index = 0; index < TOTAL; index += 1) {
      projectId = (await harness.createRun()).projectId;
    }
    // Three groups share a timestamp, so only the id tells their runs apart.
    await harness.runtime.query(
      `update trigger_runs set created_at = timestamptz '2026-01-01 00:00:00+00'
         + make_interval(secs => (row_number_ % 3)::int)
       from (select id as run_id, row_number() over (order by id) as row_number_ from trigger_runs) numbered
       where id = numbered.run_id`,
    );
    const { rows } = await harness.runtime.query<{ id: string }>(
      "select id from trigger_runs order by created_at desc, id desc",
    );
    expected = rows.map(({ id }) => id);
  }, 120_000);

  afterAll(async () => {
    await harness.close();
  });

  const scopes = () => [{ projectId }];
  const ids = (page: ActivityRunPageRecord) => page.records.map(({ run }) => run.id);

  it("pages newest first with no gap or repeat across the shared timestamps", async () => {
    const pages: ActivityRunPageRecord[] = [];
    let position: { direction: "before"; key: ActivityRunKey } | undefined;
    for (;;) {
      const page = await harness.database.listOrganizationActivityPage(organizationId, scopes(), {
        limit: 4,
        ...(position === undefined ? {} : { position }),
      });
      pages.push(page);
      if (page.older === null) break;
      position = { direction: "before", key: page.older };
    }
    assert.deepEqual(
      pages.map((page) => page.records.length),
      [4, 4, 1],
    );
    assert.deepEqual(pages.flatMap(ids), expected);
    assert.equal(pages[0]!.newer, null);
    assert.notEqual(pages[1]!.newer, null);
    assert.equal(pages.at(-1)!.older, null);
  });

  it("reads the same pages back toward the newest", async () => {
    const newest = await harness.database.listOrganizationActivityPage(organizationId, scopes(), {
      limit: 4,
    });
    const second = await harness.database.listOrganizationActivityPage(organizationId, scopes(), {
      limit: 4,
      position: { direction: "before", key: newest.older! },
    });
    const back = await harness.database.listOrganizationActivityPage(organizationId, scopes(), {
      limit: 4,
      position: { direction: "after", key: second.newer! },
    });
    assert.deepEqual(ids(back), ids(newest));
    assert.equal(back.newer, null);
    assert.notEqual(back.older, null);
  });

  it("keeps microseconds in the keys it hands out", async () => {
    await harness.runtime.query(
      "update trigger_runs set created_at = created_at + interval '123456 microseconds' where id = $1",
      [expected[0]],
    );
    const page = await harness.database.listOrganizationActivityPage(organizationId, scopes(), {
      limit: 1,
    });
    assert.match(page.older!.createdAt, /\.\d{6}/u);
    const next = await harness.database.listOrganizationActivityPage(organizationId, scopes(), {
      limit: 1,
      position: { direction: "before", key: page.older! },
    });
    assert.notEqual(ids(next)[0], ids(page)[0]);
  });

  it("returns nothing for another organization, an unknown project or a named trigger without runs", async () => {
    for (const [org, narrowed] of [
      ["someone-else", scopes()],
      [organizationId, [{ projectId: "00000000-0000-4000-8000-000000000000" }]],
      [organizationId, [{ projectId, triggerName: "no-such-trigger" }]],
      [organizationId, []],
    ] as const) {
      const page = await harness.database.listOrganizationActivityPage(org, narrowed, {
        limit: 4,
      });
      assert.deepEqual(page, { records: [], older: null, newer: null });
    }
  });
});
