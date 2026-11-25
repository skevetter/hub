import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { Database } from "../types.js";

export const TERMINAL_TEST_ORG = "terminal-notification";
export const TERMINAL_LEASE_MS = 30_000;

export async function seedTerminalNotification(
  database: Database,
  now: Date,
  triggerContext: Record<string, string> = {},
) {
  const project = await database.createProject({
    organizationId: TERMINAL_TEST_ORG,
    name: "Terminal notification",
    slug: randomUUID(),
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "terminal-notification",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: TERMINAL_TEST_ORG,
    projectId: project.id,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: now,
  });
  assert.equal(receipt.status, "accepted");
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: TERMINAL_TEST_ORG,
    projectId: project.id,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: "terminal",
    prompt: "",
    inputs: {},
    triggerContext,
    outputContext: {},
    deadlineAt: new Date(now.getTime() + 3_600_000),
    stepIds: ["work"],
  });
  assert.equal((await database.failWorkflowRun(run.id, "failed", "test"))?.transitioned, true);
  return run.id;
}
