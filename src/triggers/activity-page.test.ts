import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../test-utils/project-configuration.js";
import { decodeActivityCursor, encodeActivityCursor } from "./activity-cursor.js";
import { TriggerDashboard } from "./dashboard.js";
import { OrganizationTriggerStore } from "./store.js";

const TOTAL = 7;

describe("trigger activity pages", () => {
  it("walks every run once, newest first, and back again", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const walked: string[][] = [];
    let cursor: string | undefined;
    let previous: string[] = [];
    for (;;) {
      const page = await dashboard.activityPage(request, "acme", {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      walked.push(page.activity.map(({ id }) => id));
      previous.push(page.previousCursor ?? "none");
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(
      walked.map((ids) => ids.length),
      [3, 3, 1],
    );
    const ids = walked.flat();
    assert.equal(new Set(ids).size, TOTAL);
    const first = await dashboard.activityPage(request, "acme", { limit: TOTAL });
    assert.deepEqual(
      ids,
      first.activity.map(({ id }) => id),
    );
    assert.equal(first.nextCursor, null);
    assert.equal(first.previousCursor, null);
    assert.equal(previous[0], "none");

    const back: string[][] = [];
    cursor = previous.at(-1);
    while (cursor !== undefined && cursor !== "none") {
      const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor });
      back.unshift(page.activity.map(({ id }) => id));
      cursor = page.previousCursor ?? undefined;
    }
    assert.deepEqual(back, walked.slice(0, 2));
  });

  it("defaults to 25 rows and caps the page at 100", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    assert.equal((await dashboard.activityPage(request, "acme", {})).limit, 25);
    assert.equal((await dashboard.activityPage(request, "acme", { limit: 500 })).limit, 100);
  });

  it("serves the newest page for a cursor it cannot read", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const newest = await dashboard.activityPage(request, "acme", { limit: 3 });
    const bad = [
      "not-a-cursor",
      Buffer.from('["before","2026-01-01T00:00:00Z","not-a-uuid"]').toString("base64url"),
      Buffer.from(
        '["sideways","2026-01-01T00:00:00Z","00000000-0000-4000-8000-000000000000"]',
      ).toString("base64url"),
      Buffer.from("[]").toString("base64url"),
    ];
    for (const cursor of bad) {
      const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor });
      assert.deepEqual(
        page.activity.map(({ id }) => id),
        newest.activity.map(({ id }) => id),
      );
      assert.equal(page.previousCursor, null);
    }
  });

  it("falls back to the newest page when the cursor's side is empty", async () => {
    const { dashboard, request } = await dashboardWithRuns(TOTAL);
    const cursor = encodeActivityCursor("before", {
      createdAt: "2000-01-01T00:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000000",
    });
    const page = await dashboard.activityPage(request, "acme", { limit: 3, cursor });
    assert.equal(page.activity.length, 3);
    assert.equal(page.previousCursor, null);
  });

  it("reads back the cursors it writes", () => {
    const key = { createdAt: "2026-01-01 00:00:00.123456+00", id: crypto.randomUUID() };
    assert.deepEqual(decodeActivityCursor(encodeActivityCursor("after", key)), {
      direction: "after",
      key,
    });
    assert.equal(decodeActivityCursor(undefined), undefined);
  });
});

async function dashboardWithRuns(count: number) {
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
  ).save({ yaml: triggerYaml, userId: "user-1" });
  const revision = await database.findActiveProjectConfiguration(trigger.runtimeProjectId);
  assert.ok(revision);
  for (let index = 0; index < count; index += 1) {
    const receipt = await database.persistManualEvent({
      organizationId: "org-1",
      projectId: trigger.runtimeProjectId,
      deliveryId: `activity-page-${index}`,
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") throw new Error("receipt was not accepted");
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
      deadlineAt: new Date(Date.now() + 3_600_000),
      stepIds: ["run"],
    });
  }
  return {
    dashboard: new TriggerDashboard(database, accountAuth(), acceptingAgentValidator()),
    request: new Request("https://hub.test/o/acme/activity"),
  };
}

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
