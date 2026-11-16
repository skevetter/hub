import assert from "node:assert/strict";
import type { TriggerProvider } from "../triggers/index.js";
import { afterEach, describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { createLogger } from "../logger.js";
import { reportFailure } from "../failures/index.js";
import { FailureLogStream } from "../test-utils/failure-logs.js";
import { turnEndFixture } from "../daemons/test-utils/turn-end-fixture.js";
import { TURN_END_SETTLE_MS } from "../daemons/turn-end.js";
import { deriveAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import { createDaemonDispatchLifecycle } from "../daemons/lifecycle.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { DurableWorkflowEngine } from "../workflows/engine.js";
import { TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import { RunTimeline } from "./index.js";
import { RunTimelineBus } from "./bus.js";
import { RunTimelineReconciler } from "./reconcile.js";
import { createObservedDatabase } from "./observed-database.js";
import { createTimelineScrubber } from "./scrub.js";
import { jsonbBytes } from "./data.js";

const ORGANIZATION = "capture-integration-organization";
const PAGE = { afterSeq: 0, limit: 5110 };
const SECRET = ["gh", "p_", "8Mx7Qp2Lv9Bz5Ka4Dw6Nr3Ys"].join("");
const cleanup: Array<() => Promise<void>> = [];

function isStepStarted(row: { kind: string }): boolean {
  return row.kind === "step_started";
}

function isStepFinished(row: { kind: string }): boolean {
  return row.kind === "step_finished";
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const close = cleanup.pop();
    if (close) await close();
  }
  vi.restoreAllMocks();
});

function pipeline(database: Database = createMemoryDatabase({ organizationIds: [ORGANIZATION] })) {
  const logs = new FailureLogStream();
  const logger = createLogger(logs);
  const bus = new RunTimelineBus();
  const scrub = createTimelineScrubber({ scrubValues: [SECRET] });
  let now = new Date();
  const options = {
    bus,
    scrub,
    maxEvents: 5000,
    retentionDays: 30,
    now: () => now,
    reportFailure: (error: unknown, operation: string) => {
      reportFailure(
        error,
        { operation, component: "run-progress" },
        { logger, scrubValues: [SECRET] },
      );
    },
  };
  const timeline = new RunTimeline(database, options);
  const reconciler = new RunTimelineReconciler(database, { ...options, queue: timeline });
  const observed = createObservedDatabase(database, {
    timeline,
    reconciler,
    reportFailure: options.reportFailure,
  });
  cleanup.push(async () => {
    await reconciler.stop();
    await timeline.stop();
  });
  return {
    database,
    observed,
    timeline,
    reconciler,
    logs,
    logger,
    bus,
    scrub,
    setNow(value: Date) {
      now = value;
    },
  };
}

function assertNoSecret(text: string): void {
  for (let index = 0; index + 8 <= SECRET.length; index += 1)
    assert.equal(text.includes(SECRET.slice(index, index + 8)), false);
}

describe("daemon capture through persisted workflow transitions", () => {
  it("records ordered live events through the lifecycle and seals only persisted ends without copying private daemon fields", async () => {
    const runtime = pipeline();
    const fixture = await turnEndFixture({
      database: runtime.observed,
      organizationId: ORGANIZATION,
      workflow: true,
      timeline: runtime.timeline,
      duringSubscribe: (emit) =>
        emit({
          type: "agent_stream",
          agentId: "agent-turn-end",
          timestamp: new Date().toISOString(),
          event: {
            type: "timeline",
            provider: "claude",
            item: { type: "tool_call", callId: "before-prompt", name: "Bash", status: "completed" },
          },
        }),
    });
    cleanup.push(() => fixture.lifecycle.stop());
    const { execution, step } = await fixture.dispatch();
    assert.ok(step);
    await runtime.observed.linkWorkflowStepRunExecution(step.id, execution.id);
    const runId = step.triggerRunId;
    await vi.waitFor(async () =>
      assert.equal(
        (await runtime.database.listRunTimelineEvents(ORGANIZATION, runId, PAGE)).filter(
          isStepStarted,
        ).length,
        1,
      ),
    );
    await fixture.deliver(
      fixture.stream({ type: "thread_started", provider: "claude", sessionId: SECRET }),
    );
    await fixture.deliver(fixture.events.turnStarted());
    await fixture.deliver(
      fixture.stream({
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          name: SECRET,
          callId: "private-tool",
          status: "running",
          text: SECRET,
          detail: { command: SECRET, output: SECRET, filePath: SECRET },
        },
      }),
    );
    await fixture.deliver(
      fixture.stream({
        type: "permission_requested",
        provider: "claude",
        request: { toolName: "Bash", input: SECRET },
      }),
    );
    await fixture.deliver(
      fixture.stream({
        type: "permission_resolved",
        provider: "claude",
        requestId: SECRET,
        resolution: { value: SECRET },
      }),
    );
    await fixture.deliver(
      fixture.stream({ type: "turn_failed", provider: "claude", error: SECRET }),
    );
    await fixture.deliver(
      fixture.stream({ type: "turn_canceled", provider: "claude", reason: SECRET }),
    );
    await fixture.deliver(fixture.events.text(`closing ${SECRET}`));
    await fixture.deliver(
      fixture.stream({
        type: "timeline",
        provider: "claude",
        item: { type: "reasoning", text: SECRET },
      }),
    );
    await fixture.deliver(
      fixture.stream({
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          name: SECRET,
          callId: "private-tool",
          status: "completed",
          output: SECRET,
        },
      }),
    );
    await fixture.deliver(fixture.events.turnCompleted());
    await runtime.timeline.flush();
    assert.equal((await fixture.execution(execution.id)).status, "running");
    const live = await runtime.database.listRunTimelineEvents(ORGANIZATION, runId, PAGE);
    assert.deepEqual(
      live.map((row) => row.kind),
      [
        "run_started",
        "step_started",
        "agent_started",
        "turn_started",
        "tool_started",
        "permission_requested",
        "permission_resolved",
        "turn_failed",
        "turn_canceled",
        "tool_finished",
        "turn_ended",
      ],
    );
    assert.equal(
      (await runtime.database.readRunTimelineState(ORGANIZATION, runId))?.sealedSeq,
      null,
    );
    await fixture.finishCall(execution.id, "completed", "finish-call");
    await fixture.lifecycle.completeAgentExecutionFromCallback({
      executionId: execution.id,
      token: deriveAgentExecutionCompletionToken("test-secret", execution.id),
    });
    await vi.waitFor(async () =>
      assert.equal(
        (await runtime.database.listRunTimelineEvents(ORGANIZATION, runId, PAGE)).filter(
          isStepFinished,
        ).length,
        1,
      ),
    );
    assert.equal((await runtime.database.findTriggerRunById(runId))?.status, "running");
    await runtime.observed.succeedTriggerRun(runId);
    await vi.waitFor(async () =>
      assert.ok((await runtime.database.readRunTimelineState(ORGANIZATION, runId))?.sealedSeq),
    );
    const rows = await runtime.database.listRunTimelineEvents(ORGANIZATION, runId, PAGE);
    assert.equal(rows.at(-1)?.kind, "run_finished");
    assert.equal(rows.find((row) => row.kind === "tool_started")?.data["tool"], "unnamed");
    assertNoSecret(JSON.stringify(rows));
    assertNoSecret(runtime.logs.text() + fixture.failures.text());
    assert.equal(runtime.timeline.activeExecutionCount(), 0);
  });

  it("records inferred completion but not its closing answer, and new activity cancels the first settle", async () => {
    const runtime = pipeline();
    const fixture = await turnEndFixture({
      database: runtime.observed,
      organizationId: ORGANIZATION,
      workflow: true,
      timeline: runtime.timeline,
      completeOnTurnEnd: true,
    });
    cleanup.push(() => fixture.lifecycle.stop());
    const { execution, step } = await fixture.dispatch();
    assert.ok(step);
    await runtime.observed.linkWorkflowStepRunExecution(step.id, execution.id);
    await fixture.endTurn(SECRET);
    await fixture.clock.advance(TURN_END_SETTLE_MS - 1);
    await fixture.deliver(fixture.events.toolCall("Bash", "running", "continued"));
    await fixture.clock.advance(2);
    assert.equal((await fixture.execution(execution.id)).status, "running");
    await fixture.deliver(fixture.events.toolCall("Bash", "completed", "continued"));
    await fixture.endTurn(SECRET);
    await fixture.clock.advance(TURN_END_SETTLE_MS + 1);
    assert.equal((await fixture.execution(execution.id)).status, "succeeded");
    await vi.waitFor(async () => {
      const ends = (
        await runtime.database.listRunTimelineEvents(ORGANIZATION, step.triggerRunId, PAGE)
      ).filter(isStepFinished);
      assert.equal(ends.length, 1);
      assert.equal(ends[0]?.data["completion"], "inferred_from_turn_end");
    });
    assertNoSecret(
      JSON.stringify(
        await runtime.database.listRunTimelineEvents(ORGANIZATION, step.triggerRunId, PAGE),
      ),
    );
  });

  it("begins capture when the lifecycle subscribes to a recovered execution and preserves durable old-call dedupe", async () => {
    const runtime = pipeline();
    const fixture = await turnEndFixture({
      database: runtime.observed,
      organizationId: ORGANIZATION,
      workflow: true,
      timeline: runtime.timeline,
    });
    cleanup.push(() => fixture.lifecycle.stop());
    const { execution, step } = await fixture.dispatch();
    assert.ok(step);
    await runtime.observed.linkWorkflowStepRunExecution(step.id, execution.id);
    await fixture.deliver(
      fixture.stream({ type: "thread_started", provider: "claude", sessionId: "old-session" }),
    );
    await fixture.deliver(fixture.events.toolCall("Read", "completed", "old-call"));
    for (let index = 0; index < 240; index += 1)
      await fixture.deliver(fixture.events.turnStarted());
    await runtime.timeline.flush();
    const before = await runtime.database.listRunTimelineEvents(
      ORGANIZATION,
      step.triggerRunId,
      PAGE,
    );
    assert.ok(before.length > 200);
    await fixture.lifecycle.stop();
    await runtime.reconciler.stop();
    await runtime.timeline.stop();
    const resumed = new RunTimeline(runtime.database, {
      bus: runtime.bus,
      scrub: runtime.scrub,
      maxEvents: 5000,
      retentionDays: 30,
    });
    const lifecycle = createDaemonDispatchLifecycle({
      database: runtime.database,
      timeline: resumed,
      connectionForDaemon: () => ({
        agents: fixture.agents,
        getProviderSnapshot: async () => {
          throw new Error("unused");
        },
        refreshProviderSnapshot: async () => {},
        validateAgentConfiguration: async () => ({ valid: true }),
      }),
      publicBaseUrl: "https://hub.test",
      completionTokenSecret: "test-secret",
      test: { deadlineClock: fixture.clock },
    });
    cleanup.push(async () => {
      await lifecycle.stop();
      await resumed.stop();
    });
    const daemon = await runtime.database.findDaemonForOrganization(ORGANIZATION, TEST_DAEMON_ID);
    assert.ok(daemon);
    fixture.state.status = "running";
    await lifecycle.recoverDaemon(daemon);
    await fixture.deliver(
      fixture.stream({ type: "thread_started", provider: "claude", sessionId: "new-session" }),
    );
    await fixture.deliver(fixture.events.toolCall("Read", "completed", "old-call"));
    await fixture.deliver(fixture.events.toolCall("Edit", "completed", "new-call"));
    await lifecycle.waitForPendingStreamHandlers(execution.id);
    await resumed.flush();
    const after = await runtime.database.listRunTimelineEvents(
      ORGANIZATION,
      step.triggerRunId,
      PAGE,
    );
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.filter((row) => row.kind === "agent_started").length, 1);
    assert.equal(after.filter((row) => row.data["callId"] === "old-call").length, 1);
    assert.equal(after.at(-1)?.data["callId"], "new-call");
  });

  it("seals terminal rows before the durable notification callback can observe the ended run", async () => {
    const runtime = pipeline();
    const fixture = await turnEndFixture({
      database: runtime.observed,
      organizationId: ORGANIZATION,
      workflow: true,
      timeline: runtime.timeline,
    });
    cleanup.push(() => fixture.lifecycle.stop());
    const { execution, step } = await fixture.dispatch();
    assert.ok(step);
    await runtime.observed.linkWorkflowStepRunExecution(step.id, execution.id);
    await fixture.lifecycle.completeAgentExecutionFromCallback({
      executionId: execution.id,
      token: deriveAgentExecutionCompletionToken("test-secret", execution.id),
    });
    await runtime.reconciler.reconcile(ORGANIZATION, step.triggerRunId);
    await runtime.database.succeedTriggerRun(step.triggerRunId);
    assert.equal(
      (await runtime.database.readRunTimelineState(ORGANIZATION, step.triggerRunId))?.sealedSeq,
      null,
    );
    const observed: string[] = [];
    const engine = new DurableWorkflowEngine({
      database: runtime.database,
      entitlements: createUnlimitedEntitlementsService(),
      timelineReconciler: runtime.reconciler,
      onWorkflowRunTerminal: async (run) => {
        const state = await runtime.database.readRunTimelineState(ORGANIZATION, run.id);
        const rows = await runtime.database.listRunTimelineEvents(ORGANIZATION, run.id, PAGE);
        assert.equal(run.status, "succeeded");
        assert.ok(state?.sealedSeq);
        assert.equal(rows.at(-1)?.kind, "run_finished");
        assert.equal(rows.at(-1)?.seq, state.sealedSeq);
        observed.push(run.id);
      },
    });
    cleanup.push(() => engine.stop());
    await engine.processAvailable();
    await vi.waitFor(() => assert.deepEqual(observed, [step.triggerRunId]));
    await engine.stop();
    assert.ok(
      (await runtime.database.findTriggerRunById(step.triggerRunId))?.outcome === "accepted",
    );
  });

  it("keeps completion and one delivered notification when every append fails, then the sweep repairs the swallowed failure", async () => {
    const runtime = pipeline();
    const fixture = await turnEndFixture({
      database: runtime.observed,
      organizationId: ORGANIZATION,
      workflow: true,
      timeline: runtime.timeline,
    });
    cleanup.push(() => fixture.lifecycle.stop());
    const { execution, step } = await fixture.dispatch();
    assert.ok(step);
    await runtime.observed.linkWorkflowStepRunExecution(step.id, execution.id);
    await runtime.timeline.flush();
    const append = runtime.database.appendRunTimelineEvent.bind(runtime.database);
    const writes = vi
      .spyOn(runtime.database, "appendRunTimelineEvent")
      .mockRejectedValue(new Error(SECRET));
    await fixture.lifecycle.completeAgentExecutionFromCallback({
      executionId: execution.id,
      token: deriveAgentExecutionCompletionToken("test-secret", execution.id),
    });
    await runtime.observed.succeedTriggerRun(step.triggerRunId);
    const notified: string[] = [];
    const engine = new DurableWorkflowEngine({
      database: runtime.observed,
      entitlements: createUnlimitedEntitlementsService(),
      timelineReconciler: runtime.reconciler,
      logger: runtime.logger,
      onWorkflowRunTerminal: async (run) => {
        notified.push(run.id);
      },
    });
    cleanup.push(() => engine.stop());
    await engine.processAvailable();
    await vi.waitFor(() => assert.deepEqual(notified, [step.triggerRunId]));
    await engine.stop();
    const terminal = await runtime.database.findTriggerRunById(step.triggerRunId);
    assert.ok(terminal?.outcome === "accepted");
    assert.equal(terminal.status, "succeeded");
    assert.ok(terminal.terminalNotificationDeliveredAt);
    assert.equal((await fixture.execution(execution.id)).status, "succeeded");
    assert.equal(
      (await runtime.database.readRunTimelineState(ORGANIZATION, step.triggerRunId))?.sealedSeq,
      null,
    );
    writes.mockImplementation(append);
    runtime.setNow(new Date(terminal.completedAt!.getTime() + 6000));
    await runtime.reconciler.sweep();
    const rows = await runtime.database.listRunTimelineEvents(
      ORGANIZATION,
      step.triggerRunId,
      PAGE,
    );
    assert.equal(rows.at(-1)?.kind, "run_finished");
    assert.ok(
      (await runtime.database.readRunTimelineState(ORGANIZATION, step.triggerRunId))?.sealedSeq,
    );
    assert.deepEqual(notified, [step.triggerRunId]);
    assertNoSecret(runtime.logs.text() + fixture.failures.text());
  });

  it("preserves provider start and final reactions when timeline writes all fail", async () => {
    async function scenario(capture: boolean) {
      const runtime = pipeline();
      const calls: string[] = [];
      const provider: TriggerProvider = {
        name: "capture",
        eventNames: ["manual.run"],
        match: async () => [],
        onAgentExecutionStarted: async () => {
          calls.push("started");
        },
        onAgentExecutionCompleted: async () => {
          calls.push("completed");
        },
      };
      const database = capture ? runtime.observed : runtime.database;
      if (capture)
        vi.spyOn(runtime.database, "appendRunTimelineEvent").mockRejectedValue(new Error(SECRET));
      const fixture = await turnEndFixture({
        database,
        organizationId: ORGANIZATION,
        workflow: true,
        providers: [provider],
        triggerContext: { provider: "capture" },
        ...(capture ? { timeline: runtime.timeline } : {}),
      });
      cleanup.push(() => fixture.lifecycle.stop());
      const { execution, step } = await fixture.dispatch();
      assert.ok(step);
      await database.linkWorkflowStepRunExecution(step.id, execution.id);
      const run = await database.findTriggerRunById(step.triggerRunId);
      assert.ok(run?.outcome === "accepted");
      await fixture.lifecycle.notifyWorkflowRunStarted(run);
      await fixture.lifecycle.completeAgentExecutionFromCallback({
        executionId: execution.id,
        token: deriveAgentExecutionCompletionToken("test-secret", execution.id),
      });
      await database.succeedTriggerRun(step.triggerRunId);
      const engine = new DurableWorkflowEngine({
        database,
        entitlements: createUnlimitedEntitlementsService(),
        logger: runtime.logger,
        ...(capture ? { timelineReconciler: runtime.reconciler } : {}),
        onWorkflowRunTerminal: (terminal) => fixture.lifecycle.notifyWorkflowRunTerminal(terminal),
      });
      cleanup.push(() => engine.stop());
      await engine.processAvailable();
      await vi.waitFor(() => assert.deepEqual(calls, ["started", "completed"]));
      await engine.stop();
      const terminal = await database.findTriggerRunById(step.triggerRunId);
      assert.ok(terminal?.outcome === "accepted");
      assert.ok(terminal.terminalNotificationDeliveredAt);
      assertNoSecret(runtime.logs.text());
      return { calls, status: terminal.status };
    }
    assert.deepEqual(await scenario(true), await scenario(false));
  });

  it("keeps 100 simultaneous runs within all budgets and loses no terminal row or seal", async () => {
    const runtime = pipeline();
    const fixtures = await Promise.all(
      Array.from({ length: 100 }, () =>
        turnEndFixture({
          database: runtime.observed,
          organizationId: ORGANIZATION,
          workflow: true,
          timeline: runtime.timeline,
        }),
      ),
    );
    cleanup.push(async () => {
      for (const fixture of fixtures) await fixture.lifecycle.stop();
    });
    const runs = await Promise.all(
      fixtures.map(async (fixture) => {
        const { execution, step } = await fixture.dispatch();
        assert.ok(step);
        await runtime.observed.linkWorkflowStepRunExecution(step.id, execution.id);
        return { fixture, execution, step };
      }),
    );
    await Promise.all(
      runs.map(async ({ fixture, execution, step }) => {
        for (let index = 0; index < 600; index += 1)
          await fixture.deliver(fixture.events.toolCall("Bash", "completed", `burst-${index}`));
        await fixture.lifecycle.completeAgentExecutionFromCallback({
          executionId: execution.id,
          token: deriveAgentExecutionCompletionToken("test-secret", execution.id),
        });
        await runtime.observed.succeedTriggerRun(step.triggerRunId);
        await runtime.reconciler.reconcile(ORGANIZATION, step.triggerRunId);
      }),
    );
    await runtime.timeline.flush(10000);
    for (const { step } of runs) {
      const rows = await runtime.database.listRunTimelineEvents(
        ORGANIZATION,
        step.triggerRunId,
        PAGE,
      );
      const state = await runtime.database.readRunTimelineState(ORGANIZATION, step.triggerRunId);
      assert.equal(rows.filter((row) => row.kind === "step_finished").length, 1);
      assert.equal(rows.filter((row) => row.kind === "run_finished").length, 1);
      assert.equal(rows.at(-1)?.kind, "run_finished");
      assert.equal(state?.sealedSeq, rows.at(-1)?.seq);
      assert.ok(state?.origin === "captured");
      assert.ok(rows.reduce((total, row) => total + jsonbBytes(row.data), 0) <= 248448);
      assert.ok(state.byteCount <= 196608 && state.stepEndBytes <= 51200);
    }
    assert.equal(runtime.timeline.depth(), 0);
    assert.equal(runtime.timeline.activeExecutionCount(), 0);
  }, 120000);
});
