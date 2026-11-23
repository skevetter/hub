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
  await linkGitHubReceiptsToRuns();
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

it("keeps the ordered candidate lookup within the index budget on 50,000 receipts", async () => {
  await seed("github", 201, 1, "no_project_route");
  await seed("slack", 201, 1, "no_project_route");
  const since = new Date(Date.now() - 7 * 86_400_000);
  await harness.runtime.query("vacuum full analyze provider_event_receipts");
  const small = await explainGitHubPresence("402 recent receipts", since);
  expect(small.plan).toMatch(/Limit .* rows=1 loops=1/u);

  await harness.runtime.query(
    `insert into organization (id, name, slug)
     select 'drop-plan-' || n, 'Drop plan ' || n, 'drop-plan-' || n
     from generate_series(0, 7) n`,
  );
  // Batches keep each fixture statement inside the pool's 3 s query deadline on a loaded machine.
  for (let first = 1; first <= 50_000; first += 5_000) {
    await harness.runtime.query(
      `insert into provider_event_receipts
         (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
       select 'drop-plan-' || (n % 8), (array['github', 'linear', 'slack', 'discord'])[1 + (n / 8) % 4],
              'drop-plan-' || n, 'fixture.event', '{}',
              now() - (n % 9) * interval '1 day', 'no_project_route'
       from generate_series($1::int, $1::int + 4_999) n`,
      [first],
    );
  }
  await seed("github", 600, 2, "github_lifecycle");
  await linkGitHubReceiptsToRuns();
  await harness.runtime.query("analyze provider_event_receipts");
  await harness.runtime.query("analyze trigger_runs");
  const large = await explainGitHubPresence("51,003 receipts across nine organizations", since);
  expect(large.result).toBe("unknown");
  expect(large.plan).toMatch(
    /Index(?: Only)? Scan using provider_event_receipts_org_dropped_provider_idx .* rows=200 loops=1/u,
  );
  expect(large.plan).toMatch(/Index Only Scan using trigger_runs_.* loops=200/u);
  expect(large.plan).not.toMatch(/Seq Scan on provider_event_receipts|-> +Sort/u);
  expect(large.statement).toMatch(
    /order by receipt\.organization_id, receipt\.provider,\s+receipt\.received_at desc nulls first, receipt\.id desc nulls first\s+limit 200/u,
  );
});

async function linkGitHubReceiptsToRuns() {
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
}

async function explainGitHubPresence(label: string, since: Date) {
  let statement = "";
  let plan = "";
  const connection = await harness.connect({
    async beforeQuery(sql, params) {
      statement = sql;
      const { rows } = await harness.runtime.query<{ "QUERY PLAN": string }>(
        `explain (analyze, buffers) ${sql}`,
        params,
      );
      plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    },
  });
  const result = await connection.database.readDroppedEventPresence(
    organizationId,
    "github",
    since,
  );
  const planFile = process.env["HUB_CONNECTION_DROP_PLANS"];
  if (planFile !== undefined) await appendFile(planFile, `\n${label}\n${plan}\n`);
  return { statement, plan, result };
}

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
