import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { turnEndFixture } from "../daemons/test-utils/turn-end-fixture.js";
import { TURN_END_SETTLE_MS } from "../daemons/turn-end.js";
import { LinearRunReplyWriter } from "./linear.js";
import { RunReplyReporter } from "./reporter.js";
import { fakeLinearReplies, replyEvidence } from "./test-utils/linear.js";

function cycledWithin(cycles: number[], at: number): boolean {
  return cycles.some((time) => time > at && time <= at + 2_000);
}

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

  it("posts the answer of the last agent step that ran when a later step was skipped", async () => {
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
      replyCaptureCandidate: true,
      laterStepIds: ["last"],
      onRunReplyAnswer: reporter.capture,
      ...replyEvidence,
    });
    try {
      const { execution } = await fixture.dispatch();
      const runId = execution.launchIntent?.triggerRunId;
      assert.ok(runId);
      await fixture.endTurn("The earlier step's answer.");
      await fixture.clock.advance(TURN_END_SETTLE_MS);
      await database.markWorkflowStepSkipped(runId, "last", "condition_false");
      await database.succeedTriggerRun(runId);
      await reporter.processAvailable();
      await reporter.processAvailable();
      const delivery = await database.runReplies.find({ organizationId, runId });
      assert.equal(delivery?.state, "sent");
      assert.equal(fake.writes.length, 1);
      assert.match(fake.writes[0]!, /^The earlier step's answer\./u);
    } finally {
      await fixture.lifecycle.stop();
      await reporter.stop();
    }
  });

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

    function cyclingReporter() {
      const database = createMemoryDatabase();
      const cycleTimes: number[] = [];
      const finds: string[] = [];
      const recoverable = database.runReplies.recoverable.bind(database.runReplies);
      database.runReplies.recoverable = (before) => {
        cycleTimes.push(Date.now());
        return recoverable(before);
      };
      const find = database.findTriggerRunForOrganization.bind(database);
      database.findTriggerRunForOrganization = (organizationId, runId) => {
        finds.push(runId);
        return find(organizationId, runId);
      };
      const reporter = new RunReplyReporter({ database, writer: () => undefined, perHour: 60 });
      return { reporter, cycleTimes: () => cycleTimes, finds: () => finds };
    }

    it("makes at most 2 queries per minute when idle", async () => {
      vi.useFakeTimers();
      const { reporter, queries } = countingReporter();
      reporter.start();
      await vi.advanceTimersByTimeAsync(60_000);
      await reporter.stop();
      assert.ok(queries() <= 2, `${queries()} queries in an idle minute`); // designed 30 s fallback
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

    it.each([500, 1_500, 1_990])(
      "runs a cycle within 2 seconds of every capture made every %i ms",
      async (gap) => {
        vi.useFakeTimers();
        const { reporter, cycleTimes } = cyclingReporter();
        reporter.start();
        const captures: number[] = [];
        for (let elapsed = 0; elapsed < 60_000; elapsed += gap) {
          captures.push(Date.now());
          reporter.capture({ organizationId: "org", runId: `run-${elapsed}` }, "e", null);
          await vi.advanceTimersByTimeAsync(gap);
        }
        await vi.advanceTimersByTimeAsync(2_000);
        await reporter.stop();
        const cycles = cycleTimes();
        for (const at of captures) {
          assert.ok(
            cycledWithin(cycles, at),
            `no cycle within 2 s of the capture at +${at - captures[0]!} ms`,
          );
        }
      },
    );

    it("looks at two captures made back to back within 2 seconds", async () => {
      vi.useFakeTimers();
      const { reporter, finds } = cyclingReporter();
      reporter.start();
      await vi.advanceTimersByTimeAsync(5_000);
      reporter.capture({ organizationId: "org", runId: "a" }, "e", null);
      reporter.capture({ organizationId: "org", runId: "b" }, "e", null);
      await vi.advanceTimersByTimeAsync(2_100);
      await reporter.stop();
      assert.ok(finds().includes("a") && finds().includes("b"));
    });

    it("settles a run in which no agent step ran with no_agent_step", async () => {
      vi.useFakeTimers();
      const database = createMemoryDatabase();
      const { run } = await database.createAcceptedTriggerRun({
        organizationId: "org",
        projectId: "project",
        configurationRevisionId: "revision",
        providerEventReceiptId: randomUUID(),
        configuredTriggerName: "answer",
        prompt: "",
        inputs: {},
        ...replyEvidence,
        deadlineAt: new Date(Date.now() + 3_600_000),
        stepIds: ["work"],
        replyMessage: true,
      });
      await database.succeedTriggerRun(run.id);
      await vi.advanceTimersByTimeAsync(180_000);
      const reporter = new RunReplyReporter({ database, writer: () => undefined, perHour: 60 });
      reporter.start();
      await vi.advanceTimersByTimeAsync(30_500);
      const delivery = await database.runReplies.find({ organizationId: "org", runId: run.id });
      await reporter.stop();
      assert.equal(delivery?.failure, "no_agent_step");
    });

    it("settles a pending row left by a restart after an agent step ran", async () => {
      vi.useFakeTimers();
      const database = createMemoryDatabase();
      const fixture = await turnEndFixture({
        database,
        organizationId: "org",
        workflow: true,
        onRunReplyAnswer: () => undefined,
        ...replyEvidence,
      });
      const { execution } = await fixture.dispatch();
      const runId = execution.launchIntent?.triggerRunId;
      assert.ok(runId);
      await database.succeedTriggerRun(runId);
      await vi.advanceTimersByTimeAsync(180_000);
      const reporter = new RunReplyReporter({ database, writer: () => undefined, perHour: 60 });
      reporter.start();
      await vi.advanceTimersByTimeAsync(30_500);
      const delivery = await database.runReplies.find({ organizationId: "org", runId });
      await reporter.stop();
      await fixture.lifecycle.stop();
      assert.equal(delivery?.failure, "answer_unavailable");
    });
  });
});
