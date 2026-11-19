import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase } from "./pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type QueryHandle,
} from "./runtime/index.js";
import {
  CONNECTION_ID,
  CUTOFF,
  MATRIX_ORG,
  NOW,
  seedProofMatrix,
} from "./test-utils/receipt-proof-fixture.js";
import type { Database } from "./types.js";

async function hashTables(runtime: QueryHandle) {
  const tables = await runtime.query<{ schema: string; name: string }>(
    `select schemaname as schema, tablename as name from pg_tables
       where schemaname in ('public', 'drizzle') order by schemaname, tablename`,
  );
  const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  const hashes: string[] = [];
  for (const table of tables.rows) {
    const row = (
      await runtime.query<{ hash: string }>(
        `select md5(coalesce(string_agg(row::text, '' order by row::text), '')) as hash
         from ${identifier(table.schema)}.${identifier(table.name)} row`,
      )
    ).rows[0];
    assert.ok(row);
    hashes.push(row.hash);
  }
  return hashes;
}

async function verifyMatrix(database: Database, runtime?: QueryHandle) {
  await runtime?.query(
    `insert into github_connections
        (id,organization_id,installation_id,slug,account_id,account_login,account_type,status)
      values($1,$2,1,'test','account','owner','Organization','active')`,
    [CONNECTION_ID, MATRIX_ORG],
  );
  const cases = await seedProofMatrix(database, runtime);
  const before = runtime === undefined ? undefined : await hashTables(runtime);
  const candidates = [];
  let after: string | null = null;
  do {
    const page = await database.scanReceiptPayloads(after, CUTOFF, 5);
    candidates.push(...page);
    after = page.at(-1)?.id ?? null;
  } while (after !== null);
  assert.equal(candidates.length, cases.length);
  if (runtime !== undefined) assert.deepEqual(await hashTables(runtime), before);
  for (const fixture of cases) {
    assert.equal(
      candidates.find(({ id }) => id === fixture.id)?.disposition,
      fixture.disposition,
      fixture.key,
    );
    await verifyApplied(database, fixture);
  }
  assert.deepEqual(await database.scanReceiptPayloads(null, CUTOFF, 5, "expiring"), []);
  return cases;
}

async function verifyApplied(
  database: Database,
  fixture: Awaited<ReturnType<typeof seedProofMatrix>>[number],
) {
  const applied = await database.expireReceiptPayload(fixture.id, CUTOFF, NOW);
  if (fixture.disposition === "eligible") {
    assert.deepEqual(applied, { status: "expired" }, fixture.key);
    assert.deepEqual(await database.expireReceiptPayload(fixture.id, CUTOFF, NOW), {
      status: "skipped",
      disposition: "locked_or_missing",
    });
  } else {
    assert.deepEqual(applied, { status: "skipped", disposition: fixture.disposition }, fixture.key);
  }
  const byId = await database.findProviderEventReceiptById(fixture.id);
  const byDelivery = await database.findProviderEventReceiptByDeliveryId(
    fixture.deliveryId,
    MATRIX_ORG,
  );
  assert.equal(byId?.id, byDelivery?.id, fixture.key);
  assert.equal(byId?.signatureHash, fixture.signatureHash);
  assert.equal(byId?.payloadExpiryState, fixture.disposition === "eligible" ? "expired" : null);
  if (fixture.disposition === "eligible") {
    assert.equal(byId?.payload, null);
    assert.equal(byId.acceptedRoutes, null);
    assert.equal(byId.preRoutingDrop, null);
    if (fixture.key === "signed") {
      assert.equal(byId.manualReplayBinding?.triggerName, "target");
      assert.equal(
        byId.manualReplayBinding?.configurationRevisionId,
        fixture.route.configurationRevisionId,
      );
      assert.ok(byId.manualReplayBinding?.triggerId);
    }
  } else {
    assert.match(JSON.stringify(byId?.payload), new RegExp(fixture.marker, "u"));
  }
  const runs = await database.findTriggerRunsByProviderEventReceiptId(fixture.id);
  assert.deepEqual(runs.map(({ id }) => id).sort(), fixture.runs.sort());
}

describe("receipt shape proof and expiry", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => postgres?.stop(), 120_000);

  it("uses the same count and apply proof in PostgreSQL and removes only eligible dump markers", async () => {
    const url = new URL(postgres.getConnectionUri());
    url.pathname = "/receipt_proof";
    const { runtime, locks } = await postgresDatabaseRuntime(url.href);
    try {
      await runtime.migrate();
      await runtime.query(
        "insert into organization (id, name, slug) values ($1, 'Proof', 'proof')",
        [MATRIX_ORG],
      );
      const database = createDatabase(runtime, locks);
      const cases = await verifyMatrix(database, runtime);
      const dump = await postgres.exec([
        "pg_dump",
        "--data-only",
        "--no-owner",
        "-U",
        url.username,
        "-d",
        url.pathname.slice(1),
      ]);
      assert.equal(dump.exitCode, 0);
      for (const fixture of cases) {
        assert.equal(
          dump.output.includes(fixture.marker),
          fixture.disposition !== "eligible",
          fixture.key,
        );
        assert.ok(dump.output.includes(fixture.deliveryId), fixture.key);
        if (fixture.signatureHash !== null) assert.ok(dump.output.includes(fixture.signatureHash));
      }
      await assert.rejects(
        runtime.query(
          `insert into provider_event_receipts
           (organization_id, provider, delivery_id, source, payload)
         values ($1, 'manual', 'manual', 'manual.run', '{}')`,
          [MATRIX_ORG],
        ),
        /provider_event_receipts_organization_delivery_unique/u,
      );
      await assert.rejects(
        runtime.query(
          `insert into provider_event_receipts
           (organization_id, provider, delivery_id, signature_hash, source, payload)
         values ($1, 'github', $2, 'signature-github-accepted', 'github.issues', '{}')`,
          [MATRIX_ORG, randomUUID()],
        ),
        /provider_event_receipts_signature_unique/u,
      );
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("uses the same proof and redaction in embedded PostgreSQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "receipt-proof-"));
    const { runtime, locks } = await embeddedDatabaseRuntime(root);
    try {
      await runtime.migrate();
      await runtime.query(
        "insert into organization (id, name, slug) values ($1, 'Proof', 'proof')",
        [MATRIX_ORG],
      );
      await verifyMatrix(createDatabase(runtime, locks), runtime);
    } finally {
      await runtime.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);

  it("uses the same exact branch and age proof in memory", async () => {
    await verifyMatrix(
      createMemoryDatabase({
        organizationIds: [MATRIX_ORG],
        githubConnections: [
          {
            id: CONNECTION_ID,
            organizationId: MATRIX_ORG,
            providerApplicationId: null,
            slug: "test",
            installationId: 1,
            accountId: "account",
            accountLogin: "owner",
            accountType: "Organization",
            status: "active",
          },
        ],
      }),
    );
  });
});
