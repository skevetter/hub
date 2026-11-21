import assert from "node:assert/strict";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { TriggerDashboard } from "../triggers/dashboard.js";
import { OrganizationTriggerStore } from "../triggers/store.js";
import { acceptingAgentValidator } from "./agent-validator.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "./project-configuration.js";

export async function dashboardWithRuns(count: number) {
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
  let created = 0;
  const addRuns = async (extra: number) => {
    const createdAt = new Date(Date.now() + created);
    for (let index = 0; index < extra; index += 1) {
      const receipt = await database.persistManualEvent({
        organizationId: "org-1",
        projectId: trigger.runtimeProjectId,
        deliveryId: `activity-page-${created}`,
        source: "manual.run",
        payload: {},
        receivedAt: createdAt,
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
        createdAt,
        stepIds: ["run"],
      });
      created += 1;
    }
  };
  await addRuns(count);
  return {
    database,
    trigger,
    addRuns,
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
