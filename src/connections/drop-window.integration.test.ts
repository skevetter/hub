import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION as organizationId,
  type TimelinePostgresHarness,
} from "../db/test-utils/run-timeline-postgres.js";
import { ProjectDashboard } from "../projects/dashboard.js";
import { acceptingAgentValidator } from "../test-utils/agent-validator.js";
import { droppedActivityPageRequest } from "../triggers/activity-query.js";
import { TriggerDashboard } from "../triggers/dashboard.js";

let harness: TimelinePostgresHarness;
beforeAll(async () => {
  harness = await createTimelinePostgresHarness();
  await harness.runtime.query(
    `insert into "user" (id, name, email, email_verified)
     values ('review-member', 'Review Member', 'review-member@example.test', true)`,
  );
  await harness.runtime.query(
    `insert into member (id, organization_id, user_id, role)
     values ('review-membership', $1, 'review-member', 'member')`,
    [organizationId],
  );
}, 90_000);
afterAll(async () => {
  await harness?.close();
});

const auth: AuthServer = {
  handle: () => Promise.resolve(new Response()),
  resources: () => Promise.reject(new Error("unused")),
  resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
  resolveAccount: () =>
    Promise.resolve({
      account: { id: "review-member", name: "Review Member", email: "review-member@example.test" },
      session: { id: "review-session", activeOrganizationId: organizationId },
      isInstanceOperator: false,
    }),
  rejectCookieMutation: () => undefined,
  close: () => Promise.resolve(),
};
const request = new Request("https://hub.test/o/timeline/activity");
const githubFilters = droppedActivityPageRequest("timeline", {
  view: "dropped",
  range: "7d",
  provider: "github",
});

async function insertDrop(receivedAt: Date, reason: string) {
  await harness.runtime.query(
    `insert into provider_event_receipts
       (organization_id, provider, delivery_id, source, payload, received_at, dropped_reason)
     values ($1, 'github', 'fixture', 'fixture.event', '{}', $2, $3)`,
    [organizationId, receivedAt, reason],
  );
}

it("opens a non-empty seven-day Activity view when Connections reports a drop", async () => {
  const cardTime = new Date("2026-11-22T12:00:00.000Z");
  const clickTime = new Date("2026-11-22T12:01:00.000Z");
  await insertDrop(new Date("2026-11-15T12:05:00.000Z"), "no_project_route");
  const clock = vi.spyOn(Date, "now").mockReturnValue(cardTime.getTime());
  try {
    const dashboard = new ProjectDashboard(harness.database, auth);
    const scope = { organizationSlug: "timeline" };
    const nearExpiry = await dashboard.organizationSnapshot(request, scope);
    expect(nearExpiry.droppedConnectionEvents.github).toBe("none");

    await harness.runtime.query("delete from provider_event_receipts where organization_id = $1", [
      organizationId,
    ]);
    await insertDrop(new Date("2026-11-15T12:11:00.000Z"), "no_project_route");
    const snapshot = await dashboard.organizationSnapshot(request, scope);
    expect(snapshot.droppedConnectionEvents.github).toBe("some");
  } finally {
    clock.mockRestore();
  }
  const dashboard = new TriggerDashboard(harness.database, auth, acceptingAgentValidator(), {
    now: () => clickTime,
  });
  const activity = await dashboard.droppedActivityPage(request, "timeline", githubFilters);
  expect(activity.events).toHaveLength(1);
});
