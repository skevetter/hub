import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import type { GitHubNotificationStore } from "./github-notifications/index.js";
import { TriggerDashboard } from "./dashboard.js";
import { OrganizationTriggerStore } from "./store.js";

describe("trigger dashboard read model", () => {
  it("describes the provider and latest run on the organization trigger list", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "owner",
        },
      ],
    });
    await enrollTestDaemon(database, "org-1");
    const trigger = await new OrganizationTriggerStore(
      database,
      "org-1",
      acceptingAgentValidator(),
    ).save({
      yaml: triggerYaml,
      userId: "user-1",
    });
    const dashboard = new TriggerDashboard(database, accountAuth(), acceptingAgentValidator());
    const request = new Request("https://hub.test/o/acme/triggers");

    const before = await dashboard.snapshot(request, "acme");
    assert.equal(before.triggers[0]?.provider, "manual");
    assert.equal(before.triggers[0]?.event, "manual.run");
    assert.equal(before.triggers[0]?.lastTriggered, null);

    const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
    assert.ok(revision);
    const receivedAt = new Date("2026-08-30T09:30:00.000Z");
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      deliveryId: "dashboard-manual-run",
      source: "manual.run",
      payload: {},
      receivedAt,
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") return;
    await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "manual-task",
      prompt: "run it",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date("2026-08-30T10:30:00.000Z"),
      stepIds: ["run"],
    });

    const after = await dashboard.snapshot(request, "acme");
    assert.deepEqual(after.triggers[0]?.lastTriggered, {
      status: "running",
      receivedAt: receivedAt.toISOString(),
    });
  });
});

const NOW = new Date("2026-11-14T12:00:00.000Z");
const MEMBERSHIP = {
  userId: "user-1",
  organizationId: "org-1",
  organizationName: "Acme",
  organizationSlug: "acme",
  membershipId: "membership-1",
  role: "owner",
} as const;

const notificationYaml = (enabled: boolean) => `name: review-requests
enabled: ${String(enabled)}
on:
  github.notification:
    filters:
      repo: acme/webapp
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Review it
`;

/** A store that reports a fixed status and records what the dashboard asked it to count. */
function statusStore(
  status: Partial<Awaited<ReturnType<GitHubNotificationStore["readStatus"]>>>,
  delivered = 0,
) {
  const counted: { organizationId: string; since: Date }[] = [];
  const store: GitHubNotificationStore = {
    exclusive: (operation) => operation(),
    readCursor: async () => undefined,
    saveCursor: async () => {},
    deliver: async () => 0,
    recordSuccess: async () => {},
    recordFailure: async () => {},
    readStatus: async () => ({
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      nextPollAt: null,
      ...status,
    }),
    countDelivered: async (organizationId, since) => {
      counted.push({ organizationId, since });
      return delivered;
    },
  };
  return { store, counted };
}

async function notificationDashboard(options: {
  store?: GitHubNotificationStore;
  triggerEnabled?: boolean | undefined;
  enabled?: boolean;
}) {
  const database = createMemoryDatabase({
    memberships: [MEMBERSHIP],
    ...(options.store === undefined ? {} : { githubNotifications: options.store }),
  });
  await enrollTestDaemon(database, "org-1");
  if (options.triggerEnabled !== undefined) {
    await new OrganizationTriggerStore(database, "org-1", acceptingAgentValidator()).save({
      yaml: notificationYaml(options.triggerEnabled),
      userId: "user-1",
    });
  }
  return new TriggerDashboard(database, accountAuth(), acceptingAgentValidator(), {
    githubNotificationsEnabled: options.enabled ?? true,
    now: () => NOW,
  });
}

const request = () => new Request("https://hub.test/o/acme/triggers");

describe("trigger dashboard notification status", () => {
  it("is absent without a github.notification trigger", async () => {
    const dashboard = await notificationDashboard({ store: statusStore({}).store });
    assert.equal("notifications" in (await dashboard.snapshot(request(), "acme")), false);
  });

  it("is present for an enabled or a disabled github.notification trigger", async () => {
    for (const triggerEnabled of [true, false]) {
      const dashboard = await notificationDashboard({
        store: statusStore({}).store,
        triggerEnabled,
      });
      const snapshot = await dashboard.snapshot(request(), "acme");
      assert.equal(snapshot.triggers[0]?.event, "github.notification");
      assert.equal(snapshot.notifications?.state, "starting");
    }
  });

  it("reports a healthy poll with its times and the 24 hour count", async () => {
    const lastSuccessAt = new Date(NOW.getTime() - 30_000);
    const nextPollAt = new Date(NOW.getTime() + 30_000);
    const { store, counted } = statusStore({ lastSuccessAt, nextPollAt }, 7);
    const dashboard = await notificationDashboard({ store, triggerEnabled: true });
    const { notifications } = await dashboard.snapshot(request(), "acme");
    assert.deepEqual(notifications, {
      state: "polling",
      lastSuccessAt: lastSuccessAt.toISOString(),
      nextPollAt: nextPollAt.toISOString(),
      lastError: null,
      delivered24h: 7,
    });
    assert.deepEqual(counted, [
      { organizationId: "org-1", since: new Date("2026-11-13T12:00:00.000Z") },
    ]);
  });

  it("is off when no token is configured, whatever the stored status says", async () => {
    const { store } = statusStore({ lastSuccessAt: new Date(NOW.getTime() - 1000) });
    const dashboard = await notificationDashboard({ store, triggerEnabled: true, enabled: false });
    assert.equal((await dashboard.snapshot(request(), "acme")).notifications?.state, "off");
  });

  it("reports an error that is newer than the last success", async () => {
    const { store } = statusStore({
      lastSuccessAt: new Date(NOW.getTime() - 120_000),
      lastError: "GitHub notifications returned 401: Bad credentials",
      lastErrorAt: new Date(NOW.getTime() - 60_000),
      nextPollAt: new Date(NOW.getTime() + 60_000),
    });
    const dashboard = await notificationDashboard({ store, triggerEnabled: true });
    const { notifications } = await dashboard.snapshot(request(), "acme");
    assert.equal(notifications?.state, "error");
    assert.equal(notifications?.lastError, "GitHub notifications returned 401: Bad credentials");
  });

  it("reports a poll that is long overdue as stalled", async () => {
    const { store } = statusStore({
      lastSuccessAt: new Date(NOW.getTime() - 3_600_000),
      nextPollAt: new Date(NOW.getTime() - 3_540_000),
    });
    const dashboard = await notificationDashboard({ store, triggerEnabled: true });
    assert.equal((await dashboard.snapshot(request(), "acme")).notifications?.state, "stalled");
  });

  it("works on the in-memory store before any poll", async () => {
    const dashboard = await notificationDashboard({ triggerEnabled: true });
    assert.deepEqual((await dashboard.snapshot(request(), "acme")).notifications, {
      state: "starting",
      lastSuccessAt: null,
      nextPollAt: null,
      lastError: null,
      delivered24h: 0,
    });
  });
});

describe("in-memory notification store", () => {
  it("stores a failure, clears it on success, and counts only notification receipts", async () => {
    const database = createMemoryDatabase({ memberships: [MEMBERSHIP] });
    const store = database.githubNotifications;
    const t1 = new Date("2026-11-14T10:00:00Z");
    const t2 = new Date("2026-11-14T10:01:00Z");
    const t3 = new Date("2026-11-14T10:02:00Z");
    await store.recordSuccess(t1);
    await store.recordFailure(t2, "GitHub notifications returned 401");
    assert.deepEqual(await store.readStatus(), {
      lastSuccessAt: t1,
      lastError: "GitHub notifications returned 401",
      lastErrorAt: t2,
      nextPollAt: null,
    });
    await store.recordSuccess(t3);
    assert.deepEqual(await store.readStatus(), {
      lastSuccessAt: t3,
      lastError: null,
      lastErrorAt: t2,
      nextPollAt: null,
    });
    assert.equal(database.githubNotifications, store);
    assert.equal(await store.countDelivered("org-1", new Date(0)), 0);
  });
});

const triggerYaml = `name: manual-task
enabled: true
on:
  manual.run: {}
run:
  target: { daemon: ${TEST_DAEMON_SLUG}, cwd: /workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Handle it
`;

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
