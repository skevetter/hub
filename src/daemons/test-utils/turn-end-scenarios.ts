import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { Database } from "../../db/types.js";
import { deriveAgentExecutionCompletionToken } from "../../agent-executions/completion-token.js";
import { MAX_TURN_END_OUTPUT_CHARS, TURN_END_COMPLETION, TURN_END_SETTLE_MS } from "../turn-end.js";
import { IDLE_TIMEOUT_MS, turnEndFixture, type TurnEndFixtureOptions } from "./turn-end-fixture.js";

export interface TurnEndDatabase {
  database: Database;
  organizationId: string;
}

const SETTLED = TURN_END_SETTLE_MS + 1;

function resultField(result: unknown, key: string): unknown {
  return typeof result === "object" && result !== null ? Reflect.get(result, key) : undefined;
}

/** How many of the spied completion calls actually changed the execution. */
async function transitionedCount(results: ReadonlyArray<{ value: unknown }>): Promise<number> {
  let count = 0;
  for (const { value } of results) {
    const outcome = await value;
    if (typeof outcome === "object" && outcome !== null && Reflect.get(outcome, "transitioned")) {
      count += 1;
    }
  }
  return count;
}

/** The same scenarios run against every database implementation the engine can use. */
export function registerTurnEndScenarios(openDatabase: () => Promise<TurnEndDatabase>): void {
  async function open(options: Partial<TurnEndFixtureOptions> = {}) {
    const { database, organizationId } = await openDatabase();
    return turnEndFixture({ database, organizationId, ...options });
  }

  describe.each([
    { owner: "workflow step", workflow: true },
    { owner: "single execution", workflow: false },
  ])("complete on turn end for a $owner", ({ workflow }) => {
    it("keeps today's failure when the option is off", async () => {
      const fixture = await open({ workflow });
      try {
        const { execution, step } = await fixture.dispatch();
        await fixture.endTurn("ok");
        await fixture.clock.advance(IDLE_TIMEOUT_MS - 1_000);
        assert.equal((await fixture.execution(execution.id)).status, "running");
        await fixture.clock.advance(2_000);

        const failed = await fixture.execution(execution.id);
        assert.equal(failed.status, "failed");
        assert.deepEqual(failed.result, {
          status: "failed",
          reason: workflow ? "step_idle_timeout" : "idle_timeout",
        });
        if (step !== undefined) {
          const stepRun = await fixture.database.findWorkflowStepRunById(step.id);
          assert.equal(stepRun?.status, "timed_out");
          assert.equal(stepRun?.failureReason, "step_idle_timeout");
        }
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("completes a settled finished turn and records that it was inferred", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution, step } = await fixture.dispatch();
        await fixture.endTurn("All done, the branch is pushed.");
        await fixture.clock.advance(TURN_END_SETTLE_MS - 1);
        assert.equal((await fixture.execution(execution.id)).status, "running");
        await fixture.clock.advance(2);

        const done = await fixture.execution(execution.id);
        const expected = {
          status: "succeeded",
          completion: TURN_END_COMPLETION,
          output: "All done, the branch is pushed.",
        };
        assert.equal(done.status, "succeeded");
        assert.equal(done.completedByAgentAt, null);
        assert.deepEqual(done.result, expected);
        if (step !== undefined) {
          const stepRun = await fixture.database.findWorkflowStepRunById(step.id);
          assert.equal(stepRun?.status, "succeeded");
          assert.deepEqual(stepRun?.output, expected);
        }
        // The idle deadline that would have failed the run no longer applies.
        await fixture.clock.advance(IDLE_TIMEOUT_MS);
        assert.equal((await fixture.execution(execution.id)).status, "succeeded");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("invents no output when the agent said nothing", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.endTurn();
        await fixture.clock.advance(SETTLED);

        const done = await fixture.execution(execution.id);
        assert.deepEqual(done.result, { status: "succeeded", completion: TURN_END_COMPLETION });
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("cuts a long closing text without splitting a surrogate pair", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution, step } = await fixture.dispatch();
        // The emoji straddles the cut, so a plain slice would leave a lone high surrogate.
        await fixture.endTurn(`${"x".repeat(MAX_TURN_END_OUTPUT_CHARS - 1)}\u{1F600}`);
        await fixture.clock.advance(SETTLED);

        const done = await fixture.execution(execution.id);
        assert.equal(done.status, "succeeded");
        assert.equal(resultField(done.result, "output"), "x".repeat(MAX_TURN_END_OUTPUT_CHARS - 1));
        assert.equal(resultField(done.result, "outputTruncated"), true);
        if (step !== undefined) {
          assert.equal(
            (await fixture.database.findWorkflowStepRunById(step.id))?.status,
            "succeeded",
          );
        }
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("uses only the closing text, not what was said before the last tool call", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        fixture.state.status = "running";
        await fixture.deliver(fixture.events.turnStarted());
        await fixture.deliver(fixture.events.text("Let me check."));
        await fixture.deliver(fixture.events.toolCall("Bash", "completed"));
        await fixture.deliver(fixture.events.text("Fixed ", "message-2"));
        await fixture.deliver(fixture.events.text("it.", "message-2"));
        fixture.state.status = "idle";
        await fixture.deliver(fixture.events.turnCompleted());
        await fixture.clock.advance(SETTLED);

        assert.equal(
          resultField((await fixture.execution(execution.id)).result, "output"),
          "Fixed it.",
        );
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("archives the workspace after an inferred completion when auto_archive is on", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true, autoArchive: true });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.endTurn("ok");
        await fixture.clock.advance(SETTLED);

        assert.equal((await fixture.execution(execution.id)).status, "succeeded");
        assert.deepEqual(fixture.controls, ["archive"]);
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("does not complete a turn that is still running", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        fixture.state.status = "running";
        await fixture.deliver(fixture.events.turnStarted());
        await fixture.deliver(fixture.events.status("running"));
        await fixture.deliver(fixture.events.toolCall("Bash", "running"));
        await fixture.clock.advance(10 * TURN_END_SETTLE_MS);

        assert.equal((await fixture.execution(execution.id)).status, "running");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("does not complete while the agent waits for a permission", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        fixture.state.status = "running";
        await fixture.deliver(fixture.events.turnStarted());
        await fixture.deliver(fixture.events.permissionRequested());
        await fixture.deliver(fixture.events.status("idle"));
        await fixture.clock.advance(10 * TURN_END_SETTLE_MS);

        assert.equal((await fixture.execution(execution.id)).status, "running");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it.each([
      ["errored", "turnFailed"],
      ["canceled", "turnCanceled"],
    ] as const)("does not complete a turn that %s", async (_label, event) => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        fixture.state.status = "running";
        await fixture.deliver(fixture.events.turnStarted());
        await fixture.deliver(fixture.events.text("partial"));
        fixture.state.status = "idle";
        await fixture.deliver(fixture.events[event]());
        await fixture.deliver(fixture.events.status("idle"));
        await fixture.clock.advance(10 * TURN_END_SETTLE_MS);

        assert.equal((await fixture.execution(execution.id)).status, "running");
        await fixture.clock.advance(IDLE_TIMEOUT_MS);
        assert.equal((await fixture.execution(execution.id)).status, "failed");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("does not complete when the agent errored after the turn ended", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.endTurn("ok");
        await fixture.deliver(fixture.events.status("error"));
        await fixture.clock.advance(SETTLED);

        const failed = await fixture.execution(execution.id);
        assert.equal(failed.status, "failed");
        assert.deepEqual(failed.result, { status: "failed", reason: "agent_interrupted" });
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("drops the pending completion when the agent starts another turn in the settle window", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.endTurn("first");
        await fixture.clock.advance(TURN_END_SETTLE_MS - 500);
        fixture.state.status = "running";
        await fixture.deliver(fixture.events.turnStarted());
        await fixture.clock.advance(10 * TURN_END_SETTLE_MS);
        assert.equal((await fixture.execution(execution.id)).status, "running");

        await fixture.deliver(fixture.events.text("second"));
        fixture.state.status = "idle";
        await fixture.deliver(fixture.events.turnCompleted());
        await fixture.clock.advance(SETTLED);

        const done = await fixture.execution(execution.id);
        assert.equal(done.status, "succeeded");
        assert.equal(resultField(done.result, "output"), "second");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("re-checks the daemon and skips a completion when the agent is not idle", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.endTurn("ok");
        fixture.state.status = "running";
        await fixture.clock.advance(SETTLED);
        assert.equal((await fixture.execution(execution.id)).status, "running");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("skips a completion when the daemon cannot say whether the agent is idle", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.endTurn("ok");
        fixture.state.statusFails = true;
        await fixture.clock.advance(SETTLED);
        assert.equal((await fixture.execution(execution.id)).status, "running");
        assert.equal(
          fixture.failures
            .records()
            .filter((record) => record["operation"] === "daemon.execution.turn-end.status").length,
          1,
        );
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("ignores a turn end that was reported before the prompt was sent", async () => {
      const fixture = await open({
        workflow,
        completeOnTurnEnd: true,
        duringSubscribe: (emit) => {
          emit({
            type: "agent_stream",
            agentId: "agent-turn-end",
            event: { type: "turn_completed", provider: "claude" },
            timestamp: new Date().toISOString(),
          });
        },
      });
      try {
        const { execution } = await fixture.dispatch();
        await fixture.flush();
        await fixture.clock.advance(10 * TURN_END_SETTLE_MS);
        assert.equal((await fixture.execution(execution.id)).status, "running");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("does not complete while a finish_execution call is still in flight", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        fixture.state.status = "running";
        await fixture.deliver(fixture.events.turnStarted());
        await fixture.deliver(fixture.events.toolCall("mcp__hub__finish_execution", "running"));
        fixture.state.status = "idle";
        await fixture.deliver(fixture.events.turnCompleted());
        await fixture.clock.advance(10 * TURN_END_SETTLE_MS);
        assert.equal((await fixture.execution(execution.id)).status, "running");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("completes after a finish_execution call that failed", async () => {
      const fixture = await open({ workflow, completeOnTurnEnd: true });
      try {
        const { execution } = await fixture.dispatch();
        fixture.state.status = "running";
        await fixture.deliver(fixture.events.turnStarted());
        await fixture.deliver(fixture.events.toolCall("mcp__hub__finish_execution", "failed"));
        await fixture.deliver(fixture.events.text("could not finish"));
        fixture.state.status = "idle";
        await fixture.deliver(fixture.events.turnCompleted());
        await fixture.clock.advance(SETTLED);
        assert.equal((await fixture.execution(execution.id)).status, "succeeded");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    it("never completes a stored launch intent that skipped compile-time validation and declares a structured or required output", async () => {
      for (const contract of [
        { outputSchema: { type: "object" } },
        { requiredOutput: true },
      ] as const) {
        const fixture = await open({ workflow, completeOnTurnEnd: true, ...contract });
        try {
          const { execution } = await fixture.dispatch();
          await fixture.endTurn("ok");
          await fixture.clock.advance(10 * TURN_END_SETTLE_MS);
          assert.equal((await fixture.execution(execution.id)).status, "running");
        } finally {
          await fixture.lifecycle.stop();
        }
      }
    });

    it("leaves a turn that serves several queued prompts to the idle timeout", async () => {
      const fixture = await open({
        workflow,
        completeOnTurnEnd: true,
        continuationKey: "conversation-1",
      });
      try {
        const first = await fixture.dispatch();
        const second = await fixture.dispatch();
        await fixture.endTurn("answered both");
        await fixture.clock.advance(10 * TURN_END_SETTLE_MS);

        assert.equal((await fixture.execution(first.execution.id)).status, "running");
        assert.equal((await fixture.execution(second.execution.id)).status, "running");
      } finally {
        await fixture.lifecycle.stop();
      }
    });

    describe("against an explicit finish_execution", () => {
      const token = (executionId: string) =>
        deriveAgentExecutionCompletionToken("test-secret", executionId);

      it("lets finish_execution win when it lands inside the settle window", async () => {
        const fixture = await open({ workflow, completeOnTurnEnd: true });
        try {
          const { execution } = await fixture.dispatch();
          await fixture.endTurn("ok");
          await fixture.lifecycle.completeAgentExecutionFromCallback({
            executionId: execution.id,
            token: token(execution.id),
          });
          await fixture.clock.advance(SETTLED);

          const done = await fixture.execution(execution.id);
          assert.equal(done.status, "succeeded");
          assert.notEqual(done.completedByAgentAt, null);
          assert.deepEqual(done.result, { status: "succeeded" });
        } finally {
          await fixture.lifecycle.stop();
        }
      });

      it("does not complete twice when finish_execution arrives after the inferred completion", async () => {
        const fixture = await open({ workflow, completeOnTurnEnd: true });
        const completions = vi.spyOn(
          fixture.database,
          workflow ? "completeWorkflowAgentExecution" : "transitionAgentExecution",
        );
        try {
          const { execution } = await fixture.dispatch();
          await fixture.endTurn("ok");
          await fixture.clock.advance(SETTLED);
          const inferred = await fixture.execution(execution.id);
          assert.equal(inferred.status, "succeeded");
          const before = completions.mock.calls.length;

          const late = await fixture.lifecycle.completeAgentExecutionFromCallback({
            executionId: execution.id,
            token: token(execution.id),
          });

          assert.equal(late.status, "succeeded");
          assert.equal(completions.mock.calls.length, before, "no second completion is attempted");
          const after = await fixture.execution(execution.id);
          assert.deepEqual(after.result, inferred.result);
          assert.equal(after.completedByAgentAt, null);
          assert.equal(after.completedAt?.getTime(), inferred.completedAt?.getTime());
        } finally {
          await fixture.lifecycle.stop();
        }
      });

      it.each(["inferred first", "explicit first"])(
        "commits exactly one completion when both land together (%s)",
        async (order) => {
          const fixture = await open({ workflow, completeOnTurnEnd: true });
          try {
            const { execution } = await fixture.dispatch();
            await fixture.endTurn("ok");
            const completions = vi.spyOn(
              fixture.database,
              workflow ? "completeWorkflowAgentExecution" : "transitionAgentExecution",
            );
            const inferred = fixture.clock.advance(SETTLED);
            const explicit = () =>
              fixture.lifecycle.completeAgentExecutionFromCallback({
                executionId: execution.id,
                token: token(execution.id),
              });
            if (order === "inferred first") await Promise.all([inferred, explicit()]);
            else await Promise.all([explicit(), inferred]);

            const transitioned = await transitionedCount(completions.mock.results);
            assert.equal(transitioned, 1);
            const done = await fixture.execution(execution.id);
            assert.equal(done.status, "succeeded");
            // Whichever won, the stored result matches exactly one of the two writers.
            assert.equal(
              resultField(done.result, "completion") === undefined,
              done.completedByAgentAt !== null,
            );
          } finally {
            await fixture.lifecycle.stop();
          }
        },
      );
    });
  });
}
