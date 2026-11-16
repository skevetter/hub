import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, it, vi } from "vitest";
import { createHubApplication } from "../app.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { RunTimelineBus } from "./bus.js";
import { RunTimeline } from "./index.js";
import { createTimelineScrubber } from "./scrub.js";
import { assertBackgroundSweepExits } from "./test-utils/background-exit.js";

const ORGANIZATION = "accounting-observability";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("does not keep the native process alive solely for accounting recovery", async () => {
  await assertBackgroundSweepExits("accounting");
});

it.each([false, true])(
  "reports and reclaims retained accounting through Hub resources with permanent failure=%s",
  async (permanent) => {
    const database = createMemoryDatabase({ organizationIds: [ORGANIZATION] });
    const project = await database.createProject({
      organizationId: ORGANIZATION,
      name: "Accounting",
      slug: randomUUID(),
      createdByUserId: null,
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "accounting-observability",
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id, []);
    const receipt = await database.persistManualEvent({
      organizationId: ORGANIZATION,
      projectId: project.id,
      deliveryId: randomUUID(),
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") throw new Error("Manual receipt was not accepted");
    const { run } = await database.createAcceptedTriggerRun({
      organizationId: ORGANIZATION,
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "accounting",
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      deadlineAt: new Date(Date.now() + 3_600_000),
      stepIds: [],
    });
    const record = database.recordRunTimelineDrops.bind(database);
    const write = vi
      .spyOn(database, "recordRunTimelineDrops")
      .mockRejectedValue(new Error("Temporary outage"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const timeline = new RunTimeline(database, {
      maxEvents: 500,
      retentionDays: 30,
      bus: new RunTimelineBus(),
      scrub: createTimelineScrubber(),
    });
    const application = createHubApplication({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      runTimeline: timeline,
      publicApi: { status: "unavailable" },
    });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const scope = { organizationId: ORGANIZATION, triggerRunId: run.id };
    const blocked = timeline.run(scope, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      for (let index = 0; index < 251; index += 1) timeline.recordRunStart(scope);
      release.resolve();
      await blocked;
      await timeline.flush();
      const retained = application.hub.resourceCounts();
      assert.equal(retained.timelineQueueDepth, 0);
      assert.equal(retained.timelineQueueEntries, 1);
      assert.equal(retained.timelineAccountingEntries, 1);
      assert.equal(retained.timelineAccountingGiveUps, 0);
      assert.equal(retained.timelineAccountingDropsAbandoned, 0);
      if (!permanent) write.mockImplementation(record);
      await vi.advanceTimersByTimeAsync(permanent ? 180_000 : 60_000);
      await timeline.flush();
      assert.deepEqual(application.hub.resourceCounts(), {
        executionSubscriptions: 0,
        timelineQueueDepth: 0,
        timelineQueueEntries: 0,
        timelineAccountingEntries: 0,
        timelineAccountingGiveUps: permanent ? 1 : 0,
        timelineAccountingDropsAbandoned: permanent ? 51 : 0,
      });
      assert.equal(
        (await database.readRunTimelineState(ORGANIZATION, run.id))?.droppedCount,
        permanent ? 0 : 51,
      );
    } finally {
      release.resolve();
      await blocked;
      await application.hub.stop();
      await timeline.stop();
      await database.close();
    }
  },
);
