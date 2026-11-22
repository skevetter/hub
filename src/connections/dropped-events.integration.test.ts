import { appendFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organizationId,
  type TimelinePostgresHarness,
} from "../db/test-utils/run-timeline-postgres.js";
import { readConnectionDrops } from "./read-model.js";

let harness: TimelinePostgresHarness;
beforeAll(async () => {
  harness = await createTimelinePostgresHarness();
}, 90_000);
afterAll(async () => {
  await harness?.close();
});
beforeEach(async () => {
  await harness.runtime.query("delete from trigger_runs where organization_id = $1", [
    organizationId,
  ]);
  await harness.runtime.query("delete from provider_event_receipts where organization_id = $1", [
    organizationId,
  ]);
});

async function seed(provider: string, count: number, daysOld: number, reason: string) {
  await harness.runtime.query(
    `insert into provider_event_receipts
       (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
     select $1, $2, $2 || $5 || n, 'fixture.event', '{}',
            now() - $4::int * interval '1 day', $5
     from generate_series(1, $3::int) n`,
    [organizationId, provider, count, daysOld, reason],
  );
}

it("keeps a Slack drop discoverable when newer GitHub drops fill the cap", async () => {
  await seed("slack", 1, 2, "no_project_route");
  await seed("github", 2_500, 1, "no_project_route");
  await harness.runtime.query("analyze provider_event_receipts");
  const { result } = await observeConnectionDrops("Cross-provider activity");
  const page = await harness.database.listDroppedEventPage(organizationId, {
    limit: 15,
    provider: "slack",
    receivedSince: new Date(Date.now() - 7 * 86_400_000),
  });
  expect(page.records).toHaveLength(1);
  expect(result.droppedConnectionEvents.slack).toBe("some");
});

it("agrees with Activity when GitHub has both a route drop and a connection update", async () => {
  await seed("github", 1, 1, "github_lifecycle");
  await seed("github", 1, 1, "no_project_route");
  const { result } = await observeConnectionDrops("Routing drop and connection update");
  const page = await harness.database.listDroppedEventPage(organizationId, {
    limit: 15,
    provider: "github",
    receivedSince: new Date(Date.now() - 7 * 86_400_000),
  });
  expect(page.records.map(({ reason }) => reason).sort()).toEqual([
    "github_lifecycle",
    "no_project_route",
  ]);
  expect(result.droppedConnectionEvents.github).toBe("some");
  await harness.runtime.query("delete from provider_event_receipts where dropped_reason = $1", [
    "no_project_route",
  ]);
  expect(
    (await readConnectionDrops(harness.database, organizationId)).droppedConnectionEvents.github,
  ).toBe("some");
});

it("bounds the candidate and run-probe reads when 4,000 lifecycle receipts are excluded", async () => {
  await seed("github", 4_000, 1, "github_lifecycle");
  await harness.createRun();
  await harness.runtime.query(
    `insert into trigger_runs
       (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
        configured_trigger_name, status, prompt, deadline_at)
     select receipt.organization_id, fixture.project_id, fixture.configuration_revision_id,
            receipt.id, 'fixture', 'succeeded', '', receipt.received_at
     from provider_event_receipts receipt
     cross join (select project_id, configuration_revision_id from trigger_runs limit 1) fixture
     where receipt.organization_id = $1 and receipt.provider = 'github'`,
    [organizationId],
  );
  await harness.runtime.query("analyze provider_event_receipts");
  await harness.runtime.query("analyze trigger_runs");
  const { result, plans } = await observeConnectionDrops("4,000 excluded lifecycle receipts");
  const page = await harness.database.listDroppedEventPage(organizationId, {
    limit: 15,
    provider: "github",
    receivedSince: new Date(Date.now() - 7 * 86_400_000),
  });
  expect(page.records).toHaveLength(0);
  const plan = plans.get("github");
  expect(plan).toMatch(
    /Index(?: Only)? Scan using provider_event_receipts_org_dropped_provider_idx .* rows=200 loops=1/u,
  );
  expect(plan).toMatch(/Index Only Scan using trigger_runs_.* loops=200/u);
  expect(plan).not.toMatch(/Seq Scan on provider_event_receipts/u);
  expect(result.droppedConnectionEvents).toEqual({
    linear: "none",
    github: "unknown",
    slack: "none",
    discord: "none",
  });
});

async function observeConnectionDrops(label: string) {
  const plans = new Map<unknown, string>();
  const connection = await harness.connect({
    async beforeQuery(sql, params) {
      const { rows } = await harness.runtime.query<{ "QUERY PLAN": string }>(
        `explain (analyze, buffers) ${sql}`,
        params,
      );
      plans.set(params[1], rows.map((row) => row["QUERY PLAN"]).join("\n"));
    },
  });
  const result = await readConnectionDrops(connection.database, organizationId);
  const planFile = process.env["HUB_CONNECTION_DROP_PLANS"];
  if (planFile !== undefined) {
    await appendFile(planFile, `\n${label}\n${[...plans.values()].join("\n\n")}\n`);
  }
  return { result, plans };
}
