import { describe, expect, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { turnEndFixture, type TurnEndFixtureOptions } from "./turn-end-fixture.js";

function open(options: Partial<TurnEndFixtureOptions> = {}) {
  const organizationId = "org-fixture";
  return turnEndFixture({
    database: createMemoryDatabase({ organizationIds: [organizationId] }),
    organizationId,
    ...options,
  });
}

describe("turn-end fixture boundaries", () => {
  it("keeps a missing workflow step undefined and can report a missing execution", async () => {
    const fixture = await open({ workflow: true });
    fixture.database.findWorkflowStepRunByTriggerRun = async () => undefined;
    try {
      const { execution, step } = await fixture.dispatch();
      expect(step).toBe(undefined);
      expect((await fixture.execution(execution.id)).status).toBe("running");
      await expect(fixture.execution("missing")).rejects.toThrow("execution is missing");
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("starts and resolves a finish call using the reported execution id", async () => {
    const fixture = await open({ completeOnTurnEnd: true });
    try {
      const { execution } = await fixture.dispatch();
      expect(fixture.sends).toHaveLength(1);
      await fixture.finishCall(execution.id, "running", "call");
      expect(fixture.lifecycle.finishCalls.ownsOutcome(execution.id)).toBe(true);
      await fixture.finishCall(execution.id, "failed", "call");
      fixture.lifecycle.finishCalls.resolve(execution.id, "failed");
      expect(fixture.lifecycle.finishCalls.ownsOutcome(execution.id)).toBe(false);
    } finally {
      await fixture.lifecycle.stop();
    }
  });
});
