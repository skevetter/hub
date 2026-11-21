import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createLinearWebhookSource } from "../triggers/linear/webhook.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organizationId,
  type TimelinePostgresHarness,
} from "./test-utils/run-timeline-postgres.js";
import type { Database, DroppedEventPageRequest } from "./types.js";

const other = "other-receipts";
const receivedAt = new Date("2026-01-02T00:00:00Z");
const old = new Date("2025-12-01T00:00:00Z");
const connectionId = "30000000-0000-4000-8000-000000000001";
const otherConnectionId = "30000000-0000-4000-8000-000000000002";

function slack(owner: string, id: string, teamId: string) {
  return {
    id,
    organizationId: owner,
    teamId,
    slug: teamId,
    teamName: teamId,
    botUserId: "bot",
    botAccessToken: "fixture",
    scopes: [],
    providerApplicationId: null,
  };
}

async function seed(database: Database) {
  for (let index = 0; index < 111; index += 1) {
    const result = await database.acceptSlackEvent({
      teamId: "main",
      deliveryId: `dropped-${index}`,
      source: index % 2 === 0 ? "slack.mention" : "slack.reaction",
      dropReason: index % 3 === 0 ? "trigger_filters_rejected" : "no_project_route",
      receivedAt: index < 3 ? old : receivedAt,
      payload: { private: "PRIVATE-EVENT-BODY" },
    });
    assert.equal(result.status, "dropped");
  }
  await database.acceptSlackEvent({
    teamId: "other",
    deliveryId: "dropped-0",
    source: "slack.mention",
    dropReason: "no_project_route",
    receivedAt,
    payload: {},
  });
}

async function walk(database: Database, limit: number) {
  const read = (position?: DroppedEventPageRequest["position"]) =>
    database.listDroppedEventPage(organizationId, { limit, ...(position ? { position } : {}) });
  let page = await read();
  const pages = [page.records.map(({ id }) => id)];
  assert.equal(page.newer, null);
  assert.equal(page.records.length, limit);
  while (page.older !== null) {
    page = await read({ direction: "before", key: page.older });
    assert.ok(page.newer);
    pages.push(page.records.map(({ id }) => id));
  }
  const all = pages.flat();
  assert.equal(all.length, 111);
  assert.equal(new Set(all).size, all.length);
  for (const expected of pages.slice(0, -1).toReversed()) {
    assert.ok(page.newer);
    page = await read({ direction: "after", key: page.newer });
    assert.deepEqual(
      page.records.map(({ id }) => id),
      expected,
    );
  }
  assert.equal(page.newer, null);
}

async function testFilters(database: Database) {
  const filters = {
    limit: 100,
    provider: "slack",
    source: "slack.mention",
    reason: "trigger_filters_rejected",
    receivedSince: receivedAt,
  } as const;
  const page = await database.listDroppedEventPage(organizationId, filters);
  assert.equal(page.records.length, 18);
  assert.equal(page.records[0]?.workspaceOrRepo, "main");
  assert.ok(
    page.records.every(
      (row) =>
        row.provider === "slack" &&
        row.source === "slack.mention" &&
        row.reason === "trigger_filters_rejected" &&
        row.receivedAt === receivedAt.toISOString(),
    ),
  );
  assert.doesNotMatch(JSON.stringify(page), /PRIVATE|deliveryId|signatureHash|payload/u);
  assert.deepEqual(
    (await database.listDroppedEventPage(organizationId, { ...filters, provider: "linear" }))
      .records,
    [],
  );
  assert.deepEqual(
    (await database.listDroppedEventPage(organizationId, { ...filters, source: "slack.unknown" }))
      .records,
    [],
  );
  assert.equal(
    (await database.listDroppedEventPage(organizationId, { ...filters, reason: "routing" })).records
      .length,
    36,
  );
  assert.equal(
    (await database.listDroppedEventPage(other, { limit: 15 })).records[0]?.workspaceOrRepo,
    "other",
  );
}

describe("memory dropped event pages", () => {
  const database = createMemoryDatabase({
    organizationIds: [organizationId, other],
    slackConnections: [
      slack(organizationId, connectionId, "main"),
      slack(other, otherConnectionId, "other"),
    ],
  });
  beforeAll(() => seed(database));
  it.each([15, 25, 50, 100])("walks both ways through ties at %i rows", (limit) =>
    walk(database, limit),
  );
  it("combines filters and isolates receipt metadata", () => testFilters(database));
  it("resolves a Linear workspace and expires a verified unsupported receipt", async () => {
    const store = createMemoryDatabase({
      organizationIds: [organizationId],
      linearConnections: [
        {
          id: "30000000-0000-4000-8000-000000000011",
          organizationId,
          slug: "memory-linear",
          providerApplicationId: null,
          linearOrganizationId: "linear-memory",
          linearOrganizationName: "Memory workspace",
          appUserId: "app",
          accessToken: "fixture",
          refreshToken: null,
          accessTokenExpiresAt: null,
          scopes: [],
        },
      ],
    });
    const result = await store.acceptLinearEvent({
      linearOrganizationId: "linear-memory",
      deliveryId: "memory-unsupported",
      source: "linear.agent_session",
      payload: { type: "agent_session", action: "created" },
      receivedAt,
      dropReason: "unsupported_event",
    });
    assert.equal(result.status, "dropped");
    const after = new Date(receivedAt.getTime() + 1);
    assert.deepEqual(await store.expireReceiptPayload(result.receiptId, after, after), {
      status: "expired",
    });
    const { records } = await store.listDroppedEventPage(organizationId, {
      limit: 15,
      reason: "unsupported_event",
    });
    assert.equal(records[0]?.workspaceOrRepo, "memory-linear");
  });
});

describe("PostgreSQL dropped event pages", () => {
  let harness: TimelinePostgresHarness;
  beforeAll(async () => {
    harness = await createTimelinePostgresHarness();
    await harness.runtime.query(
      `
      insert into organization (id, name, slug) values ($1, 'Other', 'other-receipts');
    `,
      [other],
    );
    await harness.runtime.query(
      `
      insert into slack_connections
        (id, organization_id, team_id, slug, team_name, bot_user_id, bot_access_token)
      values ($1, $2, 'main', 'main', 'Main', 'bot', 'fixture'),
             ($3, $4, 'other', 'other', 'Other', 'bot', 'fixture')
    `,
      [connectionId, organizationId, otherConnectionId, other],
    );
    await seed(harness.database);
  }, 120_000);
  afterAll(async () => harness?.close());
  it.each([15, 25, 50, 100])("walks both ways through ties at %i rows", (limit) =>
    walk(harness.database, limit),
  );
  it("combines filters and isolates receipt metadata", () => testFilters(harness.database));
  it("keeps 5,000 unsupported Linear receipts per organization and deduplicates signed deliveries", async () => {
    await harness.runtime.query(
      `
      insert into linear_connections
        (id, organization_id, linear_organization_id, slug, linear_organization_name, app_user_id, access_token)
      values ('30000000-0000-4000-8000-000000000011', $1, 'linear-main', 'main-linear', 'Main', 'app', 'fixture'),
             ('30000000-0000-4000-8000-000000000012', $2, 'linear-other', 'other-linear', 'Other', 'app', 'fixture')
    `,
      [organizationId, other],
    );
    const secret = "linear-webhook-test";
    const now = receivedAt.getTime();
    const endpoint = createLinearWebhookSource({
      signingSecret: secret,
      now: () => now,
      accept: (input) => harness.database.acceptLinearEvent(input),
    });
    async function deliver(delivery: string, linearOrganizationId: string, action = "created") {
      const body = JSON.stringify({
        type: "AgentSessionEvent",
        action,
        organizationId: linearOrganizationId,
        webhookTimestamp: now,
        data: { private: "PRIVATE-LINEAR-BODY" },
      });
      const response = await endpoint.handle(
        new Request("https://hub.test/api/integrations/linear/events", {
          method: "POST",
          headers: {
            "linear-delivery": delivery,
            "linear-event": "AgentSessionEvent",
            "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
          },
          body,
        }),
      );
      assert.equal(response.status, 200);
    }
    await deliver("other-unsupported", "linear-other");
    await harness.runtime.query(
      `
      insert into provider_event_receipts
        (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
      select $1, 'linear', 'overflow-' || n, 'linear.agent_session', '{}',
             timestamptz '2026-01-01' + n * interval '1 second', 'unsupported_event'
      from generate_series(1, 4999) n
    `,
      [organizationId],
    );
    await Promise.all([
      deliver("new-unsupported", "linear-main"),
      deliver("another-unsupported", "linear-main", "prompted"),
    ]);
    await deliver("new-unsupported", "linear-main", "revised");
    const { rows } = await harness.runtime.query<{
      count: number;
      oldest: boolean;
      duplicates: number;
      other: number;
      sanitized: boolean;
    }>(
      `
      select count(*) filter (where organization_id = $1)::int as count,
             bool_or(delivery_id = 'overflow-1') as oldest,
             count(*) filter (where delivery_id = 'new-unsupported')::int as duplicates,
             count(*) filter (where organization_id = $2)::int as other,
             bool_or(delivery_id = 'new-unsupported' and payload = '{"type":"agent_session","action":"created"}') as sanitized
      from provider_event_receipts where dropped_reason = 'unsupported_event'
    `,
      [organizationId, other],
    );
    assert.deepEqual(rows, [
      { count: 5000, oldest: false, duplicates: 1, other: 1, sanitized: true },
    ]);
    const [linear] = (
      await harness.database.listDroppedEventPage(organizationId, {
        limit: 15,
        provider: "linear",
        reason: "unsupported_event",
      })
    ).records;
    assert.equal(linear?.workspaceOrRepo, "main-linear");
    assert.ok(linear);
    const after = new Date(now + 1);
    assert.deepEqual(await harness.database.expireReceiptPayload(linear.id, after, after), {
      status: "expired",
    });
    const expired = await harness.database.findProviderEventReplayMetadata(organizationId, {
      id: linear.id,
    });
    assert.equal(expired?.payloadExpiryState, "expired");
  });
  it("uses an ordered index for newest and cursor pages at 27,000 receipts", async () => {
    await harness.runtime.query(
      `
      insert into provider_event_receipts
        (id, organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
      select md5('plan-' || n)::uuid,
             case when n % 9 = 0 then $2 else $1 end,
             'linear', 'plan-' || n, 'linear.comment', '{}',
             timestamptz '2026-06-01' + (n / 12) * interval '1 second',
             case when n % 3 = 1 then null else 'trigger_filters_rejected' end
      from generate_series(1, 27000) n
    `,
      [organizationId, other],
    );
    await harness.runtime.query("analyze provider_event_receipts");
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const connection = await harness.connect();
    const query = connection.runtime.query.bind(connection.runtime);
    connection.runtime.query = (sql, params) => {
      captured.push({ sql, params: params ?? [] });
      return query(sql, params);
    };
    const read = (filters: Omit<DroppedEventPageRequest, "limit"> = {}) =>
      connection.database.listDroppedEventPage(organizationId, { limit: 15, ...filters });

    const first = await read();
    assert.ok(first.older);
    const second = await read({ position: { direction: "before", key: first.older } });
    assert.ok(second.older && second.newer);
    await read({ position: { direction: "before", key: second.older } });
    await read({ position: { direction: "after", key: second.newer } });
    const deep = await harness.runtime.query<{ createdAt: string; id: string }>(
      `select received_at::text as "createdAt", id from provider_event_receipts
       where organization_id = $1 and dropped_reason is not null
       order by received_at desc, id desc offset 10000 limit 1`,
      [organizationId],
    );
    const deepKey = deep.rows[0];
    assert.ok(deepKey);
    await read({ position: { direction: "before", key: deepKey } });
    await read({
      provider: "linear",
      source: "linear.comment",
      reason: "trigger_filters_rejected",
      receivedSince: new Date("2026-06-01T00:03:00Z"),
    });
    await read({ provider: "linear", source: "linear.unseen" });
    await read({ provider: "linear" });
    const emptyProviderQuery = captured.length;
    assert.deepEqual((await read({ provider: "github" })).records, []);
    await read({ reason: "configuration_unavailable" });
    await read({ reason: "routing" });
    await read({ reason: "other" });
    const counts = await connection.database.countRecentDroppedEvents(
      organizationId,
      new Date("2026-06-01"),
    );
    assert.deepEqual(counts, [
      { provider: "linear", reason: "trigger_filters_rejected", count: 2500 },
    ]);
    assert.equal(captured.length, 17);

    const plans: string[] = [];
    for (const [index, { sql, params }] of captured.entries()) {
      const { rows } = await harness.runtime.query<{ "QUERY PLAN": string }>(
        `explain (analyze, buffers) ${sql}`,
        params,
      );
      const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
      const file = process.env["HUB_DROPPED_PLAN_FILE"];
      if (file !== undefined) await appendFile(file, `\nStatement ${index + 1}\n${sql}\n${plan}\n`);
      plans.push(plan);
    }
    for (const [index, plan] of plans.entries()) {
      assert.doesNotMatch(plan, /Incremental Sort|Seq Scan on provider_event_receipts/u);
      if (index === emptyProviderQuery && plan.includes("Sort Key")) {
        // PostgreSQL may choose the older provider index and sort its empty result.
        assert.match(plan, /Sort .*actual time=[^\n]*rows=0 loops=1/u);
        assert.match(plan, /Index Scan using provider_event_receipts_resource_idx/u);
        assert.doesNotMatch(plan, /Rows Removed by Filter/u);
        continue;
      }
      assert.doesNotMatch(plan, /Sort Key/u);
      assert.match(
        plan,
        /provider_event_receipts_org_dropped_(order|source|provider|reason|routing|other)_idx/u,
      );
    }
  });
});
