import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, vi } from "vitest";
import { createApplicationRuntime } from "../application-runtime.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import {
  createActiveProjectConfiguration,
  enrollTestDaemon,
  TEST_DAEMON_ID,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import { deriveAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import type { AgentEvent } from "../daemons/agents/index.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import { readRunProgressSettings } from "../run-progress/settings.js";
import { readTimelineScrubValues } from "./secrets.js";

const ORGANIZATION = "composition-capture";
const AUTH_SECRET = ["fixture-auth-", "A9b8C7d6E5f4G3h2"].join("");
const TOKEN = ["gh", "p_", "M7a4L9x2Q5b8D1k6V3s0N4w9"].join("");
const DATABASE_SECRET =
  "postgresql://fixture-user:fixture-password@invalid.example/fixture-database";
const PRIVATE_KEY = ["fixture-private-key-", "P8r4I2v9A5t7E3k6"].join("");

async function stopWithStalledTimeline(
  runtime: Awaited<ReturnType<typeof createApplicationRuntime>>,
  database: Database,
  runId: string,
  isClosed: () => boolean,
): Promise<void> {
  const processing = runtime.hub.processWorkflowOutbox();
  await vi.advanceTimersByTimeAsync(0);
  let stopped = false;
  const stopping = runtime.stop().then(() => {
    stopped = true;
    return true;
  });
  await vi.advanceTimersByTimeAsync(15_000);
  assert.equal(stopped, true);
  assert.equal(isClosed(), true);
  await Promise.all([processing, stopping]);
  const terminal = await database.findTriggerRunById(runId);
  assert.ok(terminal?.outcome === "accepted" && terminal.terminalNotificationDeliveredAt);
}

describe("optional capture application composition", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ] as const)(
    "completes and stops a real workflow with capture=%s and stalled persistence=%s",
    async (enabled, stalled) => {
      const database = createMemoryDatabase({ organizationIds: [ORGANIZATION] });
      await enrollTestDaemon(database, ORGANIZATION);
      const { project, revision } = await createActiveProjectConfiguration(
        database,
        {
          environments: [
            { name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/fixture" },
          ],
          triggers: [
            {
              name: "capture",
              on: "manual.run",
              max_runtime: "1h",
              steps: [
                {
                  id: "work",
                  environment: "runner",
                  max_runtime: "10m",
                  idle_timeout: "1m",
                  agent: { provider: "claude" },
                  prompt: [{ text: "work" }],
                },
              ],
            },
          ],
        },
        { organizationId: ORGANIZATION },
      );
      const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
      const emit = (id: string, event: AgentEvent) => {
        for (const listener of listeners.get(id) ?? []) listener(event);
      };
      const connection: DaemonConnection = {
        agents: {
          create: async (id) => ({ id, workspaceId: "fixture-workspace", status: "idle" }),
          get: async (id) => ({ id, workspaceId: "fixture-workspace", status: "idle" }),
          restore: async () => true,
          control: async () => {},
          watch: async (id, listener) => {
            const subscriptions = listeners.get(id) ?? new Set();
            subscriptions.add(listener);
            listeners.set(id, subscriptions);
            listener({
              type: "agent_stream",
              agentId: id,
              timestamp: new Date().toISOString(),
              event: {
                type: "timeline",
                provider: "claude",
                item: {
                  type: "tool_call",
                  callId: "before-prompt",
                  name: "Read",
                  status: "completed",
                },
              },
            });
            return () => {
              subscriptions.delete(listener);
            };
          },
          send: async (id) => {
            emit(id, {
              type: "agent_stream",
              agentId: id,
              timestamp: new Date().toISOString(),
              event: { type: "thread_started", provider: "claude", sessionId: PRIVATE_KEY },
            });
            emit(id, {
              type: "agent_stream",
              agentId: id,
              timestamp: new Date().toISOString(),
              event: {
                type: "turn_failed",
                provider: "claude",
                error: [TOKEN, DATABASE_SECRET, PRIVATE_KEY, AUTH_SECRET].join(" "),
              },
            });
            emit(id, {
              type: "agent_stream",
              agentId: id,
              timestamp: new Date().toISOString(),
              event: {
                type: "timeline",
                provider: "claude",
                item: {
                  type: "tool_call",
                  callId: "after-prompt",
                  name: "Bash",
                  status: "completed",
                  detail: { command: TOKEN },
                },
              },
            });
          },
        },
        getProviderSnapshot: async () => {
          throw new Error("unused");
        },
        refreshProviderSnapshot: async () => {},
        validateAgentConfiguration: async () => ({ valid: true }),
      };
      let closed = false;
      const release = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      if (stalled) {
        const append = database.appendRunTimelineEvent.bind(database);
        vi.spyOn(database, "appendRunTimelineEvent").mockImplementation(async (input) => {
          reached.resolve();
          await release.promise;
          return append(input);
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      }
      const runtime = await createApplicationRuntime({
        database,
        auth: null,
        entitlements: createUnlimitedEntitlementsService(),
        billing: null,
        daemonConnectionForId: (id) => (id === TEST_DAEMON_ID ? connection : undefined),
        publicBaseUrl: "https://hub.test",
        completionTokenSecret: AUTH_SECRET,
        runProgress: readRunProgressSettings(enabled ? { PASEO_HUB_RUN_TIMELINE: "true" } : {}),
        timelineScrubValues: readTimelineScrubValues(
          {
            GITHUB_NOTIFICATIONS_TOKEN: TOKEN,
            DATABASE_URL: DATABASE_SECRET,
            PUBLIC_LABEL: "not-sensitive",
          },
          [{ privateKey: PRIVATE_KEY, clientId: "not-sensitive" }],
        ),
        close: async () => {
          closed = true;
          await database.close();
        },
      });
      try {
        assert.deepEqual(
          runtime.hub.resourceCounts(),
          enabled
            ? { executionSubscriptions: 0, timelineQueueDepth: 0 }
            : { executionSubscriptions: 0 },
        );
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
          configuredTriggerName: "capture",
          prompt: "work",
          inputs: {},
          triggerContext: {},
          outputContext: {},
          deadlineAt: new Date(Date.now() + 3600000),
          stepIds: ["work"],
        });
        await runtime.hub.processWorkflowOutbox();
        await vi.waitFor(async () =>
          assert.equal((await database.findWorkflowStepRunByTriggerRun(run.id))?.status, "running"),
        );
        const step = await database.findWorkflowStepRunByTriggerRun(run.id);
        assert.ok(step?.agentExecutionId);
        await vi.waitFor(async () => {
          const current = await database.findAgentExecutionById(step.agentExecutionId!);
          assert.ok(current?.daemonAgentId);
          assert.equal(current.status, "running");
        });
        const execution = await database.findAgentExecutionById(step.agentExecutionId);
        assert.ok(execution?.daemonAgentId);
        assert.ok(runtime.hub.daemonModule);
        await vi.waitFor(async () =>
          assert.equal((await database.findAgentExecutionById(execution.id))?.status, "running"),
        );
        await runtime.hub.daemonModule.lifecycle.waitForPendingStreamHandlers(execution.id);
        if (enabled && !stalled) {
          await vi.waitFor(async () => {
            const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, {
              afterSeq: 0,
              limit: 100,
            });
            let finished = 0;
            for (const row of rows) if (row.kind === "tool_finished") finished += 1;
            assert.equal(finished, 1);
          });
        }
        await runtime.hub.daemonModule.lifecycle.completeAgentExecutionFromCallback({
          executionId: execution.id,
          token: deriveAgentExecutionCompletionToken(AUTH_SECRET, execution.id),
        });
        if (stalled) {
          await reached.promise;
          await stopWithStalledTimeline(runtime, database, run.id, () => closed);
          return;
        }
        await runtime.hub.processWorkflowOutbox();
        await vi.waitFor(async () => {
          const terminal = await database.findTriggerRunById(run.id);
          assert.ok(terminal?.outcome === "accepted");
          assert.equal(terminal.status, "succeeded");
          assert.ok(terminal.terminalNotificationDeliveredAt);
        });
        const rows = await database.listRunTimelineEvents(ORGANIZATION, run.id, {
          afterSeq: 0,
          limit: 100,
        });
        const state = await database.readRunTimelineState(ORGANIZATION, run.id);
        if (enabled) {
          assert.ok(state?.sealedSeq);
          assert.equal(rows.at(-1)?.kind, "run_finished");
          assert.equal(rows.filter((row) => row.kind === "step_finished").length, 1);
          assert.equal(rows.filter((row) => row.kind === "agent_started").length, 1);
          assert.equal(
            rows.some((row) => row.data["callId"] === "before-prompt"),
            false,
          );
          assert.equal(
            rows.find((row) => row.kind === "tool_finished")?.data["callId"],
            "after-prompt",
          );
          const stored = JSON.stringify(rows);
          for (const secret of [TOKEN, DATABASE_SECRET, PRIVATE_KEY, AUTH_SECRET]) {
            for (let index = 0; index + 8 <= secret.length; index += 1)
              assert.equal(stored.includes(secret.slice(index, index + 8)), false);
          }
        } else {
          assert.deepEqual(rows, []);
          assert.equal(state, undefined);
        }
      } finally {
        release.resolve();
        await runtime.stop();
      }
      assert.equal(closed, true);
      assert.deepEqual(
        runtime.hub.resourceCounts(),
        enabled
          ? { executionSubscriptions: 0, timelineQueueDepth: 0 }
          : { executionSubscriptions: 0 },
      );
    },
  );
});
