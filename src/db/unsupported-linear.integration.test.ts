import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createLinearWebhookSource } from "../triggers/linear/webhook.js";
import { createMemoryDatabase } from "./memory.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organization,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";
import type { Database } from "./types.js";

const other = "unsupported-other";
const seeded = "unsupported-seeded";
const now = new Date("2026-01-02T00:00:00Z");
const hour = 3_600_000;
const secret = "linear-unsupported-test";
const mainConnection = {
  id: "30000000-0000-4000-8000-000000000021",
  organizationId: organization,
  slug: "main-linear",
  providerApplicationId: null,
  linearOrganizationId: "linear-main",
  linearOrganizationName: "Main",
  appUserId: "app",
  accessToken: "fixture",
  refreshToken: null,
  accessTokenExpiresAt: null,
  scopes: [],
};
const otherConnection = {
  ...mainConnection,
  id: "30000000-0000-4000-8000-000000000022",
  organizationId: other,
  slug: "other-linear",
  linearOrganizationId: "linear-other",
};

const seededConnection = {
  ...mainConnection,
  id: "30000000-0000-4000-8000-000000000023",
  organizationId: seeded,
  slug: "seeded-linear",
  linearOrganizationId: "linear-seeded",
};

async function deliver(
  database: Database,
  deliveryId: string,
  input: { workspace?: string; time?: Date } = {},
) {
  const timestamp = (input.time ?? now).getTime();
  const endpoint = createLinearWebhookSource({
    signingSecret: secret,
    now: () => timestamp,
    accept: (event) => database.acceptLinearEvent(event),
  });
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    action: `created-${deliveryId}`,
    organizationId: input.workspace ?? "linear-main",
    webhookTimestamp: timestamp,
    data: { private: "PRIVATE" },
  });
  const result = await endpoint.handle(
    new Request("https://hub.test/linear", {
      method: "POST",
      headers: {
        "linear-delivery": deliveryId,
        "linear-event": "AgentSessionEvent",
        "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    }),
  );
  assert.equal(result.status, 200);
}

async function checkRateLimit(database: Database, reopen: () => Promise<Database>) {
  await deliver(database, "rate-a");
  await deliver(database, "rate-a");
  await deliver(database, "rate-b");
  const restarted = await reopen();
  await deliver(restarted, "rate-denied");
  await deliver(restarted, "rate-other", { workspace: "linear-other" });
  const main = await restarted.listDroppedEventPage(organization, {
    limit: 15,
    reason: "unsupported_event",
  });
  const separate = await restarted.listDroppedEventPage(other, {
    limit: 15,
    reason: "unsupported_event",
  });
  assert.equal(
    main.records.length,
    2,
    "a duplicate or excess delivery changed the persisted budget",
  );
  assert.equal(separate.records.length, 1);
  const next = new Date(now.getTime() + hour);
  await deliver(restarted, "rate-next-a", { time: next });
  await deliver(restarted, "rate-delayed-a", { time: now });
  await deliver(restarted, "rate-next-denied", { time: next });
  await deliver(restarted, "rate-delayed-denied", { time: now });
  assert.equal(
    (await restarted.listDroppedEventPage(organization, { limit: 15 })).records.length,
    4,
  );
}

it("limits unsupported Linear writes by organization and never reopens a past window in memory", async () => {
  const database = createMemoryDatabase({
    organizationIds: [organization, other],
    linearConnections: [mainConnection, otherConnection],
    unsupportedLinearReceiptsPerHour: 2,
  });
  await checkRateLimit(database, () => Promise.resolve(database));
});

describe("PostgreSQL unsupported Linear intake", () => {
  let harness: TimelinePostgresHarness;
  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
    await harness.runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Other', 'unsupported-other'), ($2, 'Seeded', 'unsupported-seeded')",
      [other, seeded],
    );
    for (const connection of [mainConnection, otherConnection, seededConnection]) {
      await harness.runtime.query(
        `insert into linear_connections
           (id, organization_id, linear_organization_id, slug, linear_organization_name, app_user_id, access_token)
         values ($1, $2, $3, $4, 'Fixture', 'app', 'fixture')`,
        [
          connection.id,
          connection.organizationId,
          connection.linearOrganizationId,
          connection.slug,
        ],
      );
    }
  }, 120_000);
  afterAll(async () => harness?.close());

  it("enforces the write budget even from a new store and leaves other organizations independent", async () => {
    const opening = async () => (await harness.connect({}, 1, 2)).database;
    await checkRateLimit(await opening(), opening);
  });

  it("keeps cap work out of the below-cap path and uses ordered indexes for concurrent eviction", async () => {
    // Use separate organizations for the below-cap and seeded eviction cases.
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const observed = await harness.connect(
      {
        beforeQuery: async (sql, params) => {
          captured.push({ sql, params });
        },
      },
      8,
    );
    await deliver(observed.database, "below-cap", { workspace: "linear-other" });
    const below = captured.splice(0);
    assert.ok(
      !below.some(({ sql }) => /(?:delete from|from) provider_event_receipts/iu.test(sql)),
      "steady-state below-cap delivery queried the receipts for cap work",
    );

    await harness.runtime.query(
      `insert into provider_event_receipts
         (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
       select $1, 'linear', 'cap-' || n, 'linear.agent_session', '{}'::jsonb,
              timestamptz '2026-01-01' + n * interval '1 second', 'unsupported_event'
       from generate_series(1,4999) n
       union all
       select $1, 'linear', 'keep-' || n, 'linear.comment', '{}'::jsonb, timestamptz '2026-01-01', 'trigger_filters_rejected'
       from generate_series(1,20000) n`,
      [seeded],
    );
    await harness.runtime.query("vacuum analyze provider_event_receipts");
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        deliver(observed.database, `cap-new-${index}`, { workspace: "linear-seeded" }),
      ),
    );
    const { rows } = await harness.runtime.query(
      `select count(*) filter (where organization_id = $1 and dropped_reason = 'unsupported_event')::int as retained,
              count(*) filter (where delivery_id like 'cap-new-%')::int as admitted,
              count(*) filter (where delivery_id like 'keep-%')::int as other_drops,
              count(*) filter (where organization_id = $2)::int as other_org,
              count(*) filter (where delivery_id = 'cap-1')::int as oldest
       from provider_event_receipts`,
      [seeded, other],
    );
    assert.deepEqual(rows, [
      { retained: 5000, admitted: 40, other_drops: 20000, other_org: 2, oldest: 0 },
    ]);

    const capQueries = captured.filter(({ sql }) => /from provider_event_receipts/iu.test(sql));
    const check = capQueries.find(({ sql }) => /select count\(/iu.test(sql));
    const evict = capQueries.find(({ sql }) => /delete from/iu.test(sql));
    assert.ok(check && evict);
    for (const entry of [check, evict]) {
      const explanation = await harness.runtime.query<{ "QUERY PLAN": string }>(
        `explain ${entry.sql}`,
        entry.params,
      );
      const plan = explanation.rows.map((row) => row["QUERY PLAN"]).join("\n");
      const file = process.env["HUB_UNSUPPORTED_PLAN_FILE"];
      if (file !== undefined) await appendFile(file, `\n${entry.sql}\n${plan}\n`);
      assert.doesNotMatch(plan, /Sort|Seq Scan on provider_event_receipts/u);
      assert.match(plan, /provider_event_receipts_org_unsupported_linear_idx/u);
    }
  });
});
