import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { EXPIRED_CURSOR_DIAGNOSTIC } from "../run-payload-retention/auxiliary-receipt-proof.js";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase } from "./pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type QueryHandle,
} from "./runtime/index.js";
import { drainReceiptSweep } from "./test-utils/receipt-expiry.js";
import { CUTOFF, NOW, OLD } from "./test-utils/receipt-proof-fixture.js";
import { createTimelinePostgresHarness } from "./test-utils/run-timeline-postgres.js";
import type { Database, GitHubConnectionRecord } from "./types.js";

const organizationId = "receipt-auxiliary";
const owner = { providerApplicationId: "fixture-app", configurationVersion: 3 };
const identity = {
  accountId: "account",
  accountLogin: "owner",
  accountType: "Organization",
  status: "active",
} as const;
const syncCutoff = new Date("2080-01-02T00:00:00Z");
const syncExpiry = new Date("2080-02-01T00:00:00Z");

function binding(installationId: number): GitHubConnectionRecord {
  return {
    ...identity,
    id: randomUUID(),
    organizationId,
    providerApplicationId: owner.providerApplicationId,
    slug: "github-" + String(installationId),
    installationId,
  };
}

function delivery(installationId: number, key: string) {
  return {
    providerApplicationId: owner.providerApplicationId,
    installationId,
    source: "github.installation",
    deliveryId: "lifecycle-" + key,
    signatureHash: "signature-" + key,
    payload: { original: "lifecycle-" + key + "-body-marker" },
    receivedAt: OLD,
  };
}

async function seedOwner(runtime: QueryHandle, bindings: readonly GitHubConnectionRecord[]) {
  await runtime.query(
    "insert into organization (id, name, slug) values ($1,'Receipt auxiliary','auxiliary')",
    [organizationId],
  );
  await runtime.query(
    "insert into runtime_provider_activation(provider, provider_application_id, configuration_version) values ('github',$1,$2)",
    [owner.providerApplicationId, owner.configurationVersion],
  );
  for (const connection of bindings) {
    await runtime.query(
      `insert into github_connections (id, provider_application_id, organization_id, installation_id,
          slug, account_id, account_login, account_type, status)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        connection.id,
        connection.providerApplicationId,
        connection.organizationId,
        connection.installationId,
        connection.slug,
        connection.accountId,
        connection.accountLogin,
        connection.accountType,
        connection.status,
      ],
    );
  }
}

async function verifyPair(database: Database) {
  const input = delivery(41, "settled");
  const pending = delivery(42, "pending");
  const copyFree = delivery(99, "copy-free");
  const claim = await database.claimGitHubLifecycleReceipt(input);
  const unresolved = await database.claimGitHubLifecycleReceipt(pending);
  const unbound = await database.claimGitHubLifecycleReceipt(copyFree);
  assert.equal(claim.status, "claimed");
  assert.equal(unresolved.status, "claimed");
  assert.equal(unbound.status, "claimed");
  const copy = await database.findProviderEventReceiptByDeliveryId(
    input.deliveryId,
    organizationId,
  );
  assert.ok(copy);
  await database.applyGitHubInstallationSync(
    { ...owner, configurationVersion: owner.configurationVersion + 1 },
    claim,
    { status: "absent", removeBinding: true },
  );
  assert.ok(await database.findGitHubConnection(41));
  assert.deepEqual(
    await database.expireGitHubSyncPayload(claim.installationSyncId, syncCutoff, syncExpiry),
    {
      status: "skipped",
      disposition: "sync_pending",
    },
  );
  await database.applyGitHubInstallationSync(owner, claim, {
    status: "absent",
    removeBinding: true,
  });
  assert.equal(await database.findGitHubConnection(41), undefined);
  await database.applyGitHubInstallationSync(owner, unbound, {
    status: "absent",
    removeBinding: false,
  });

  const scan = await database.scanGitHubSyncPayloads(null, syncCutoff, 10);
  assert.equal(scan.length, 3);
  for (const [work, disposition, hasCopy] of [
    [claim, "eligible", true],
    [unresolved, "sync_pending", true],
    [unbound, "eligible", false],
  ] as const) {
    assert.deepEqual(
      scan.find(({ id }) => id === work.installationSyncId)?.disposition,
      disposition,
    );
    assert.equal(
      scan.find(({ id }) => id === work.installationSyncId)?.receiptCopyAgeFrom?.getTime(),
      hasCopy ? OLD.getTime() : undefined,
    );
  }
  const firstReceiptPage = await database.scanReceiptPayloads(null, syncCutoff, 1);
  assert.deepEqual(firstReceiptPage.candidates, []);
  assert.ok(firstReceiptPage.nextCursor);
  const nextReceiptPage = await database.scanReceiptPayloads(
    firstReceiptPage.nextCursor,
    syncCutoff,
    1,
  );
  assert.deepEqual(nextReceiptPage.candidates, []);
  assert.ok(nextReceiptPage.nextCursor && nextReceiptPage.nextCursor > firstReceiptPage.nextCursor);
  assert.deepEqual(await database.scanReceiptPayloads(nextReceiptPage.nextCursor, syncCutoff, 1), {
    candidates: [],
    nextCursor: null,
  });
  assert.deepEqual(await database.expireReceiptPayload(copy.id, syncCutoff, syncExpiry), {
    status: "skipped",
    disposition: "lifecycle_pending",
  });
  const applied = await drainReceiptSweep(database, syncExpiry);
  assert.deepEqual(applied.receiptApply.installationSync, {
    applied: 2,
    locked: 0,
    changedOrMissing: 0,
  });
  assert.deepEqual(applied.receiptApply.lifecycleAuditCopy, {
    applied: 1,
    locked: 0,
    changedOrMissing: 0,
  });
  assert.equal(applied.receiptApply.receipt.applied, 0);
  assert.equal(applied.receiptCounts.installationSyncs.eligible_pair?.count, 1);
  assert.equal(applied.receiptCounts.installationSyncs.eligible_copy_free?.count, 1);
  assert.equal(applied.receiptCounts.installationSyncs.sync_pending?.count, 1);
  assert.deepEqual(applied.receiptCounts.lifecycleAuditCopies.eligible_pair, {
    count: 1,
    oldestAgeMs: syncExpiry.getTime() - OLD.getTime(),
  });
  const markedCopy = await database.findProviderEventReceiptById(copy.id);
  assert.equal(markedCopy?.payloadExpiryState, "expired");
  assert.equal(markedCopy?.signatureHash, input.signatureHash);
  assert.equal(markedCopy?.payload, null);
  assert.deepEqual(
    await database.claimGitHubLifecycleReceipt({ ...input, deliveryId: "changed-header" }),
    {
      status: "duplicate",
      installationSyncId: claim.installationSyncId,
    },
  );
  await database.retryGitHubInstallationSync(owner, claim.installationSyncId);
  await database.applyGitHubInstallationSync(owner, claim, {
    status: "present",
    identity,
    repositories: [],
  });
  assert.equal(await database.findGitHubConnection(41), undefined);
  assert.equal(
    (await database.findProviderEventReceiptById(copy.id))?.payloadExpiryState,
    "expired",
  );
  assert.deepEqual(
    await database.expireGitHubSyncPayload(claim.installationSyncId, syncCutoff, syncExpiry),
    {
      status: "skipped",
      disposition: "changed_or_missing",
    },
  );
  return { claim, copy, unbound, unresolved };
}

async function verifyDiagnostic(database: Database, runtime?: QueryHandle) {
  const cursor = { lastModified: "cursor-tag", since: OLD, nextPollAt: NOW };
  await database.githubNotifications.saveCursor(cursor, OLD);
  await database.githubNotifications.recordFailure(OLD, "diagnostic-old-body-marker");
  assert.deepEqual(await database.scanGitHubCursorDiagnostics(null, CUTOFF, 10), [
    { source: "notifications", ageFrom: OLD, disposition: "eligible" },
  ]);
  const readRaw = () =>
    runtime?.query<{ row: object }>(
      "select to_jsonb(cursor) - 'last_error' - 'diagnostic_expired_at' as row from github_notification_cursors cursor",
    );
  const before = await readRaw();
  const count = await drainReceiptSweep(database, NOW, "count");
  assert.deepEqual(count.receiptCounts.cursorDiagnostics, {
    eligible: { count: 1, oldestAgeMs: NOW.getTime() - OLD.getTime() },
  });
  const applied = await drainReceiptSweep(database, NOW);
  assert.deepEqual(applied.receiptCounts.cursorDiagnostics, count.receiptCounts.cursorDiagnostics);
  assert.equal(applied.receiptApply.cursorDiagnostic.applied, 1);
  assert.deepEqual(await readRaw(), before);
  assert.equal(
    (await database.githubNotifications.readStatus()).lastError,
    EXPIRED_CURSOR_DIAGNOSTIC,
  );
  assert.equal(
    (await database.githubNotifications.readStatus()).lastErrorAt?.getTime(),
    OLD.getTime(),
  );
  assert.deepEqual(await database.scanGitHubCursorDiagnostics(null, CUTOFF, 10), [
    { source: "notifications", ageFrom: OLD, disposition: "already_reduced" },
  ]);
  await database.githubNotifications.recordFailure(CUTOFF, "diagnostic-recent-body-marker");
  assert.deepEqual(await database.expireGitHubCursorDiagnostic("notifications", CUTOFF, NOW), {
    status: "skipped",
    disposition: "not_old_enough",
  });
  assert.equal(
    (await database.githubNotifications.readStatus()).lastError,
    "diagnostic-recent-body-marker",
  );
}

describe("auxiliary receipt expiry", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it("settles the exact lifecycle pair in native PostgreSQL and preserves blocked bodies in the dump", async () => {
    const url = new URL(postgres.getConnectionUri());
    url.pathname = "/receipt_auxiliary";
    const { runtime, locks } = await postgresDatabaseRuntime(url.href);
    try {
      await runtime.migrate();
      const bindings = [binding(41), binding(42), binding(43)];
      await seedOwner(runtime, bindings);
      const database = createDatabase(runtime, locks);
      const { claim, copy, unbound } = await verifyPair(database);
      const read = (id: string) =>
        runtime.query<{
          payload: object;
          settled_at: Date;
          payload_expired_at: Date;
          audit_link: unknown;
          retry_at: Date | null;
        }>(
          "select payload, settled_at, payload_expired_at, audit_link, retry_at from github_installation_syncs where id = $1",
          [id],
        );
      const [linked] = (await read(claim.installationSyncId)).rows;
      const [alone] = (await read(unbound.installationSyncId)).rows;
      assert.ok(linked && alone);
      assert.deepEqual(linked.audit_link, { kind: "receipt", receiptId: copy.id, organizationId });
      assert.deepEqual(alone.audit_link, { kind: "none" });
      for (const state of [linked, alone]) {
        assert.deepEqual(state.payload, {});
        assert.ok(state.settled_at < syncCutoff);
        assert.deepEqual(state.payload_expired_at, syncExpiry);
        assert.equal(state.retry_at, null);
      }

      const historical = await database.claimGitHubLifecycleReceipt(delivery(42, "historical"));
      assert.equal(historical.status, "claimed");
      await runtime.query("update github_installation_syncs set retry_at = null where id = $1", [
        historical.installationSyncId,
      ]);
      assert.deepEqual(
        await database.expireGitHubSyncPayload(
          historical.installationSyncId,
          syncCutoff,
          syncExpiry,
        ),
        {
          status: "skipped",
          disposition: "historical_settlement_unknown",
        },
      );
      const aborted = await database.claimGitHubLifecycleReceipt(delivery(43, "aborted"));
      assert.equal(aborted.status, "claimed");
      await runtime.query("delete from github_connections where installation_id = 43");
      await database.applyGitHubInstallationSync(owner, aborted, {
        status: "absent",
        removeBinding: true,
      });
      assert.deepEqual(
        await database.expireGitHubSyncPayload(aborted.installationSyncId, syncCutoff, syncExpiry),
        {
          status: "skipped",
          disposition: "historical_settlement_unknown",
        },
      );

      const collision = delivery(42, "collision");
      await runtime.query(
        `insert into provider_event_receipts(organization_id, provider, delivery_id, signature_hash, source, payload, received_at)
          values($1,'github',$2,$3,'github.issues',$4,$5)`,
        [organizationId, collision.deliveryId, collision.signatureHash, collision.payload, OLD],
      );
      const collided = await database.claimGitHubLifecycleReceipt(collision);
      assert.equal(collided.status, "claimed");
      await database.applyGitHubInstallationSync(owner, collided, {
        status: "present",
        identity,
        repositories: [],
      });
      assert.deepEqual(
        await database.expireGitHubSyncPayload(collided.installationSyncId, syncCutoff, syncExpiry),
        {
          status: "skipped",
          disposition: "audit_link_unproven",
        },
      );

      const referenced = delivery(42, "capability");
      const withCapability = await database.claimGitHubLifecycleReceipt(referenced);
      assert.equal(withCapability.status, "claimed");
      await database.applyGitHubInstallationSync(owner, withCapability, {
        status: "present",
        identity,
        repositories: [],
      });
      const affected = await database.findProviderEventReceiptByDeliveryId(
        referenced.deliveryId,
        organizationId,
      );
      assert.ok(affected);
      await runtime.query(
        `insert into attachment_capabilities(provider_event_receipt_id,organization_id,connection_id,provider,source_id,locator,filename)
          values($1,$2,$3,'slack','fixture','{}','fixture.txt')`,
        [affected.id, organizationId, bindings[1]?.id],
      );
      assert.deepEqual(
        await database.expireGitHubSyncPayload(
          withCapability.installationSyncId,
          syncCutoff,
          syncExpiry,
        ),
        {
          status: "skipped",
          disposition: "unexpected_references",
        },
      );
      await verifyDiagnostic(database, runtime);
      await runtime.query(
        "update github_notification_cursors set last_error_at = null where source = 'notifications'",
      );
      assert.deepEqual(await database.expireGitHubCursorDiagnostic("notifications", CUTOFF, NOW), {
        status: "skipped",
        disposition: "missing_error_timestamp",
      });
      const dump = await postgres.exec([
        "pg_dump",
        "--data-only",
        "-U",
        url.username,
        "-d",
        url.pathname.slice(1),
      ]);
      assert.equal(dump.exitCode, 0);
      for (const key of ["settled", "copy-free"]) {
        assert.equal(dump.output.includes("lifecycle-" + key + "-body-marker"), false);
        assert.ok(dump.output.includes("signature-" + key));
      }
      for (const key of ["pending", "historical", "aborted", "collision", "capability"]) {
        assert.ok(dump.output.includes("lifecycle-" + key + "-body-marker"), key);
      }
      assert.equal(dump.output.includes("diagnostic-old-body-marker"), false);
      assert.ok(dump.output.includes("diagnostic-recent-body-marker"));
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("settles the same pair and resets diagnostics in embedded PostgreSQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "receipt-auxiliary-"));
    const { runtime, locks } = await embeddedDatabaseRuntime(root);
    try {
      await runtime.migrate();
      await seedOwner(runtime, [binding(41), binding(42)]);
      const database = createDatabase(runtime, locks);
      await verifyPair(database);
      await verifyDiagnostic(database, runtime);
      await database.githubNotifications.recordSuccess(NOW);
      assert.deepEqual(await database.scanGitHubCursorDiagnostics(null, CUTOFF, 10), []);
    } finally {
      await runtime.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);

  it("settles and redacts the pair and diagnostics atomically in memory", async () => {
    const database = createMemoryDatabase({
      organizationIds: [organizationId],
      githubConnections: [binding(41), binding(42)],
      githubSyncOwner: owner,
    });
    await verifyPair(database);
    await verifyDiagnostic(database);
    await database.githubNotifications.recordSuccess(NOW);
    assert.deepEqual(await database.scanGitHubCursorDiagnostics(null, CUTOFF, 10), []);
  });
});

it.each(["success", "failure"] as const)(
  "lets a concurrent cursor %s win against diagnostic expiry in both orders",
  async (transition) => {
    const harness = await createTimelinePostgresHarness();
    try {
      await harness.database.githubNotifications.saveCursor(
        { lastModified: "tag", since: OLD, nextPollAt: NOW },
        OLD,
      );
      const change = (database: Database) =>
        transition === "success"
          ? database.githubNotifications.recordSuccess(NOW)
          : database.githubNotifications.recordFailure(NOW, "replacement-diagnostic");
      for (const expiryFirst of [true, false]) {
        await harness.database.githubNotifications.recordFailure(OLD, "old-stale-diagnostic");
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const first = await harness.connect({
          async afterQuery(sql) {
            if (
              expiryFirst &&
              sql.includes("for update skip locked") &&
              sql.includes("github_notification_cursors")
            ) {
              held.resolve();
              await release.promise;
            }
          },
        });
        const second = await harness.connect();
        if (expiryFirst) {
          const expiring = first.database.expireGitHubCursorDiagnostic(
            "notifications",
            CUTOFF,
            NOW,
          );
          await Promise.race([held.promise, expiring.then(() => assert.fail("no cursor barrier"))]);
          const updating = change(second.database);
          try {
            assert.equal(await harness.waitForLockOrRead(second.pid), "blocked");
          } finally {
            release.resolve();
            await Promise.all([expiring, updating]);
          }
        } else {
          await first.runtime.query("begin");
          try {
            await change(first.database);
            assert.deepEqual(
              await second.database.expireGitHubCursorDiagnostic("notifications", CUTOFF, NOW),
              {
                status: "skipped",
                disposition: "locked",
              },
            );
          } finally {
            await first.runtime.query("commit");
          }
        }
        const status = await harness.database.githubNotifications.readStatus();
        assert.equal(status.lastError, transition === "success" ? null : "replacement-diagnostic");
        assert.equal(
          (
            await harness.runtime.query<{ marker: Date | null }>(
              "select diagnostic_expired_at as marker from github_notification_cursors",
            )
          ).rows[0]?.marker,
          null,
        );
      }
    } finally {
      await harness.close();
    }
  },
  120_000,
);

it("uses sync-before-receipt ordering and commits both lifecycle markers together", async () => {
  const harness = await createTimelinePostgresHarness();
  try {
    const connection = binding(48);
    await seedOwner(harness.runtime, [connection]);
    const input = delivery(48, "lock-pair");
    const claim = await harness.database.claimGitHubLifecycleReceipt(input);
    assert.equal(claim.status, "claimed");
    const copy = await harness.database.findProviderEventReceiptByDeliveryId(
      input.deliveryId,
      organizationId,
    );
    assert.ok(copy);
    const first = await harness.connect();
    const applying = await harness.connect();
    await first.runtime.query("begin");
    let apply: Promise<void> | undefined;
    try {
      await first.runtime.query("select id from github_connections where id = $1 for update", [
        connection.id,
      ]);
      apply = applying.database.applyGitHubInstallationSync(owner, claim, {
        status: "present",
        identity,
        repositories: [],
      });
      assert.equal(await harness.waitForLockOrRead(applying.pid), "blocked");
      assert.deepEqual(
        await harness.database.expireGitHubSyncPayload(
          claim.installationSyncId,
          syncCutoff,
          syncExpiry,
        ),
        {
          status: "skipped",
          disposition: "locked",
        },
      );
    } finally {
      await first.runtime.query("commit");
      await apply;
    }

    const markedCopy = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const expiring = await harness.connect({
      async afterQuery(sql) {
        if (!sql.includes("update provider_event_receipts")) return;
        markedCopy.resolve();
        await release.promise;
      },
    });
    const operation = expiring.database.expireGitHubSyncPayload(
      claim.installationSyncId,
      syncCutoff,
      syncExpiry,
    );
    await Promise.race([
      markedCopy.promise,
      operation.then(() => assert.fail("no lifecycle staging barrier")),
    ]);
    const checking = harness.database.claimGitHubLifecycleReceipt({
      ...input,
      deliveryId: "changed-header-pair",
    });
    try {
      assert.equal(
        (await harness.database.findProviderEventReceiptById(copy.id))?.payloadExpiryState,
        null,
      );
      assert.equal(
        (
          await harness.runtime.query<{ marker: Date | null }>(
            "select payload_expired_at as marker from github_installation_syncs where id = $1",
            [claim.installationSyncId],
          )
        ).rows[0]?.marker,
        null,
      );
    } finally {
      release.resolve();
      await Promise.all([operation, checking]);
    }
    assert.deepEqual(await checking, {
      status: "duplicate",
      installationSyncId: claim.installationSyncId,
    });
    assert.deepEqual(await operation, { status: "expired", receiptCopy: true });
    assert.equal(
      (await harness.database.findProviderEventReceiptById(copy.id))?.payloadExpiryState,
      "expired",
    );
    assert.deepEqual(
      (
        await harness.runtime.query<{ marker: Date | null }>(
          "select payload_expired_at as marker from github_installation_syncs where id = $1",
          [claim.installationSyncId],
        )
      ).rows[0]?.marker,
      syncExpiry,
    );
  } finally {
    await harness.close();
  }
}, 120_000);
