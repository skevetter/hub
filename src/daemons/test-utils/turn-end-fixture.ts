import type { RunTimeline } from "../../run-timeline/index.js";
import type { TriggerProvider } from "../../triggers/index.js";
import { randomUUID } from "node:crypto";
import type { AgentConnection, AgentEvent } from "../agents/index.js";
import type { DaemonAgentStreamEvent } from "../protocol.js";
import type { AgentExecutionRecord, Database, WorkflowStepRunRecord } from "../../db/types.js";
import type { LaunchMachineIntent } from "../../dispatcher/launch-machine-intent.js";
import type { JsonValue } from "../../config/compiler.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../../test-utils/project-configuration.js";
import { createLogger } from "../../logger.js";
import { FailureLogStream } from "../../test-utils/failure-logs.js";
import { OutputExecutorRegistry } from "../../execution-capabilities/outputs.js";
import type { FinalReplyAnswer } from "../../run-replies/format.js";
import {
  createDaemonDispatchLifecycle,
  type DaemonDispatchLifecycle,
  type ExecutionDeadlineClock,
} from "../lifecycle.js";

export const IDLE_TIMEOUT_MS = 60_000;
const AGENT_ID = "agent-turn-end";

/** Time moves only when a test says so, and timers fire in order as it passes. */
export class ManualClock implements ExecutionDeadlineClock {
  private current = Date.now();
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => Promise<void> }>();

  now(): number {
    return this.current;
  }

  schedule(callback: () => Promise<void>, delayMs: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.current = Math.max(this.current, due[1].at);
      await due[1].callback();
    }
    this.current = target;
  }
}

export interface TurnEndFixtureOptions {
  database: Database;
  timeline?: RunTimeline;
  providers?: readonly TriggerProvider[];
  triggerContext?: JsonValue;
  outputContext?: JsonValue;
  organizationId: string;
  /** Run the execution as a workflow step, so the step output can be read back. */
  workflow?: boolean;
  completeOnTurnEnd?: boolean;
  onRunReplyAnswer?: (
    scope: { runId: string; organizationId: string },
    executionId: string,
    answer: FinalReplyAnswer | null,
  ) => void;
  autoArchive?: boolean;
  outputSchema?: JsonValue;
  requiredOutput?: boolean;
  continuationKey?: string;
  /** Events the daemon delivers as Hub subscribes, before the prompt is sent. */
  duringSubscribe?: (emit: (event: AgentEvent) => void) => void;
}

export async function turnEndFixture(options: TurnEndFixtureOptions) {
  const { database, organizationId } = options;
  await enrollTestDaemon(database, organizationId);
  const project = await database.createProject({
    organizationId,
    name: "Turn end",
    slug: `turn-end-${randomUUID().slice(0, 8)}`,
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: `turn-end-${randomUUID()}`,
    createdByUserId: null,
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  return createFixture(options, { project, revision });
}

interface FixtureProject {
  project: Awaited<ReturnType<Database["createProject"]>>;
  revision: Awaited<ReturnType<Database["insertProjectConfigurationRevision"]>>;
}

function createFixture(options: TurnEndFixtureOptions, project: FixtureProject) {
  const { database } = options;
  const clock = new ManualClock();
  const executionIds: string[] = [];
  const failures = new FailureLogStream();
  const { state, sends, controls, emit, agents } = createFixtureAgent(options);
  const lifecycle = createFixtureLifecycle(options, agents, clock, failures);
  const { stream, events } = createFixtureEvents(clock);
  const dispatch = createFixtureDispatch(options, project, clock, {
    lifecycle,
    executionIds,
  });

  /** Delivers an event the way the daemon would, then lets Hub's handlers finish. */
  async function deliver(event: AgentEvent): Promise<void> {
    emit(event);
    await handled();
  }

  /** Waits on Hub's own per-execution event queue instead of guessing how long it takes. */
  async function handled(): Promise<void> {
    await Promise.all(executionIds.map((id) => lifecycle.waitForPendingStreamHandlers(id)));
  }

  return {
    database,
    lifecycle,
    clock,
    state,
    sends,
    controls,
    failures,
    agents,
    dispatch,
    deliver,
    stream,
    flush: handled,
    events,
    /** A turn that ran, said `text` and ended normally, the way a real one is reported. */
    async endTurn(text?: string): Promise<void> {
      state.status = "running";
      await deliver(this.events.turnStarted());
      await deliver(this.events.status("running"));
      if (text !== undefined) await deliver(this.events.text(text));
      state.status = "idle";
      await deliver(this.events.turnCompleted());
      await deliver(this.events.status("idle"));
    },
    ...fixtureControls({ deliver, stream, lifecycle, database }),
  };
}

function createFixtureAgent(options: TurnEndFixtureOptions) {
  const state = {
    status: "idle" as "idle" | "running",
    statusFails: false,
    /** Holds the daemon's status answer until a test releases it. */
    statusGate: undefined as Promise<void> | undefined,
    onStatusRequest: undefined as (() => void) | undefined,
  };
  const listeners = new Set<(event: AgentEvent) => void>();
  const sends: string[] = [];
  const controls: string[] = [];
  const emit = (event: AgentEvent) => {
    for (const listener of listeners) listener(event);
  };
  const agent = () => ({ id: AGENT_ID, workspaceId: "workspace-turn-end", status: state.status });
  const agents: AgentConnection = {
    create: async () => agent(),
    get: async () => {
      state.onStatusRequest?.();
      if (state.statusGate !== undefined) await state.statusGate;
      if (state.statusFails) throw new Error("daemon unreachable");
      return agent();
    },
    restore: async () => true,
    control: async (_agentId, _workspaceId, action) => {
      controls.push(action);
    },
    watch: async (_agentId, listener) => {
      listeners.add(listener);
      options.duringSubscribe?.(emit);
      return () => listeners.delete(listener);
    },
    send: async (_agentId, messageId) => {
      sends.push(messageId);
    },
  };
  return { state, sends, controls, emit, agents };
}

function createFixtureLifecycle(
  options: TurnEndFixtureOptions,
  agents: AgentConnection,
  clock: ManualClock,
  failures: FailureLogStream,
): DaemonDispatchLifecycle {
  const { database } = options;
  const executionCapabilities = new OutputExecutorRegistry();
  executionCapabilities.register({
    type: "slack.reply",
    tool: {
      name: "reply",
      description: "Replies.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    execute: async () => {},
  });
  return createDaemonDispatchLifecycle({
    database,
    executionCapabilities,
    ...(options.timeline === undefined ? {} : { timeline: options.timeline }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.onRunReplyAnswer === undefined
      ? {}
      : { onRunReplyAnswer: options.onRunReplyAnswer }),
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
    test: { deadlineClock: clock, logger: createLogger(failures) },
  });
}

function createFixtureDispatch(
  options: TurnEndFixtureOptions,
  records: FixtureProject,
  clock: ManualClock,
  { lifecycle, executionIds }: { lifecycle: DaemonDispatchLifecycle; executionIds: string[] },
) {
  const { database, organizationId } = options;
  const { project, revision } = records;
  return async function dispatch(): Promise<{
    execution: AgentExecutionRecord;
    step: WorkflowStepRunRecord | undefined;
  }> {
    const receipt = await database.persistManualEvent({
      organizationId,
      projectId: project.id,
      deliveryId: randomUUID(),
      source: "manual.turn_end",
      payload: {},
      receivedAt: new Date(),
    });
    if (receipt.status !== "accepted") throw new Error("manual event was not accepted");
    const run = (
      await database.createAcceptedTriggerRun({
        organizationId,
        projectId: project.id,
        configurationRevisionId: revision.id,
        providerEventReceiptId: receipt.event.providerEventReceiptId,
        configuredTriggerName: "turn-end",
        prompt: "raw",
        inputs: {},
        triggerContext: options.triggerContext ?? {},
        outputContext: options.outputContext ?? {},
        ...(options.onRunReplyAnswer === undefined ? {} : { replyMessage: true }),
        deadlineAt: new Date(clock.now() + 2 * 60 * 60_000),
        stepIds: ["step"],
      })
    ).run;
    const step =
      options.workflow === true
        ? await database.findWorkflowStepRunByTriggerRun(run.id)
        : undefined;
    const intent = launchIntent(options, records, run.id, step);
    const { execution } = await lifecycle.dispatchLaunchMachineIntent(intent);
    executionIds.push(execution.id);
    return { execution, step };
  };
}

function launchIntent(
  options: TurnEndFixtureOptions,
  { project, revision }: FixtureProject,
  runId: string,
  step: WorkflowStepRunRecord | undefined,
): LaunchMachineIntent {
  const { organizationId } = options;
  return {
    kind: "launch_machine",
    organizationId,
    projectId: project.id,
    triggerRunId: runId,
    ...(step === undefined ? {} : { workflowStepRunId: step.id }),
    triggerName: "turn-end",
    environmentName: "runner",
    environment: {
      kind: "daemon",
      daemonId: TEST_DAEMON_ID,
      authoredSlug: "runner",
      cwd: "/repo",
    },
    agent: { provider: "claude" },
    prompt: "Do the work",
    allowOutputs:
      options.requiredOutput === true ? [{ type: "slack.reply", max: 1, required: true }] : [],
    timeoutMs: 60 * 60_000,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    autoArchive: options.autoArchive === true,
    background: false,
    ...(options.completeOnTurnEnd === true ? { completeOnTurnEnd: true } : {}),
    ...(options.onRunReplyAnswer === undefined ? {} : { replyMessage: true }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    ...(options.continuationKey === undefined
      ? {}
      : { continuation: { key: options.continuationKey, compatibility: {} } }),
    triggerContext: options.triggerContext ?? {},
    outputContext: options.outputContext ?? {},
    configurationRevisionId: revision.id,
    hubConfig: {},
  };
}

function createFixtureEvents(clock: ManualClock) {
  const timestamp = () => new Date(clock.now()).toISOString();
  const stream = (event: DaemonAgentStreamEvent): AgentEvent => ({
    type: "agent_stream",
    agentId: AGENT_ID,
    event,
    timestamp: timestamp(),
  });
  const provider = "claude";

  const events = {
    turnStarted: () => stream({ type: "turn_started", provider }),
    turnCompleted: () => stream({ type: "turn_completed", provider }),
    turnFailed: () => stream({ type: "turn_failed", provider, error: "boom" }),
    turnCanceled: () => stream({ type: "turn_canceled", provider, reason: "interrupted" }),
    permissionRequested: () =>
      stream({ type: "permission_requested", provider, request: { id: "permission-1" } }),
    text: (text: string, messageId = "message-1") =>
      stream({
        type: "timeline",
        provider,
        item: { type: "assistant_message", text, messageId },
      }),
    toolCall: (name: string, status: string, callId = `call-${name}`) =>
      stream({ type: "timeline", provider, item: { type: "tool_call", name, status, callId } }),
    status: (status: "idle" | "running" | "error"): AgentEvent => ({
      type: "agent_update",
      agent: { id: AGENT_ID, workspaceId: "workspace-turn-end", status },
      timestamp: timestamp(),
    }),
  };
  return { stream, events };
}

interface FixtureControls {
  deliver: (event: AgentEvent) => Promise<void>;
  stream: ReturnType<typeof createFixtureEvents>["stream"];
  lifecycle: DaemonDispatchLifecycle;
  database: Database;
}

function fixtureControls({ deliver, stream, lifecycle, database }: FixtureControls) {
  const provider = "claude";
  return {
    /**
     * A finish_execution call as the hub sees it: the MCP handler tells the registry which
     * execution made it, and the agent's stream reports the same call without that name.
     */
    async finishCall(
      executionId: string,
      status: "running" | "completed" | "failed",
      callId = `finish-${randomUUID()}`,
    ): Promise<void> {
      lifecycle.finishCalls.start(executionId);
      if (status !== "running") lifecycle.finishCalls.resolve(executionId, status);
      await deliver(
        stream({
          type: "timeline",
          provider,
          item: { type: "tool_call", name: "mcp__hub__finish_execution", status, callId },
        }),
      );
    },
    async execution(id: string): Promise<AgentExecutionRecord> {
      const found = await database.findAgentExecutionById(id);
      if (found === undefined) throw new Error("execution is missing");
      return found;
    },
  };
}
