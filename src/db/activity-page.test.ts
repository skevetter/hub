import { expect, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import type { AcceptedTriggerRunRecord } from "./types.js";

it("includes only unsuccessful runs in the memory activity page", async () => {
  const organizationId = "team";
  const database = createMemoryDatabase({ organizationIds: [organizationId] });
  const project = await database.createProject({
    organizationId,
    name: "Activity",
    slug: "activity",
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "fixture",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const seed = async (status: AcceptedTriggerRunRecord["status"] | "rejected") => {
    const receipt = await database.persistManualEvent({
      organizationId,
      projectId: project.id,
      deliveryId: status,
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    if (receipt.status !== "accepted") throw new Error("Expected receipt");
    const input = {
      organizationId,
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "activity",
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext: {},
    };
    if (status === "rejected") {
      await database.createRejectedTriggerRun({
        ...input,
        rejection: { code: "missing_required", inputName: "fixture" },
      });
      return;
    }
    const { run } = await database.createAcceptedTriggerRun({
      ...input,
      stepIds: [],
      deadlineAt: new Date(),
    });
    run.status = status;
  };
  for (const status of [
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "canceled",
    "rejected",
  ] as const)
    await seed(status);
  const { records } = await database.listOrganizationActivityPage(
    organizationId,
    [{ projectId: project.id }],
    { limit: 10, status: "unsuccessful" },
  );
  expect(records.map(({ run }) => run.status).sort()).toEqual(["failed", "rejected", "timed_out"]);
});
