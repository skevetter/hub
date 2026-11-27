import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { deriveAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import { createMemoryDatabase } from "../db/memory.js";
import { turnEndFixture } from "./test-utils/turn-end-fixture.js";
import { TURN_END_COMPLETION, TURN_END_SETTLE_MS } from "./turn-end.js";

describe("run reply capture on the daemon stream", () => {
  it("offers only the final message of the settled turn and keeps it out of run outputs", async () => {
    const database = createMemoryDatabase();
    const onRunReplyAnswer = vi.fn();
    const fixture = await turnEndFixture({
      database,
      organizationId: "reply-org",
      workflow: true,
      completeOnTurnEnd: true,
      onRunReplyAnswer,
    });
    try {
      const { execution, step } = await fixture.dispatch();
      await fixture.endTurn("This is from an earlier turn.");
      await fixture.deliver(fixture.events.turnStarted());
      await fixture.deliver(fixture.events.text("This message is also earlier.", "earlier"));
      await fixture.deliver(fixture.events.text("Final ", "final"));
      await fixture.deliver(fixture.events.text("answer.", "final"));
      await fixture.deliver(fixture.events.turnCompleted());
      assert.equal(onRunReplyAnswer.mock.calls.length, 0);
      await fixture.clock.advance(TURN_END_SETTLE_MS);
      await fixture.deliver(fixture.events.turnCompleted());
      assert.deepEqual(onRunReplyAnswer.mock.calls, [
        [
          { organizationId: "reply-org", runId: execution.launchIntent?.triggerRunId },
          execution.id,
          { text: "Final answer.", truncated: false },
        ],
      ]);
      const result = { status: "succeeded", completion: TURN_END_COMPLETION };
      assert.deepEqual((await fixture.execution(execution.id)).result, result);
      assert.deepEqual((await database.findWorkflowStepRunById(step!.id))?.output, result);
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it.each([
    { text: null, candidate: false },
    { text: "Final answer after finish.", candidate: false },
    { text: null, candidate: true },
    { text: "Final answer after finish.", candidate: true },
  ])(
    "waits for the turn after explicit finish (answer $text, candidate only $candidate)",
    async ({ text, candidate }) => {
      const onRunReplyAnswer = vi.fn();
      const fixture = await turnEndFixture({
        database: createMemoryDatabase(),
        organizationId: "reply-org",
        workflow: true,
        replyCaptureCandidate: candidate,
        onRunReplyAnswer,
      });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.deliver(fixture.events.turnStarted());
        const completed = await fixture.lifecycle.completeAgentExecutionFromCallback(
          {
            executionId: execution.id,
            token: deriveAgentExecutionCompletionToken("test-secret", execution.id),
          },
          { deferHubAction: true },
        );
        assert.equal(completed.status, "succeeded");
        assert.equal(onRunReplyAnswer.mock.calls.length, 0);
        if (text !== null) await fixture.deliver(fixture.events.text(text, "after-finish"));
        await fixture.deliver(fixture.events.turnCompleted());
        await fixture.deliver(fixture.events.turnCompleted());
        assert.deepEqual(onRunReplyAnswer.mock.calls, [
          [
            { organizationId: "reply-org", runId: execution.launchIntent?.triggerRunId },
            execution.id,
            text === null ? null : { text, truncated: false },
          ],
        ]);
        assert.equal(fixture.lifecycle.activeExecutionObservationCount(), 0);
      } finally {
        await fixture.lifecycle.stop();
      }
    },
  );

  it("captures a candidate step's answer and still records its turn-end output", async () => {
    const database = createMemoryDatabase();
    const onRunReplyAnswer = vi.fn();
    const fixture = await turnEndFixture({
      database,
      organizationId: "reply-org",
      workflow: true,
      completeOnTurnEnd: true,
      replyCaptureCandidate: true,
      onRunReplyAnswer,
    });
    try {
      const { execution, step } = await fixture.dispatch();
      await fixture.endTurn("An earlier step answer.");
      await fixture.clock.advance(TURN_END_SETTLE_MS);
      await fixture.deliver(fixture.events.turnCompleted());
      assert.deepEqual(onRunReplyAnswer.mock.calls, [
        [
          { organizationId: "reply-org", runId: execution.launchIntent?.triggerRunId },
          execution.id,
          { text: "An earlier step answer.", truncated: false },
        ],
      ]);
      assert.deepEqual((await database.findWorkflowStepRunById(step!.id))?.output, {
        status: "succeeded",
        completion: TURN_END_COMPLETION,
        output: "An earlier step answer.",
      });
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("ignores a repeated turn start while waiting for the explicit finish tail", async () => {
    const onRunReplyAnswer = vi.fn();
    const fixture = await turnEndFixture({
      database: createMemoryDatabase(),
      organizationId: "reply-org",
      workflow: true,
      onRunReplyAnswer,
    });
    try {
      const { execution } = await fixture.dispatch();
      const started = fixture.events.turnStarted();
      assert.equal(started.type, "agent_stream");
      if (started.type !== "agent_stream") throw new Error("expected a stream event");
      const replayed = { ...started, seq: 1 };
      await fixture.deliver(replayed);
      await fixture.lifecycle.completeAgentExecutionFromCallback({
        executionId: execution.id,
        token: deriveAgentExecutionCompletionToken("test-secret", execution.id),
      });
      await fixture.deliver(replayed);
      await fixture.deliver(fixture.events.text("Current turn answer."));
      await fixture.deliver(fixture.events.turnCompleted());
      assert.equal(onRunReplyAnswer.mock.calls.length, 1);
    } finally {
      await fixture.lifecycle.stop();
    }
  });
});
