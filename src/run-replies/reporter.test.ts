import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { turnEndFixture } from "../daemons/test-utils/turn-end-fixture.js";
import { TURN_END_SETTLE_MS } from "../daemons/turn-end.js";
import { LinearRunReplyWriter } from "./linear.js";
import { RunReplyReporter } from "./reporter.js";
import { fakeLinearReplies, replyEvidence } from "./test-utils/linear.js";

describe("run reply reporting", () => {
  it.each(["reply", "empty", "canceled"] as const)(
    "settles a %s run through the daemon and writer",
    async (kind) => {
      const database = createMemoryDatabase();
      const organizationId = "org";
      const fake = fakeLinearReplies(organizationId, database);
      const writer = new LinearRunReplyWriter({
        database,
        client: fake.client,
        clientSecret: "fake-client-secret",
        providerApplicationId: "app",
        connectionForLinearOrganization: fake.connectionForLinearOrganization,
      });
      const reporter = new RunReplyReporter({ database, writer: () => writer, perHour: 60 });
      const fixture = await turnEndFixture({
        database,
        organizationId,
        workflow: true,
        completeOnTurnEnd: true,
        onRunReplyAnswer: reporter.capture,
        ...replyEvidence,
      });
      try {
        const { execution } = await fixture.dispatch();
        const runId = execution.launchIntent?.triggerRunId;
        assert.ok(runId);
        await fixture.endTurn(kind === "empty" ? undefined : "The agent's final answer.");
        await fixture.clock.advance(TURN_END_SETTLE_MS);
        await reporter.processAvailable();
        assert.deepEqual(fake.calls, []);
        if (kind === "canceled") await database.cancelTriggerRun(organizationId, runId);
        else await database.succeedTriggerRun(runId);
        await reporter.processAvailable();
        await reporter.processAvailable();
        const delivery = await database.runReplies.find({ organizationId, runId });
        if (kind === "reply") {
          assert.equal(delivery?.state, "sent");
          assert.equal(fake.writes.length, 1);
          assert.match(fake.writes[0]!, /^The agent's final answer\./u);
        } else {
          assert.deepEqual(fake.calls, []);
          assert.equal(delivery?.failure, kind === "empty" ? "empty_answer" : "run_unsuccessful");
        }
      } finally {
        await fixture.lifecycle.stop();
        await reporter.stop();
      }
    },
  );

  describe("polling", () => {
    afterEach(() => vi.useRealTimers());

    function countingReporter() {
      const database = createMemoryDatabase();
      let queries = 0;
      const recoverable = database.runReplies.recoverable.bind(database.runReplies);
      database.runReplies.recoverable = (before) => {
        queries += 1;
        return recoverable(before);
      };
      const find = database.findTriggerRunForOrganization.bind(database);
      database.findTriggerRunForOrganization = (...args) => {
        queries += 1;
        return find(...args);
      };
      const reporter = new RunReplyReporter({ database, writer: () => undefined, perHour: 60 });
      return { reporter, queries: () => queries };
    }

    it("barely queries the database while nothing is waiting", async () => {
      vi.useFakeTimers();
      const { reporter, queries } = countingReporter();
      reporter.start();
      await vi.advanceTimersByTimeAsync(60_000);
      await reporter.stop();
      assert.ok(queries() <= 2, `${queries()} queries in an idle minute`);
    });

    it("polls every 2 seconds while a captured answer waits and returns to idle after", async () => {
      vi.useFakeTimers();
      const { reporter, queries } = countingReporter();
      reporter.start();
      reporter.capture({ organizationId: "org", runId: "missing-run" }, "execution", null);
      await vi.advanceTimersByTimeAsync(2_000);
      assert.ok(queries() >= 1);
      const settled = queries();
      await vi.advanceTimersByTimeAsync(60_000);
      await reporter.stop();
      assert.ok(queries() - settled <= 3, `${queries() - settled} queries after settling`);
    });
  });
});
