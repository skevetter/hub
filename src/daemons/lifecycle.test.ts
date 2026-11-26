import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { deriveAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import { AgentSessions } from "../agent-sessions/index.js";
import { DaemonResponseLostError } from "./protocol.js";
import type { AgentConnection } from "./agents/index.js";
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { DaemonEvent, DaemonConnection } from "./protocol.js";
import {
  createDaemonDispatchLifecycle,
  DaemonDispatchFailure,
  durableExecutionId,
  executionWorkspaceTitle,
  type DaemonDispatchLifecycle,
} from "./lifecycle.js";
import { createDurableWorkflowHandler } from "../workflows/engine.js";
import type { TriggerProvider } from "../triggers/index.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import type { DaemonRecord } from "../db/types.js";
import { createLogger, serializeError } from "../logger.js";
import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@getpaseo/protocol/agent-title-limits";
import { assertOneFailure, FailureLogStream } from "../test-utils/failure-logs.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import {
  GITHUB_BILLING_DENIAL,
  githubBillingTriggerContext,
} from "../test-utils/github-billing-notice.js";
import { createGitHubTriggerProvider } from "../triggers/github/provider.js";
import type { GitHubCommentClient } from "../triggers/github/reply.js";
import { IDLE_TIMEOUT_MS, turnEndFixture } from "./test-utils/turn-end-fixture.js";

const DAEMON_ID = "daemon-ack-test";
const AGENT_ID = "agent-ack-test";
const EXECUTION_ID = "00000000-0000-4000-8000-000000000001";
const PEER_ID = "00000000-0000-4000-8000-000000000002";
const ACKNOWLEDGED_AT = new Date("2026-01-01T00:00:01.000Z");

describe("stop interrupt recovery", () => {
  it.each([
    { outcome: "target_gone", status: "revoked", expired: false, sessionOutcome: undefined },
    { outcome: "delivery_unconfirmed", status: "active", expired: true, sessionOutcome: undefined },
    { outcome: "coalesced", status: "active", expired: false, sessionOutcome: "coalesced" },
    { outcome: "confirmed", status: "active", expired: false, sessionOutcome: [PEER_ID] },
  ] as const)("completes as $outcome and releases the claim once", async (scenario) => {
    const database = createMemoryDatabase();
    await seedStopExecution(database);
    vi.spyOn(database, "findDaemonById").mockResolvedValue({
      ...daemonRecord(),
      status: scenario.status,
    });
    const store = database.stopInterrupts;
    const claimOriginal = store.claim.bind(store);
    const claim = vi.spyOn(store, "claim").mockImplementation(async (id, token, generation) => {
      const acquired = await claimOriginal(id, token, generation);
      assert.ok(acquired);
      return { state: { approvedPeerIds: [PEER_ID] }, expired: scenario.expired };
    });
    const complete = vi.spyOn(store, "complete");
    const release = vi.spyOn(store, "release");
    const sessionOutcome = scenario.sessionOutcome;
    const session = vi
      .spyOn(AgentSessions.prototype, "interruptStoppedExecution")
      .mockResolvedValue(
        typeof sessionOutcome === "string" ? sessionOutcome : sessionOutcome?.slice(),
      );
    const lifecycle = createLifecycle(database, new AcknowledgementConnection());
    try {
      await lifecycle.recoverPendingHubActions(DAEMON_ID);

      assert.equal(claim.mock.calls.length, 1);
      const call = claim.mock.calls[0];
      assert.ok(call);
      const [id, token, generation] = call;
      assert.equal(id, EXECUTION_ID);
      assert.ok(token);
      assert.equal(generation, null);
      assert.deepEqual(complete.mock.calls, [[EXECUTION_ID, token, scenario.outcome]]);
      assert.deepEqual(release.mock.calls, [[EXECUTION_ID, token]]);
      const [completedAt] = complete.mock.invocationCallOrder;
      const [releasedAt] = release.mock.invocationCallOrder;
      assert.ok(completedAt);
      assert.ok(releasedAt);
      assert.ok(completedAt < releasedAt);
      assert.equal(session.mock.calls.length, sessionOutcome === undefined ? 0 : 1);
      const peer = await database.findAgentExecutionById(PEER_ID);
      assert.ok(peer);
      assert.equal(peer.status, scenario.outcome === "confirmed" ? "failed" : "spawning");
      if (scenario.outcome === "confirmed") {
        assert.deepEqual(peer.result, { status: "failed", reason: "agent_interrupted" });
        assert.equal(peer.hubAction, null);
      }
    } finally {
      session.mockRestore();
      await lifecycle.stop();
    }
  });
});

async function seedStopExecution(database: ReturnType<typeof createMemoryDatabase>): Promise<void> {
  const input = {
    organizationId: "org-stop-test",
    projectId: "project-stop-test",
    machineId: null,
    daemonId: DAEMON_ID,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: "revision-stop-test",
  };
  await database.insertAgentExecution({ ...input, id: EXECUTION_ID });
  await database.insertAgentExecution({ ...input, id: PEER_ID });
  await database.transitionAgentExecution(EXECUTION_ID, "failed", {
    result: { status: "canceled" },
    hubAction: "interrupt",
  });
}

describe("execution workspace title", () => {
  const executionId = "e6a296d1-1f0c-4c4e-9b2a-000000000000";

  it("defaults to the trigger name and the execution prefix", () => {
    assert.equal(
      executionWorkspaceTitle({ triggerName: "paseo-pr-triage" }, executionId),
      "Hub · paseo-pr-triage · e6a296d1",
    );
  });

  it("prefers an authored title, trimmed and clamped to the daemon limit", () => {
    assert.equal(
      executionWorkspaceTitle(
        { triggerName: "intake", title: "  Intake · e6a296d1  " },
        executionId,
      ),
      "Intake · e6a296d1",
    );
    assert.equal(
      executionWorkspaceTitle(
        { triggerName: "intake", title: `${"x".repeat(MAX_EXPLICIT_AGENT_TITLE_CHARS)} tail` },
        executionId,
      ),
      "x".repeat(MAX_EXPLICIT_AGENT_TITLE_CHARS),
    );
    assert.equal(
      executionWorkspaceTitle({ triggerName: "intake", title: "   " }, executionId),
      "Hub · intake · e6a296d1",
    );
  });
});

it("re-arms the idle deadline when a concurrent refresh wins over expiry", async () => {
  const organizationId = "org-deadline-rearm";
  const database = createMemoryDatabase({ organizationIds: [organizationId] });
  const fixture = await turnEndFixture({ database, organizationId });
  try {
    const { execution } = await fixture.dispatch();
    await fixture.deliver(fixture.events.status("idle"));
    const retryDelay = 1_000;
    const transitionOriginal = database.transitionAgentExecution.bind(database);
    const transition = vi
      .spyOn(database, "transitionAgentExecution")
      .mockImplementationOnce(async (id, status, fields) => {
        const now = fixture.clock.now();
        await database.setAgentExecutionIdleDeadline(
          id,
          new Date(now + retryDelay),
          new Date(now - 1),
          new Date(now),
        );
        return transitionOriginal(id, status, fields);
      });

    await fixture.clock.advance(IDLE_TIMEOUT_MS + retryDelay - 1);

    assert.equal(transition.mock.calls.length, 1);
    assert.equal((await fixture.execution(execution.id)).status, "running");
    await fixture.clock.advance(1);

    assert.equal(transition.mock.calls.length, 2);
    assert.deepEqual((await fixture.execution(execution.id)).result, {
      status: "failed",
      reason: "idle_timeout",
    });
  } finally {
    await fixture.lifecycle.stop();
  }
});

describe("durable Hub action acknowledgement state", () => {
  it("keeps the classified dispatch code in redacted error logs", () => {
    const diagnostic = serializeError(
      new DaemonDispatchFailure("github_authority_unavailable", {
        cause: Object.assign(new Error("credential detail must not be logged"), {
          code: "github_authority_unavailable",
        }),
      }),
    );

    assert.equal(diagnostic["code"], "github_authority_unavailable");
    const cause = diagnostic["cause"];
    assert.ok(typeof cause === "object" && cause !== null);
    assert.equal(Reflect.get(cause, "code"), "github_authority_unavailable");
    assert.equal(JSON.stringify(diagnostic).includes("credential detail"), false);
  });

  it.each(["spawning", "running"] as const)(
    "recovers %s delivery and observation when reconnects overlap after creation",
    async (status) => {
      const database = createMemoryDatabase();
      const daemon = daemonRecord();
      const intent: LaunchMachineIntent = {
        kind: "launch_machine",
        organizationId: "org-reconnect",
        projectId: "project-reconnect",
        triggerRunId: "run-reconnect",
        triggerName: "reconnect",
        environmentName: "runner",
        environment: {
          kind: "daemon",
          daemonId: daemon.id,
          authoredSlug: daemon.slug,
          cwd: "/repo",
        },
        agent: { provider: "codex" },
        prompt: "Full prompt ".repeat(100),
        allowOutputs: [],
        autoArchive: false,
        background: false,
        triggerContext: {},
        outputContext: {},
        configurationRevisionId: "revision-reconnect",
        hubConfig: {},
      };
      await database.insertAgentExecution({
        id: EXECUTION_ID,
        organizationId: intent.organizationId,
        projectId: intent.projectId,
        machineId: null,
        daemonId: daemon.id,
        triggerContext: {},
        outputContext: {},
        configurationRevisionId: intent.configurationRevisionId,
        launchIntent: intent,
      });
      if (status === "running") await database.transitionAgentExecution(EXECUTION_ID, "running");
      let started!: () => void;
      const sending = new Promise<void>((resolve) => {
        started = resolve;
      });
      let loseResponse!: (error: Error) => void;
      const response = new Promise<void>((_resolve, reject) => {
        loseResponse = reject;
      });
      const deliveries = new Map<string, string>();
      let creates = 0;
      let currentSends = 0;
      let subscriptions = 0;
      const agent = { id: AGENT_ID, workspaceId: "workspace-reconnect", status: "idle" as const };
      const agents: AgentConnection = {
        create: async () => {
          creates++;
          return agent;
        },
        get: async () => agent,
        restore: async () => true,
        control: async () => {},
        watch: async () => {
          subscriptions++;
          return () => {
            subscriptions--;
          };
        },
        send: async (_agentId, messageId, text) => {
          deliveries.set(messageId, text);
          started();
          await response;
        },
      };
      let connection: DaemonConnection = {
        agents,
        getProviderSnapshot: async () => {
          throw new Error("Provider catalog is not used");
        },
        refreshProviderSnapshot: async () => {},
        validateAgentConfiguration: async () => ({ valid: true }),
      };
      const lifecycle = createDaemonDispatchLifecycle({
        database,
        connectionForDaemon: () => connection,
        publicBaseUrl: "https://hub.test",
        completionTokenSecret: "test-secret",
      });
      try {
        const original = lifecycle.recoverDaemon(daemon);
        await sending;
        connection = {
          ...connection,
          agents: {
            ...agents,
            send: async (_agentId, messageId, text) => {
              currentSends++;
              assert.equal(deliveries.get(messageId), text);
              deliveries.set(messageId, text);
            },
          },
        };
        const replacement = lifecycle.recoverDaemon(daemon);
        loseResponse(new DaemonResponseLostError());
        await Promise.all([original, replacement]);
        assert.equal(currentSends, 1);
        assert.equal(creates, 1);
        assert.deepEqual([...deliveries], [[EXECUTION_ID, intent.prompt]]);
        assert.equal((await database.findAgentExecutionById(EXECUTION_ID))?.status, "running");
        assert.equal(lifecycle.activeExecutionObservationCount(), 1);
        assert.equal(subscriptions, 1);
      } finally {
        await lifecycle.stop();
      }
      assert.equal(subscriptions, 0);
    },
  );

  it("logs a daemon execution recovery failure exactly once", async () => {
    const canary = "daemon-lifecycle-secret-4c09";
    const database = createMemoryDatabase();
    const daemon = daemonRecord();
    const executionId = "00000000-0000-4000-8000-0000000000f1";
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "organization-lifecycle-log",
      projectId: "project-lifecycle-log",
      machineId: null,
      daemonId: daemon.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: "revision-lifecycle-log",
    });
    vi.spyOn(database, "findAgentExecutionById").mockRejectedValueOnce(new Error(canary));
    const stream = new FailureLogStream();
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => new AcknowledgementConnection(),
      publicBaseUrl: "http://hub.test",
      test: { logger: createLogger(stream) },
    });

    await lifecycle.recoverDaemon(daemon);

    assertOneFailure(stream, {
      operation: "daemon.execution.recover",
      component: "daemons",
      canary,
    });
    await lifecycle.stop();
  });

  it("owns a rejected daemon event without leaking it to the process", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    vi.spyOn(fixture.database, "recordAgentExecutionHubAcknowledgement").mockRejectedValueOnce(
      new Error("database event write failed"),
    );

    try {
      await fixture.connection.emitObserved(turnCompleted());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("defers workflow-owned terminal provider failure notification to the outbox", async () => {
    const database = createMemoryDatabase();
    let failureHooks = 0;
    const provider: TriggerProvider = {
      name: "test",
      eventNames: ["manual.test"],
      match: () => Promise.resolve([]),
      onAgentExecutionFailed: async () => {
        failureHooks += 1;
      },
    };
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => undefined,
      providers: [provider],
    });
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-workflow-terminal",
        projectId: "project-workflow-terminal",
        configurationRevisionId: "revision-workflow-terminal",
        providerEventReceiptId: "receipt-workflow-terminal",
        configuredTriggerName: "terminal",
        prompt: "raw",
        inputs: {},
        triggerContext: { provider: "test" },
        outputContext: { provider: "test" },
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;
    const step = (await database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await database.insertAgentExecution({
      id: "00000000-0000-4000-8000-0000000000dd",
      organizationId: run.organizationId,
      projectId: run.projectId,
      machineId: null,
      daemonId: DAEMON_ID,
      triggerContext: run.triggerContext,
      outputContext: run.outputContext,
      configurationRevisionId: run.configurationRevisionId,
      workflowStepRunId: step.id,
      deadlineAt: new Date("2000-01-01T00:00:00.000Z"),
      idleDeadlineAt: new Date("2000-01-01T00:00:00.000Z"),
    });
    await database.linkWorkflowStepRunExecution(step.id, execution.id);

    await lifecycle.recoverAgentExecutionDeadlines();

    assert.equal(failureHooks, 0);
    const pendingDelivery = await database.findTriggerRunById(run.id);
    assert.equal(pendingDelivery?.status, "timed_out");
    assert.equal(pendingDelivery?.outcome, "accepted");
    assert.equal(
      pendingDelivery?.outcome === "accepted"
        ? pendingDelivery.terminalNotificationDeliveredAt
        : null,
      null,
    );

    const engine = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [],
      onWorkflowRunTerminal: (terminalRun) => lifecycle.notifyWorkflowRunTerminal(terminalRun),
    }).engine;
    await engine.processAvailable();

    const delivered = await database.findTriggerRunById(run.id);
    assert.equal(failureHooks, 1);
    assert.equal(
      delivered?.outcome === "accepted"
        ? delivered.terminalNotificationDeliveredAt !== null
        : false,
      true,
    );
    await lifecycle.stop();
  });

  it("ignores unrelated failed or canceled tools when finish_execution completes", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

    await fixture.connection.emit(toolCall("shell-call", "shell", "failed"));
    await fixture.connection.emit(toolCall("other-call", "other", "canceled"));
    await fixture.connection.emit(
      toolCall("finish-call", "mcp__hub__finish_execution", "completed"),
    );
    await fixture.connection.emit(
      toolCall("finish-call-retry", "hub.finish_execution", "canceled"),
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.connection.emit(agentIdle());

    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.callId, "finish-call");
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.status, "completed");
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });

  it.each([
    { description: "ordinary finish", reads: 3, records: true },
    { description: "continued finish", continuationKey: "continued", reads: 3, records: false },
    { description: "unrelated tool", name: "shell", reads: 2, records: false },
    { description: "unrecognised status", status: "unknown", reads: 2, records: false },
    { description: "missing call ID", missingCallId: true, reads: 2, records: false },
  ])("checks acknowledgement reads and writes for $description", async (scenario) => {
    const organizationId = "org-finish-ack";
    const database = createMemoryDatabase({ organizationIds: [organizationId] });
    const { continuationKey } = scenario;
    const fixture = await turnEndFixture({
      database,
      organizationId,
      ...(continuationKey === undefined ? {} : { continuationKey }),
    });
    try {
      const { execution } = await fixture.dispatch();
      const read = vi.spyOn(database, "findAgentExecutionById");
      const record = vi.spyOn(database, "recordAgentExecutionHubAcknowledgement");
      const event = fixture.stream({
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          name: scenario.name ?? "mcp__hub__finish_execution",
          status: scenario.status ?? "completed",
          ...(scenario.missingCallId === true ? {} : { callId: "finish-call" }),
        },
      });
      await fixture.deliver(event);

      assert.deepEqual(
        read.mock.calls,
        Array.from({ length: scenario.reads }, () => [execution.id]),
      );
      assert.deepEqual(
        record.mock.calls,
        scenario.records
          ? [
              [
                execution.id,
                {
                  kind: "finish_execution",
                  callId: "finish-call",
                  status: "completed",
                  observedAt: new Date(event.timestamp),
                },
              ],
            ]
          : [],
      );
    } finally {
      await fixture.lifecycle.stop();
    }
  });

  it("archives after finish_execution reported by the omp provider's bridged tool title", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

    await fixture.connection.emit(toolCall("finish-call", "hub / finish_execution", "completed"));
    await fixture.connection.emit(turnCompleted());
    await fixture.connection.emit(agentIdle());

    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.equal(execution?.hubActionAcknowledgements.finishExecutionCall?.callId, "finish-call");
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    await fixture.lifecycle.stop();
  });

  it.each(["running", "canceled"] as const)(
    "does not archive while finish_execution is %s",
    async (status) => {
      const fixture = await acknowledgementFixture();
      await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);

      await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", status));
      await fixture.connection.emit(turnCompleted());
      await fixture.connection.emit(agentIdle());

      const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
      assert.deepEqual(fixture.connection.actions, []);
      assert.equal(execution?.hubActionReadyAt, null);
      assert.equal(execution?.hubActionCompletedAt, null);
      await fixture.lifecycle.stop();
    },
  );

  it("resumes durable partial signals across restart and archives exactly once", async () => {
    const fixture = await acknowledgementFixture();
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    await fixture.connection.emit(toolCall("finish-call", "hub.finish_execution", "completed"));
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.equal(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionReadyAt,
      null,
    );
    await fixture.connection.emit(turnCompleted());
    await fixture.lifecycle.stop();

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    assert.notEqual(
      (await fixture.database.findAgentExecutionById(EXECUTION_ID))?.hubActionAcknowledgements
        .terminalAt,
      null,
    );
    await fixture.connection.emit(agentIdle());

    fixture.lifecycle = createLifecycle(fixture.database, fixture.connection);
    await fixture.lifecycle.recoverPendingHubActions(DAEMON_ID);
    const execution = await fixture.database.findAgentExecutionById(EXECUTION_ID);
    assert.deepEqual(fixture.connection.actions, ["archive"]);
    assert.notEqual(execution?.hubActionReadyAt, null);
    assert.notEqual(execution?.hubActionCompletedAt, null);
    await fixture.lifecycle.stop();
  });
});

async function acknowledgementFixture() {
  const database = createMemoryDatabase({ now: () => new Date("2026-01-01T00:00:00.000Z") });
  await database.insertAgentExecution({
    id: EXECUTION_ID,
    organizationId: "org-ack-test",
    projectId: "project-ack-test",
    machineId: null,
    daemonId: DAEMON_ID,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: "revision-ack-test",
  });
  await database.saveAgentSession({
    id: "session",
    organizationId: "org-ack-test",
    projectId: "project-ack-test",
    continuationKey: null,
    daemonId: DAEMON_ID,
    agentId: AGENT_ID,
    workspaceId: "workspace",
    compatibility: "test",
    capabilityTokenHash: "test",
    tools: [],
    creationOptions: {
      provider: "codex",
      cwd: "/workspace",
      env: {},
      toolPolicy: { preapproved: [] },
    },
  });
  await database.attachExecutionToSession(EXECUTION_ID, "session");
  await database.attachAgentToExecution(EXECUTION_ID, DAEMON_ID, AGENT_ID);
  await database.transitionAgentExecution(EXECUTION_ID, "succeeded", {
    completedByAgent: true,
    hubAction: "archive",
  });
  const connection = new AcknowledgementConnection();
  return {
    database,
    connection,
    lifecycle: createLifecycle(database, connection),
  };
}

function createLifecycle(
  database: Awaited<ReturnType<typeof createMemoryDatabase>>,
  connection: AcknowledgementConnection,
): DaemonDispatchLifecycle {
  return createDaemonDispatchLifecycle({
    database,
    publicBaseUrl: "http://hub.test",
    completionTokenSecret: "test-secret",
    connectionForDaemon: (daemonId) => (daemonId === DAEMON_ID ? connection : undefined),
  });
}

class AcknowledgementConnection implements DaemonConnection {
  readonly agents: AgentConnection = {
    create: async () => {
      throw new Error("not used");
    },
    get: async () => {
      throw new Error("not used");
    },
    send: async () => {
      throw new Error("not used");
    },
    restore: async () => {
      throw new Error("not used");
    },
    control: async (_agentId, _workspaceId, action) => {
      this.actions.push(action);
    },
    watch: async (_agentId, listener) =>
      this.on((event) => {
        if (event.type === "agent_stream") listener(event);
        else
          listener({
            type: "agent_update",
            agent: { id: event.agentId, workspaceId: "workspace", status: event.agent.status },
            timestamp: event.timestamp,
          });
      }),
  };
  readonly actions: Array<"interrupt" | "archive"> = [];
  private readonly handlers = new Set<(event: DaemonEvent) => void | Promise<void>>();

  on(handler: (event: DaemonEvent) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async emit(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) await handler(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async emitObserved(event: DaemonEvent): Promise<void> {
    for (const handler of this.handlers) {
      await Promise.resolve(handler(event)).catch(() => undefined);
    }
  }

  async createAgent(): Promise<never> {
    throw new Error("not used");
  }

  async getProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }

  async refreshProviderSnapshot(): Promise<never> {
    throw new Error("not used");
  }

  async validateAgentConfiguration(): Promise<never> {
    throw new Error("not used");
  }
}

function toolCall(
  callId: string,
  name: string,
  status: "running" | "completed" | "failed" | "canceled",
): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: {
      type: "timeline",
      provider: "test",
      item: { type: "tool_call", callId, name, status },
    },
  } as DaemonEvent;
}

describe("dispatch retries transient database failures", () => {
  const poolTimeout = () => new Error("timeout exceeded when trying to connect");

  async function dispatchFixture() {
    const database = createMemoryDatabase({ organizationIds: ["org-1"] });
    await enrollTestDaemon(database, "org-1");
    const project = await database.createProject({
      organizationId: "org-1",
      name: "Dispatch",
      slug: "dispatch",
      createdByUserId: "user-1",
    });
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "dispatch-test",
      createdByUserId: "user-1",
    });
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId: "org-1",
        projectId: project.id,
        configurationRevisionId: revision.id,
        providerEventReceiptId: "receipt-dispatch",
        configuredTriggerName: "dispatch",
        prompt: "raw",
        inputs: {},
        triggerContext: {},
        outputContext: {},
        deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
        stepIds: ["step"],
      })
    ).run;
    const intent: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId: "org-1",
      projectId: project.id,
      triggerRunId: run.id,
      triggerName: "dispatch",
      environmentName: "runner",
      environment: {
        kind: "daemon",
        daemonId: TEST_DAEMON_ID,
        authoredSlug: "runner",
        cwd: "/repo",
      },
      agent: { provider: "codex" },
      prompt: "Do the work",
      allowOutputs: [],
      autoArchive: false,
      background: false,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: revision.id,
      hubConfig: {},
    };
    const calls = { creates: [] as string[], sends: [] as string[] };
    const agent = { id: AGENT_ID, workspaceId: "workspace-dispatch", status: "idle" as const };
    const agents: AgentConnection = {
      create: async (key) => {
        calls.creates.push(key);
        return agent;
      },
      get: async () => agent,
      restore: async () => true,
      control: async () => {},
      watch: async () => () => {},
      send: async (_agentId, messageId) => {
        calls.sends.push(messageId);
      },
    };
    const sleeps: number[] = [];
    const stream = new FailureLogStream();
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => ({
        agents,
        getProviderSnapshot: async () => {
          throw new Error("not used");
        },
        refreshProviderSnapshot: async () => {},
        validateAgentConfiguration: async () => ({ valid: true }),
      }),
      publicBaseUrl: "https://hub.test",
      completionTokenSecret: "test-secret",
      test: {
        logger: createLogger(stream),
        retry: {
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds);
          },
          random: () => 1,
        },
      },
    });
    return { database, intent, lifecycle, calls, sleeps, stream };
  }

  async function standaloneBillingFixture(
    findIssueCommentByMarker: GitHubCommentClient["findIssueCommentByMarker"],
  ) {
    const { database, intent, lifecycle: unusedLifecycle, stream } = await dispatchFixture();
    await unusedLifecycle.stop();
    const context = githubBillingTriggerContext();
    const createIssueComment = vi.fn(async () => ({ id: 2 }));
    const provider = createGitHubTriggerProvider({
      configurationStoreForProject: () => {
        throw new Error("not used");
      },
      reactions: { createReaction: async () => null, deleteReaction: async () => {} },
      comments: { findIssueCommentByMarker, createIssueComment },
      billingUrlForOrganization: async () => "https://hub.test/settings/billing",
    });
    const failure = new DaemonDispatchFailure(GITHUB_BILLING_DENIAL);
    const connection = new AcknowledgementConnection();
    vi.spyOn(connection.agents, "create").mockRejectedValue(failure);
    const createBillingLifecycle = () =>
      createDaemonDispatchLifecycle({
        database,
        connectionForDaemon: () => connection,
        providers: [provider],
        publicBaseUrl: "https://hub.test",
        completionTokenSecret: "test-secret",
        test: { logger: createLogger(stream) },
      });
    const launch = { ...intent, triggerContext: context, outputContext: context };
    async function handoff() {
      const lifecycle = createBillingLifecycle();
      try {
        return await lifecycle.handoffLaunchMachineIntent(launch);
      } finally {
        await lifecycle.stop();
      }
    }
    return {
      database,
      launch,
      createBillingLifecycle,
      createIssueComment,
      failure,
      handoff,
      stream,
    };
  }

  it("skips a standalone execution limit notice when the GitHub marker already exists", async () => {
    const findIssueCommentByMarker = vi.fn(async ({ marker }: { marker: string }) =>
      marker === "<!-- paseo-notice:execution-limit:test%2Ddelivery:92 -->" ? 1 : undefined,
    );
    const fixture = await standaloneBillingFixture(findIssueCommentByMarker);
    const lifecycle = fixture.createBillingLifecycle();
    try {
      await assert.rejects(
        () => lifecycle.dispatchLaunchMachineIntent(fixture.launch),
        fixture.failure,
      );
      assert.equal(findIssueCommentByMarker.mock.calls.length, 1);
      assert.equal(fixture.createIssueComment.mock.calls.length, 0);
    } finally {
      await lifecycle.stop();
    }
  });

  it("posts once when a standalone failure is redelivered after a lookup error", async () => {
    const findIssueCommentByMarker = vi
      .fn<GitHubCommentClient["findIssueCommentByMarker"]>()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValue(undefined);
    const fixture = await standaloneBillingFixture(findIssueCommentByMarker);
    const first = await fixture.handoff();
    assert.equal(findIssueCommentByMarker.mock.calls.length, 1);
    assert.equal(fixture.createIssueComment.mock.calls.length, 0);
    assert.ok(
      fixture.stream
        .records()
        .some((record) => record["operation"] === "daemon.provider.execution-fail"),
    );
    assert.equal(
      (await fixture.database.findAgentExecutionById(first.execution.id))?.status,
      "failed",
    );

    // A missing daemon during a new handoff drives the existing failure through the hook again.
    vi.spyOn(fixture.database, "findDaemonForOrganization").mockResolvedValue(undefined);
    const second = await fixture.handoff();
    assert.equal(second.execution.id, first.execution.id);
    assert.equal(findIssueCommentByMarker.mock.calls.length, 2);
    assert.equal(fixture.createIssueComment.mock.calls.length, 1);
  });

  it.each([
    { phase: "claimed", deadlineAt: null, message: "durable execution cannot be resumed" },
    {
      phase: "prepared",
      deadlineAt: new Date("2099-01-01T00:00:00.000Z"),
      message: "durable execution has no deadline",
    },
  ])("rejects a $phase durable dispatch without a deadline", async ({ deadlineAt, message }) => {
    const { database, intent, lifecycle, calls } = await dispatchFixture();
    const id = durableExecutionId(intent);
    const execution = await database.insertAgentExecution({
      id,
      organizationId: intent.organizationId,
      projectId: intent.projectId,
      daemonId: intent.environment.daemonId,
      machineId: null,
      triggerContext: intent.triggerContext,
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: intent,
      ...(deadlineAt === null ? {} : { deadlineAt }),
    });
    const prepare = vi
      .spyOn(database, "prepareAgentExecutionForDispatch")
      .mockResolvedValue({ ...execution, deadlineAt: null });

    try {
      await assert.rejects(() => lifecycle.handoffLaunchMachineIntent(intent), {
        message: `${message}: ${id}`,
      });
      assert.equal(prepare.mock.calls.length, deadlineAt === null ? 0 : 1);
      assert.deepEqual(calls, { creates: [], sends: [] });
    } finally {
      await lifecycle.stop();
    }
  });

  it("rejects dispatch when the trigger run no longer matches the launch authority", async () => {
    const { database, intent, lifecycle, calls } = await dispatchFixture();
    const insert = vi.spyOn(database, "insertAgentExecution");
    vi.spyOn(database, "findTriggerRunById").mockResolvedValue(undefined);
    try {
      await assert.rejects(() => lifecycle.dispatchLaunchMachineIntent(intent), {
        name: "DaemonDispatchFailure",
        message: "daemon dispatch failed: tenant_authority_mismatch",
      });
      assert.equal(insert.mock.calls.length, 0);
      assert.deepEqual(calls, { creates: [], sends: [] });
    } finally {
      await lifecycle.stop();
    }
  });

  it("does not complete an execution that disappears after the callback token check", async () => {
    const { database, intent, lifecycle } = await dispatchFixture();
    try {
      const { execution } = await lifecycle.dispatchLaunchMachineIntent(intent);
      const executionId = execution.id;
      const find = vi
        .spyOn(database, "findAgentExecutionById")
        .mockResolvedValueOnce(execution)
        .mockResolvedValueOnce(undefined);
      const transition = vi.spyOn(database, "transitionAgentExecution");
      const token = deriveAgentExecutionCompletionToken("test-secret", executionId);
      await assert.rejects(
        () => lifecycle.completeAgentExecutionFromCallback({ executionId, token }),
        {
          name: "AgentExecutionCompletionFailure",
          message: "agent execution completion failed: not_found",
        },
      );
      assert.deepEqual(find.mock.calls, [[executionId], [executionId]]);
      assert.equal(transition.mock.calls.length, 0);
    } finally {
      await lifecycle.stop();
    }
  });

  it("retries a pool timeout before the agent is created and launches it once", async () => {
    const { database, intent, lifecycle, calls, sleeps } = await dispatchFixture();
    vi.spyOn(database, "saveAgentSession")
      .mockRejectedValueOnce(poolTimeout())
      .mockRejectedValueOnce(poolTimeout());
    try {
      const result = await lifecycle.dispatchLaunchMachineIntent(intent);
      assert.equal(result.agentId, AGENT_ID);
      assert.deepEqual(sleeps, [250, 500]);
      assert.equal(calls.creates.length, 1);
      assert.deepEqual(calls.sends, [result.execution.id]);
      assert.equal((await database.findAgentExecutionById(result.execution.id))?.status, "running");
    } finally {
      await lifecycle.stop();
    }
  });

  it("retries after the agent was created without creating a second one", async () => {
    const { database, intent, lifecycle, calls, sleeps } = await dispatchFixture();
    vi.spyOn(database, "attachAgentToExecution").mockRejectedValueOnce(poolTimeout());
    try {
      const result = await lifecycle.dispatchLaunchMachineIntent(intent);
      assert.deepEqual(sleeps, [250]);
      assert.equal(calls.creates.length, 1, "the saved session already holds the agent");
      assert.deepEqual(calls.sends, [result.execution.id]);
    } finally {
      await lifecycle.stop();
    }
  });

  it("does not retry once the prompt send has started", async () => {
    const { database, intent, lifecycle, calls, sleeps, stream } = await dispatchFixture();
    vi.spyOn(database, "transitionAgentExecution").mockRejectedValueOnce(poolTimeout());
    try {
      await assert.rejects(lifecycle.dispatchLaunchMachineIntent(intent));
      assert.deepEqual(sleeps, []);
      assert.equal(calls.sends.length, 1);
      assert.equal(
        stream.records().some((record) => record["operation"] === "daemon.dispatch"),
        true,
      );
    } finally {
      await lifecycle.stop();
    }
  });

  it("reports one failure with the attempt count when the attempts run out", async () => {
    const { database, intent, lifecycle, calls, sleeps, stream } = await dispatchFixture();
    vi.spyOn(database, "saveAgentSession").mockRejectedValue(poolTimeout());
    try {
      await assert.rejects(lifecycle.dispatchLaunchMachineIntent(intent));
      assert.equal(sleeps.length, 5);
      assert.equal(calls.creates.length, 0);
      assert.equal(calls.sends.length, 0);
      const failures = stream
        .records()
        .filter((record) => record["operation"] === "daemon.dispatch");
      assert.equal(failures.length, 1);
      assert.match(JSON.stringify(failures[0]), /"attempts":6/u);
    } finally {
      await lifecycle.stop();
    }
  });

  it("fails at once on an error that is not transient", async () => {
    const { database, intent, lifecycle, sleeps } = await dispatchFixture();
    vi.spyOn(database, "saveAgentSession").mockRejectedValueOnce(new Error("constraint violated"));
    try {
      await assert.rejects(lifecycle.dispatchLaunchMachineIntent(intent));
      assert.deepEqual(sleeps, []);
    } finally {
      await lifecycle.stop();
    }
  });
});

function daemonRecord(): DaemonRecord {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: DAEMON_ID,
    slug: "daemon-lifecycle",
    machineId: "machine-lifecycle",
    serverId: "server-lifecycle",
    daemonPublicKey: "public-key",
    credentialVerifier: "verifier",
    permissions: ["hub.execute"],
    registeredByApiKeyId: null,
    registeredByCliCredentialId: null,
    status: "active",
    presence: "connected",
    connectedAt: now,
    disconnectedAt: null,
    lastSeenAt: now,
    createdAt: now,
  };
}

function turnCompleted(): DaemonEvent {
  return {
    type: "agent_stream",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    event: { type: "turn_completed", provider: "test" },
  };
}

function agentIdle(): DaemonEvent {
  return {
    type: "agent_update",
    executionId: EXECUTION_ID,
    agentId: AGENT_ID,
    timestamp: ACKNOWLEDGED_AT.toISOString(),
    agent: { id: AGENT_ID, status: "idle" },
  };
}
