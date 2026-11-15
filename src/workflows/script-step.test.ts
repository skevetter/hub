import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { compiledConfigurationHash, type CompiledHubConfig } from "../config/compiler.js";
import { FakeClock, FakeTerminalDaemon } from "../daemons/test-utils/fake-terminal-daemon.js";
import {
  createScriptStepRunner,
  ScriptRunAborted,
  SCRIPT_PERMISSION_MESSAGE,
  type ScriptStepRunner,
} from "../daemons/terminals/script.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database, DurableProviderEvent, TriggerRunRecord } from "../db/types.js";
import { UNLIMITED_TEMPLATE } from "../entitlements/catalog.js";
import { EntitlementsService } from "../entitlements/service.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import type { AcceptedTriggerProviderMatch, TriggerProvider } from "../triggers/index.js";
import { parseInvocation } from "../triggers/invocation.js";
import { createDurableWorkflowHandler, type DurableWorkflowEngine } from "./engine.js";
import { readScriptStepResult, scriptTerminalName } from "./script-output.js";
import { SCRIPT_INTERRUPTED_REASON, SCRIPT_RUNNER_UNAVAILABLE_REASON } from "./script-step.js";

const DOCUMENT = `
name: deploy
on:
  manual.run:
    filters:
      from_users: [alice]
run:
  target:
    daemon: devbox
    cwd: /workspace/webapp
  script: |
    echo "deploying $HUB_EVENT_JSON"
    ./deploy.sh
  max_runtime: 10m
`;

const MANUAL_EVENT = {
  manual: { actor: "alice", input: "ship it", trigger: "deploy", delivery_id: "d-1" },
};

interface Fixture {
  database: Database;
  entitlements: EntitlementsService;
  configuration: CompiledHubConfig;
  provider: TriggerProvider;
  trigger: DurableProviderEvent;
  receiptId: string;
}

async function fixture(document = DOCUMENT): Promise<Fixture> {
  const database = createMemoryDatabase({ organizationIds: ["org-1"] });
  const entitlements = new EntitlementsService(database, { seats: async () => 0 });
  await entitlements.stamp("org-1", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
  const project = await database.createProject({
    organizationId: "org-1",
    name: "Scripts",
    slug: randomUUID(),
    createdByUserId: "user-1",
  });
  const compiled = compileTriggerDocument(document);
  if (compiled.environment.kind !== "daemon") throw new Error("expected a daemon target");
  const configuration: CompiledHubConfig = {
    environments: [{ ...compiled.environment, daemonId: "daemon-1" }],
    triggers: compiled.events,
  };
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: configuration,
    contentHash: compiledConfigurationHash(configuration),
    createdByUserId: "user-1",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: "org-1",
    projectId: project.id,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: new Date(),
  });
  if (receipt.status !== "accepted") throw new Error("receipt was not accepted");
  const provider = {
    name: "manual",
    eventNames: ["manual.run"] as const,
    async match(): Promise<readonly AcceptedTriggerProviderMatch[]> {
      const trigger = configuration.triggers[0]!;
      const invocation = parseInvocation("ship it", trigger.inputs);
      if (invocation.status !== "accepted") throw new Error("invocation rejected");
      return [
        {
          triggerName: trigger.name,
          triggerContext: { provider: "manual", deliveryId: "d-1", event: MANUAL_EVENT },
          outputContext: { provider: "manual", actor: "alice" },
          configurationRevisionId: revision.id,
          hubConfig: configuration,
          conversation: null,
          invocation,
        },
      ];
    },
  } satisfies TriggerProvider;
  return {
    database,
    entitlements,
    configuration,
    provider,
    receiptId: receipt.event.providerEventReceiptId,
    trigger: {
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      organizationId: "org-1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      source: "manual.run",
      deliveryId: receipt.event.deliveryId,
      payload: {},
      receivedAt: new Date(),
      connectionId: null,
      resourceId: null,
    },
  };
}

function engineFor(
  context: Fixture,
  options: {
    scriptRunner?: ScriptStepRunner | undefined;
    canDispatchToDaemon?: (daemonId: string) => boolean;
  } = {},
) {
  return createDurableWorkflowHandler({
    database: context.database,
    entitlements: context.entitlements,
    providers: [context.provider],
    ...(options.scriptRunner === undefined ? {} : { scriptRunner: options.scriptRunner }),
    ...(options.canDispatchToDaemon === undefined
      ? {}
      : { canDispatchToDaemon: options.canDispatchToDaemon }),
  });
}

async function onlyRun(context: Fixture): Promise<TriggerRunRecord> {
  const [run] = await context.database.findTriggerRunsByProviderEventReceiptId(context.receiptId);
  assert.ok(run);
  return run;
}

/** Process wakeups until the run leaves `running`, as the engine's own worker would. */
async function untilSettled(
  context: Fixture,
  engine: DurableWorkflowEngine,
): Promise<TriggerRunRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await engine.processAvailable();
    const run = await onlyRun(context);
    if (run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the run did not settle");
}

async function onlyStep(context: Fixture) {
  const run = await onlyRun(context);
  const [step] = await context.database.listWorkflowStepRunsForTriggerRun(run.id);
  assert.ok(step);
  return step;
}

function runnerFor(daemon: FakeTerminalDaemon, clock: FakeClock): ScriptStepRunner {
  return createScriptStepRunner(() => ({ terminals: daemon.client }), clock);
}

describe("script steps in the durable workflow engine", () => {
  it("runs the script on the daemon and records the exit code and output tail", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(500, () => {
      daemon.print("deploying\ndone");
      daemon.exit(0);
    });
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "succeeded");
    const step = await onlyStep(context);
    assert.equal(step.status, "succeeded");
    assert.equal(step.agentExecutionId, null);
    assert.deepEqual(step.output, {
      exit_code: 0,
      output_tail: "deploying\ndone",
      truncated: false,
    });
    assert.equal(step.failureReason, null);
    assert.ok(step.startedAt);
    assert.ok(step.completedAt);
    assert.equal(daemon.created.length, 1);
    assert.deepEqual(daemon.killed, ["terminal-1"]);
  });

  it("hands the daemon the working directory, the literal script, and the event JSON", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => daemon.exit(0));
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);
    await untilSettled(context, engine);

    const [created] = daemon.created;
    assert.equal(created?.cwd, "/workspace/webapp");
    assert.equal(created?.command, "/bin/sh");
    const args = created?.args ?? [];
    assert.equal(args[3], 'echo "deploying $HUB_EVENT_JSON"\n./deploy.sh\n');
    assert.deepEqual(JSON.parse(args[4] ?? ""), MANUAL_EVENT);
    assert.equal(args[1]?.includes("ship it"), false);
    assert.equal(created?.name, scriptTerminalName((await onlyStep(context)).id));
  });

  it("fails the run with the exit code when the script exits nonzero", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => {
      daemon.print("compile error");
      daemon.exit(2);
    });
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "failed");
    assert.equal(run.outcome === "accepted" && run.failureReason, "script exited 2");
    const step = await onlyStep(context);
    assert.equal(step.status, "failed");
    assert.equal(step.failureReason, "script exited 2");
    assert.deepEqual(readScriptStepResult(step.output), {
      exit_code: 2,
      output_tail: "compile error",
      truncated: false,
    });
  });

  it("records the terminal id as soon as it exists", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    const updates: { status: string; output: unknown }[] = [];
    const update = context.database.updateWorkflowScriptStep.bind(context.database);
    context.database.updateWorkflowScriptStep = async (stepRunId, change) => {
      updates.push({ status: change.status, output: change.output });
      return update(stepRunId, change);
    };
    clock.at(500, () => daemon.exit(0));
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);
    await untilSettled(context, engine);
    assert.deepEqual(updates[0], {
      status: "running",
      output: { terminal_id: "terminal-1", daemon_id: "daemon-1" },
    });
    assert.equal(updates[1]?.status, "succeeded");
  });

  it("reports a permission refusal with the grant instructions", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    daemon.denied.add("create_terminal_request");
    const { handler, engine } = engineFor(context, {
      scriptRunner: runnerFor(daemon, new FakeClock()),
    });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "failed");
    assert.equal(run.outcome === "accepted" && run.failureReason, SCRIPT_PERMISSION_MESSAGE);
    assert.deepEqual(readScriptStepResult((await onlyStep(context)).output), {
      exit_code: null,
      output_tail: "",
      truncated: false,
    });
  });

  it("times a script out at its max runtime, kills the terminal, and times the run out", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => daemon.print("still going"));
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "timed_out");
    const step = await onlyStep(context);
    assert.equal(step.status, "timed_out");
    assert.equal(step.failureReason, "script timed out after 10m");
    assert.deepEqual(readScriptStepResult(step.output), {
      exit_code: null,
      output_tail: "still going",
      truncated: false,
    });
    assert.deepEqual(daemon.killed, ["terminal-1"]);
  });

  it("neither reserves the executions meter nor creates an agent execution", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => daemon.exit(0));
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);
    await untilSettled(context, engine);

    assert.equal((await context.entitlements.usage("org-1", "executions.monthly")).used, 0);
    const step = await onlyStep(context);
    assert.equal(await context.database.findAgentExecutionByWorkflowStepRunId(step.id), undefined);
  });

  it("does not run again once it has finished", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => daemon.exit(0));
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);
    await untilSettled(context, engine);
    await engine.processAvailable();
    await engine.processAvailable();
    assert.equal(daemon.created.length, 1);
  });

  it("fails the run when the Hub has no terminal channel", async () => {
    const context = await fixture();
    const { handler, engine } = engineFor(context);
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "failed");
    assert.equal(run.outcome === "accepted" && run.failureReason, SCRIPT_RUNNER_UNAVAILABLE_REASON);
  });

  it("waits for a Hub that holds the daemon connection instead of starting", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => daemon.exit(0));
    let connected = false;
    const { handler, engine } = engineFor(context, {
      scriptRunner: runnerFor(daemon, clock),
      canDispatchToDaemon: () => connected,
    });
    await handler(context.trigger);
    await engine.processAvailable();
    assert.equal((await onlyRun(context)).status, "running");
    assert.equal((await onlyStep(context)).status, "pending");
    assert.equal(daemon.created.length, 0);

    connected = true;
    const run = await untilSettled(context, engine);
    assert.equal(run.status, "succeeded");
    assert.equal(daemon.created.length, 1);
  });
});

/** A clock whose waits only end when the run is aborted, so a script stays mid-poll. */
class ParkedClock extends FakeClock {
  override sleep(_milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

describe("script step recovery", () => {
  /** A runner whose script never ends until it is aborted, as a long job at the moment of a crash. */
  function hangingRunner() {
    const cleanups: {
      daemonId: string;
      cwd: string;
      name: string;
      terminalId?: string | undefined;
    }[] = [];
    const runner: ScriptStepRunner = {
      async run(_daemonId, input) {
        await input.onTerminal?.({ id: "terminal-9" });
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new ScriptRunAborted();
      },
      async cleanup(daemonId, target) {
        cleanups.push({ daemonId, ...target });
      },
    };
    return { runner, cleanups };
  }

  async function untilRunning(context: Fixture): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const step = await onlyStep(context);
      if (step.status === "running" && step.output !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("the script never started");
  }

  it("kills the recorded terminal and fails the run as interrupted after a restart", async () => {
    const context = await fixture();
    const first = hangingRunner();
    const { handler, engine } = engineFor(context, { scriptRunner: first.runner });
    await handler(context.trigger);
    await engine.processAvailable();
    await untilRunning(context);
    const stepRunId = (await onlyStep(context)).id;
    // The Hub dies: its watcher is gone, and the step is still recorded as running.
    await engine.stop();
    assert.equal((await onlyStep(context)).status, "running");
    assert.equal((await onlyRun(context)).status, "running");

    const second = hangingRunner();
    const restarted = engineFor(context, { scriptRunner: second.runner });
    const run = await untilSettled(context, restarted.engine);

    assert.equal(run.status, "failed");
    assert.equal(run.outcome === "accepted" && run.failureReason, SCRIPT_INTERRUPTED_REASON);
    assert.deepEqual(second.cleanups, [
      {
        daemonId: "daemon-1",
        cwd: "/workspace/webapp",
        name: scriptTerminalName(stepRunId),
        terminalId: "terminal-9",
      },
    ]);
    const step = await onlyStep(context);
    assert.equal(step.status, "failed");
    assert.equal(step.failureReason, SCRIPT_INTERRUPTED_REASON);
    // The script is not run again.
    assert.deepEqual(readScriptStepResult(step.output), {
      exit_code: null,
      output_tail: "",
      truncated: false,
    });
  });

  it("does not start the script again after a restart", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const first = engineFor(context, { scriptRunner: runnerFor(daemon, new ParkedClock()) });
    await first.handler(context.trigger);
    await first.engine.processAvailable();
    await untilRunning(context);
    await first.engine.stop();
    daemon.killed.length = 0;

    const restarted = engineFor(context, { scriptRunner: runnerFor(daemon, new FakeClock()) });
    const run = await untilSettled(context, restarted.engine);

    assert.equal(run.status, "failed");
    assert.equal(daemon.created.length, 1);
    assert.ok(daemon.killed.includes("terminal-1"));
  });

  it("finds a terminal by name when the Hub died before recording its id", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const { handler, engine } = engineFor(context, {
      scriptRunner: runnerFor(daemon, new FakeClock()),
    });
    await handler(context.trigger);
    const run = await onlyRun(context);
    const [step] = await context.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.ok(step);
    // The dead Hub marked the step running and created the terminal, then died.
    await context.database.startWorkflowScriptStep({
      stepRunId: step.id,
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + 60_000),
    });
    await daemon.client.create({
      cwd: "/workspace/webapp",
      name: scriptTerminalName(step.id),
      command: "/bin/sh",
      args: [],
      size: { rows: 50, cols: 240 },
    });
    await daemon.client.create({
      cwd: "/workspace/webapp",
      name: "somebody-elses-terminal",
      command: "/bin/sh",
      args: [],
      size: { rows: 50, cols: 240 },
    });

    const settled = await untilSettled(context, engine);

    assert.equal(settled.status, "failed");
    assert.deepEqual(daemon.killed, ["terminal-1"]);
    assert.equal(daemon.created.length, 2);
  });

  it("waits for the daemon connection before recovering a step", async () => {
    const context = await fixture();
    const first = hangingRunner();
    const { handler, engine } = engineFor(context, { scriptRunner: first.runner });
    await handler(context.trigger);
    await engine.processAvailable();
    await untilRunning(context);
    await engine.stop();

    const second = hangingRunner();
    const restarted = engineFor(context, {
      scriptRunner: second.runner,
      canDispatchToDaemon: () => false,
    });
    await restarted.engine.processAvailable();
    assert.equal((await onlyRun(context)).status, "running");
    assert.deepEqual(second.cleanups, []);
  });
});
