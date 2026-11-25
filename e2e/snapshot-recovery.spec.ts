import { test } from "./app.js";
import { SnapshotRecovery } from "./helpers/snapshot-recovery.js";

const owner = {
  name: "Snapshot Owner",
  email: "snapshot@example.test",
  password: "snapshot-password-123",
};

test.beforeEach(async ({ hub }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Snapshot test");
});

test("keeps a loaded trigger table and automatically recovers a failed background read", async ({
  hub,
  page,
}) => {
  const snapshot = new SnapshotRecovery(page, hub.primaryApplication());
  await snapshot.seedTrigger();
  await snapshot.openTriggers();
  const baseline = snapshot.failureCount("triggers");
  await snapshot.interruptTriggers();
  await snapshot.returnToTab();
  await snapshot.expectFailures(1, "triggers", baseline);
  await snapshot.expectTrigger();
  await snapshot.capture("background-failure");
  await snapshot.restoreTriggers();
  await snapshot.renameTrigger();
  await snapshot.expectTrigger("Updated trigger");
  await snapshot.capture("recovered-without-reload");
});

test("bounds trigger retries and retains the trigger table and organization during a failed tenant refresh", async ({
  hub,
  page,
}) => {
  const snapshot = new SnapshotRecovery(page, hub.primaryApplication());
  await snapshot.seedTrigger();
  await snapshot.watchTenant();
  await snapshot.openTriggers();
  await snapshot.expectOrganization("Snapshot test");
  const triggerBaseline = snapshot.failureCount("triggers");
  await snapshot.interruptTriggers();
  await snapshot.returnToTab();
  await snapshot.expectTriggerRetriesStopped(triggerBaseline);
  await snapshot.expectTrigger();
  await snapshot.restoreTriggers();
  const tenantBaseline = snapshot.failureCount("tenant");
  await snapshot.interruptTenant();
  await snapshot.returnToTab();
  await snapshot.expectFailures(3, "tenant", tenantBaseline);
  await snapshot.expectOrganization("Snapshot test");
  await snapshot.expectTrigger();
  await snapshot.renameOrganization();
  await snapshot.renameTrigger();
  await snapshot.restoreTenant();
  await snapshot.returnToTab();
  await snapshot.expectOrganization("Updated organization");
  await snapshot.expectTrigger("Updated trigger");
});

test("shows the referenced failure on an initial read and reload recovers", async ({
  hub,
  page,
}) => {
  const snapshot = new SnapshotRecovery(page, hub.primaryApplication());
  await snapshot.seedTrigger();
  await snapshot.openTriggers();
  const baseline = snapshot.failureCount("triggers");
  await snapshot.interruptTriggers();
  await snapshot.reload();
  await snapshot.expectFailures(3, "triggers", baseline);
  await snapshot.expectInitialFailure();
  await snapshot.capture("initial-failure");
  await snapshot.restoreTriggers();
  await snapshot.reload();
  await snapshot.expectTrigger();
});

test("retains daemon and usage content when their reads fail", async ({ hub, page }) => {
  const snapshot = new SnapshotRecovery(page, hub.primaryApplication());
  await snapshot.openDaemons();
  const daemonBaseline = snapshot.failureCount("daemons");
  await snapshot.interruptDaemons();
  await snapshot.returnToTab();
  await snapshot.expectFailures(1, "daemons", daemonBaseline);
  await snapshot.expectDaemons();
  await snapshot.restoreDaemons();
  await snapshot.openUsage();
  const usageBaseline = snapshot.failureCount("usage");
  await snapshot.interruptUsage();
  await snapshot.returnToTab();
  await snapshot.expectFailures(1, "usage", usageBaseline);
  await snapshot.expectUsage();
  await snapshot.capture("usage-background-failure");
  await snapshot.restoreUsage();
});

test("does not reuse another organization's trigger snapshot when a new scope fails", async ({
  hub,
  page,
}) => {
  const snapshot = new SnapshotRecovery(page, hub.primaryApplication());
  await hub.createAnotherOrganization("owner", "Another organization");
  await hub.chooseOrganization("owner", "Snapshot test");
  await snapshot.seedTrigger();
  await snapshot.openTriggers();
  await snapshot.expectTrigger();
  await hub.chooseOrganization("owner", "Another organization");
  const baseline = snapshot.failureCount("triggers");
  await snapshot.interruptTriggers();
  await snapshot.visitTriggers();
  await snapshot.expectFailures(3, "triggers", baseline);
  await snapshot.expectInitialFailure();
  await snapshot.restoreTriggers();
});
