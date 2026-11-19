import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { drainReceiptSweep } from "../../db/test-utils/receipt-expiry.js";
import { NOW, OLD } from "../../db/test-utils/receipt-proof-fixture.js";
import {
  TIMELINE_ORGANIZATION as organizationId,
  createTimelinePostgresHarness,
} from "../../db/test-utils/run-timeline-postgres.js";
import { createGitHubLifecycle } from "./lifecycle.js";

it("skips a selected GitHub sync that settles and expires before it obtains the installation lock", async () => {
  const harness = await createTimelinePostgresHarness();
  const { database, runtime } = harness;
  const seenPending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = { providerApplicationId: "fixture-app", configurationVersion: 1 };
  const event = {
    installationId: 42,
    deliveryId: "fixture-lifecycle-delivery",
    signatureHash: "fixture-lifecycle-signature",
    source: "github.installation",
    payload: { body: "fixture-lifecycle-body" },
    receivedAt: OLD,
  };
  const getInstallation = vi.fn(async () => ({ status: "absent" as const }));
  const lifecycle = createGitHubLifecycle(
    database,
    { getInstallation },
    {
      listInstallationRepositories: async () => assert.fail("unexpected repository request"),
    },
    owner,
  );
  try {
    await runtime.query(
      `insert into github_connections
        (organization_id, installation_id, slug, account_id, account_login, account_type, status, provider_application_id)
       values ($1, $2, 'github', 'account', 'acme', 'Organization', 'active', $3)`,
      [organizationId, event.installationId, owner.providerApplicationId],
    );
    await runtime.query(
      `insert into runtime_provider_activation(provider, provider_application_id, configuration_version)
       values ('github', $1, $2)`,
      [owner.providerApplicationId, owner.configurationVersion],
    );
    const listPending = database.pendingGitHubInstallationSyncs.bind(database);
    vi.spyOn(database, "pendingGitHubInstallationSyncs").mockImplementation(async (...args) => {
      const pending = await listPending(...args);
      if (args[1] === undefined && pending.length > 0) {
        seenPending.resolve();
        await release.promise;
      }
      return pending;
    });
    const other = await harness.connect();
    await lifecycle.accept(event);
    await seenPending.promise;
    const [claim] = await other.database.pendingGitHubInstallationSyncs(owner);
    assert.ok(claim);
    await database.synchronizeGitHubInstallation(event.installationId, () =>
      other.database.applyGitHubInstallationSync(owner, claim, {
        status: "absent",
        removeBinding: false,
      }),
    );
    await other.runtime.query(
      "update github_installation_syncs set settled_at = $1 where id = $2",
      [OLD, claim.installationSyncId],
    );
    const report = await drainReceiptSweep(other.database, NOW);
    assert.equal(report.receiptApply.installationSync.applied, 1);
    assert.equal(report.receiptApply.lifecycleAuditCopy.applied, 1);
    const receipt = await other.database.findProviderEventReceiptByDeliveryId(
      event.deliveryId,
      organizationId,
    );
    assert.equal(receipt?.payloadExpiryState, "expired");
    await lifecycle.accept(event);
    release.resolve();
    await lifecycle.stop();
    assert.equal(getInstallation.mock.calls.length, 0);
    assert.deepEqual(await listPending(owner), []);
  } finally {
    release.resolve();
    await lifecycle.stop();
    await harness.close();
  }
}, 120_000);
