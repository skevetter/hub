import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { compiledConfigurationHash, type CompiledHubConfig } from "../config/compiler.js";
import { DatabaseUnavailableError } from "../db/errors.js";
import { FakeClock, FakeTerminalDaemon } from "../daemons/test-utils/fake-terminal-daemon.js";
import {
  createScriptStepRunner,
  ScriptRunAborted,
  SCRIPT_PERMISSION_MESSAGE,
  type ScriptCleanupTarget,
  type ScriptRunInput,
  type ScriptRunResult,
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
import { readScriptStepHandle, readScriptStepResult, scriptTerminalName } from "./script-output.js";
import type { ScriptLimits } from "./script-limits.js";
import { SCRIPT_INTERRUPTED_REASON, SCRIPT_RUNNER_UNAVAILABLE_REASON } from "./script-step.js";

const DOCUMENT = `
name: deploy
on:
  github.notification:
    filters:
      repo: acme/webapp
      reason: review_requested
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
    scriptLimits?: ScriptLimits;
    now?: () => Date;
  } = {},
) {
  return createDurableWorkflowHandler({
    retry: NO_WAIT,
    ...(options.scriptLimits === undefined ? {} : { scriptLimits: options.scriptLimits }),
    ...(options.now === undefined ? {} : { now: options.now }),
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

/** Retries run at once, so no real time passes between attempts. */
const NO_WAIT = { sleep: async () => undefined, random: () => 0 };

function runnerFor(daemon: FakeTerminalDaemon, clock: FakeClock): ScriptStepRunner {
  return createScriptStepRunner(() => ({ terminals: daemon.client }), clock, NO_WAIT);
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
      output: { daemon_id: "daemon-1", cwd: "/workspace/webapp", terminal_id: "terminal-1" },
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
      async sweep() {
        return { stopped: 0, unconfirmed: 0 };
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

/** A runner whose scripts end only when the test says so, and whose cleanup the test can break. */
function controllableRunner() {
  const runs: {
    daemonId: string;
    input: ScriptRunInput;
    finish: (result: ScriptRunResult) => void;
  }[] = [];
  const cleanups: { daemonId: string; target: ScriptCleanupTarget }[] = [];
  const sweeps: { daemonId: string; cwd: string }[] = [];
  const control = { cleanupError: undefined as Error | undefined };
  const runner: ScriptStepRunner = {
    run(daemonId, input) {
      return new Promise<ScriptRunResult>((resolve, reject) => {
        runs.push({ daemonId, input, finish: resolve });
        input.signal?.addEventListener("abort", () => reject(new ScriptRunAborted()), {
          once: true,
        });
        void input.onTerminal?.({ id: `terminal-${String(runs.length)}` });
      });
    },
    async cleanup(daemonId, target) {
      if (control.cleanupError !== undefined) throw control.cleanupError;
      cleanups.push({ daemonId, target });
    },
    async sweep(daemonId, scope) {
      sweeps.push({ daemonId, cwd: scope.cwd });
      return { stopped: 0, unconfirmed: 0 };
    },
  };
  return { runner, runs, cleanups, sweeps, control };
}

const SUCCESS: ScriptRunResult = {
  status: "succeeded",
  exitCode: 0,
  outputTail: "ok",
  truncated: false,
};

async function anotherRun(context: Fixture, handler: (event: DurableProviderEvent) => unknown) {
  const receipt = await context.database.persistManualEvent({
    organizationId: "org-1",
    projectId: context.trigger.projectId,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: new Date(),
  });
  if (receipt.status !== "accepted") throw new Error("receipt was not accepted");
  await handler({
    ...context.trigger,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    deliveryId: receipt.event.deliveryId,
  });
  const [run] = await context.database.findTriggerRunsByProviderEventReceiptId(
    receipt.event.providerEventReceiptId,
  );
  assert.ok(run);
  return run;
}

async function stepOf(context: Fixture, runId: string) {
  const [step] = await context.database.listWorkflowStepRunsForTriggerRun(runId);
  assert.ok(step);
  return step;
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("the condition never held");
}

describe("script step concurrency caps", () => {
  async function twoRuns(limits: ScriptLimits) {
    const context = await fixture();
    const control = controllableRunner();
    let now = new Date();
    const { handler, engine } = engineFor(context, {
      scriptRunner: control.runner,
      scriptLimits: limits,
      now: () => now,
    });
    await handler(context.trigger);
    await engine.processAvailable();
    await waitFor(() => control.runs.length === 1);
    const second = await anotherRun(context, handler);
    await engine.processAvailable();
    return {
      context,
      control,
      engine,
      second,
      advance: (milliseconds: number) => {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  }

  it.each([
    ["the daemon", { maxPerDaemon: 1, maxPerTrigger: 50 }],
    ["the trigger", { maxPerDaemon: 50, maxPerTrigger: 1 }],
  ])(
    "keeps a step pending when %s is at its cap, and starts it once a slot frees",
    async (_name, limits) => {
      const { context, control, engine, second, advance } = await twoRuns(limits);

      assert.equal(control.runs.length, 1);
      assert.equal((await stepOf(context, second.id)).status, "pending");
      assert.equal((await context.database.findTriggerRunById(second.id))?.status, "running");

      // Nothing happens at the next ticks: the held step waits for its retry time.
      await engine.processAvailable();
      assert.equal(control.runs.length, 1);

      control.runs[0]!.finish(SUCCESS);
      await waitFor(async () => (await onlyStep(context)).status === "succeeded");
      advance(5_000);
      await engine.processAvailable();
      await waitFor(() => control.runs.length === 2);
      assert.equal((await stepOf(context, second.id)).status, "running");
      control.runs[1]!.finish(SUCCESS);
      await waitFor(async () => (await stepOf(context, second.id)).status === "succeeded");
      await engine.stop();
    },
  );

  it("does not fail a held step or start it before its retry time", async () => {
    const { context, control, engine, second, advance } = await twoRuns({
      maxPerDaemon: 1,
      maxPerTrigger: 3,
    });
    advance(500);
    await engine.processAvailable();
    assert.equal(control.runs.length, 1);
    assert.equal((await context.database.findTriggerRunById(second.id))?.status, "running");
    await engine.stop();
  });

  it("lets runs through up to the cap", async () => {
    const { control, engine } = await twoRuns({ maxPerDaemon: 2, maxPerTrigger: 2 });
    await waitFor(() => control.runs.length === 2);
    await engine.stop();
  });
});

describe("script step wakeups", () => {
  it("leaves a running script with a live watcher out of the wakeup recovery", async () => {
    const context = await fixture();
    const control = controllableRunner();
    const excluded: (readonly string[] | undefined)[] = [];
    const recover = context.database.recoverWorkflowWakeups.bind(context.database);
    context.database.recoverWorkflowWakeups = async (now, excludedRunIds) => {
      excluded.push(excludedRunIds);
      return recover(now, excludedRunIds);
    };
    const { handler, engine } = engineFor(context, { scriptRunner: control.runner });
    await handler(context.trigger);
    await engine.processAvailable();
    await waitFor(() => control.runs.length === 1);
    const run = await onlyRun(context);

    let deletions = 0;
    const remove = context.database.deleteWorkflowWakeup.bind(context.database);
    context.database.deleteWorkflowWakeup = async (runId) => {
      deletions += 1;
      return remove(runId);
    };
    for (let tick = 0; tick < 6; tick += 1) await engine.processAvailable();

    assert.deepEqual(excluded.at(-1), [run.id]);
    // No wakeup was added and claimed for it, so the database was not touched by the ticks.
    assert.equal(deletions, 0);
    assert.equal(
      await context.database.claimWorkflowWakeup(new Date(Date.now() + 3_600_000), 1_000),
      undefined,
    );
    await engine.stop();
  });
});

describe("script step database writes", () => {
  it("retries transient errors, so a script that ran is recorded as it ended", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(500, () => {
      daemon.print("built");
      daemon.exit(0);
    });
    const failures = { running: 2, finished: 3 };
    const update = context.database.updateWorkflowScriptStep.bind(context.database);
    context.database.updateWorkflowScriptStep = async (stepRunId, change) => {
      const key = change.status === "running" ? "running" : "finished";
      if (failures[key] > 0) {
        failures[key] -= 1;
        throw new DatabaseUnavailableError();
      }
      return update(stepRunId, change);
    };
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "succeeded");
    assert.deepEqual(failures, { running: 0, finished: 0 });
    assert.deepEqual((await onlyStep(context)).output, {
      exit_code: 0,
      output_tail: "built",
      truncated: false,
    });
  });

  it("does not retry an error that is not transient", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(500, () => daemon.exit(0));
    let attempts = 0;
    const update = context.database.updateWorkflowScriptStep.bind(context.database);
    context.database.updateWorkflowScriptStep = async (stepRunId, change) => {
      if (change.status === "succeeded") {
        attempts += 1;
        throw new Error("constraint violated");
      }
      return update(stepRunId, change);
    };
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);
    await engine.processAvailable();
    await waitFor(() => attempts > 0);
    await engine.stop();
    assert.equal(attempts, 1);
  });
});

describe("script step output and deadlines", () => {
  it("records a script that printed NUL and control bytes with its true exit code", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => {
      daemon.print("a\u0000b\u0001c\u001b[31md\u001b[0m");
      daemon.exit(7);
    });
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "failed");
    assert.deepEqual((await onlyStep(context)).output, {
      exit_code: 7,
      output_tail: "abcd",
      truncated: false,
    });
    assert.equal((await onlyStep(context)).failureReason, "script exited 7");
  });

  it("says the trigger's deadline ended the script when it came before the step's", async () => {
    const context = await fixture(DOCUMENT.replace("run:", "max_runtime: 1m\nrun:"));
    const daemon = new FakeTerminalDaemon();
    const { handler, engine } = engineFor(context, {
      scriptRunner: runnerFor(daemon, new FakeClock()),
    });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "timed_out");
    assert.equal(
      (await onlyStep(context)).failureReason,
      "script timed out after 1m, when the trigger's deadline came first (the step allows 10m)",
    );
  });
});

describe("script terminal cleanup", () => {
  it("records a stop the daemon never confirmed, and the sweep finishes it on reconnect", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => daemon.exit(0));
    daemon.killSucceeds = false;
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);

    const run = await untilSettled(context, engine);

    assert.equal(run.status, "succeeded");
    const step = await onlyStep(context);
    assert.deepEqual(readScriptStepResult(step.output)?.cleanup, {
      daemon_id: "daemon-1",
      cwd: "/workspace/webapp",
      name: scriptTerminalName(step.id),
      terminal_id: "terminal-1",
    });
    assert.equal((await context.database.listWorkflowScriptStepsPendingCleanup()).length, 1);

    // A leftover from a finished step.
    const make = (name: string) =>
      daemon.client.create({
        cwd: "/workspace/webapp",
        name,
        command: "/bin/sh",
        args: [],
        size: { rows: 50, cols: 240 },
      });
    await make(scriptTerminalName("00000000-0000-4000-8000-0000000000aa"));

    daemon.killSucceeds = true;
    await engine.sweepScriptTerminals("daemon-1");

    assert.equal(daemon.killed.includes("terminal-1"), true);
    assert.equal(daemon.killed.includes("terminal-2"), true);
    const settled = await onlyStep(context);
    assert.deepEqual(settled.output, { exit_code: 0, output_tail: "", truncated: false });
    assert.equal((await context.database.listWorkflowScriptStepsPendingCleanup()).length, 0);
  });

  it("leaves a terminal alone when the step that owns it is still running", async () => {
    const context = await fixture();
    const daemon = new FakeTerminalDaemon();
    const clock = new FakeClock();
    clock.at(250, () => daemon.exit(0));
    daemon.killSucceeds = false;
    const { handler, engine } = engineFor(context, { scriptRunner: runnerFor(daemon, clock) });
    await handler(context.trigger);
    await untilSettled(context, engine);
    const running = await anotherRun(context, handler);
    await context.database.startWorkflowScriptStep({
      stepRunId: (await stepOf(context, running.id)).id,
      startedAt: new Date(),
      deadlineAt: new Date(Date.now() + 60_000),
      output: { daemon_id: "daemon-1", cwd: "/workspace/webapp" },
    });
    await daemon.client.create({
      cwd: "/workspace/webapp",
      name: scriptTerminalName((await stepOf(context, running.id)).id),
      command: "/bin/sh",
      args: [],
      size: { rows: 50, cols: 240 },
    });
    daemon.killSucceeds = true;
    await engine.sweepScriptTerminals("daemon-1");
    assert.deepEqual(daemon.killed, ["terminal-1"]);
  });

  it("stops the terminal of a step the database timed out while the Hub was down", async () => {
    const context = await fixture();
    const first = controllableRunner();
    const started = engineFor(context, { scriptRunner: first.runner });
    await started.handler(context.trigger);
    await started.engine.processAvailable();
    await waitFor(() => first.runs.length === 1);
    await waitFor(
      async () => readScriptStepHandle((await onlyStep(context)).output)?.terminal_id !== undefined,
    );
    const stepRunId = (await onlyStep(context)).id;
    await started.engine.stop();

    // The Hub comes back after the whole run's deadline.
    const second = controllableRunner();
    const restarted = engineFor(context, {
      scriptRunner: second.runner,
      now: () => new Date(Date.now() + 3 * 3_600_000),
    });
    await restarted.engine.processAvailable();
    await restarted.engine.stop();

    const run = await onlyRun(context);
    assert.equal(run.status, "timed_out");
    assert.deepEqual(second.cleanups, [
      {
        daemonId: "daemon-1",
        target: {
          cwd: "/workspace/webapp",
          name: scriptTerminalName(stepRunId),
          terminalId: "terminal-1",
        },
      },
    ]);
    assert.deepEqual((await onlyStep(context)).output, {
      exit_code: null,
      output_tail: "",
      truncated: false,
    });
  });

  it("keeps a pending record when the daemon is away at the deadline, then clears it on reconnect", async () => {
    const context = await fixture();
    const first = controllableRunner();
    const started = engineFor(context, { scriptRunner: first.runner });
    await started.handler(context.trigger);
    await started.engine.processAvailable();
    await waitFor(() => first.runs.length === 1);
    await waitFor(
      async () => readScriptStepHandle((await onlyStep(context)).output)?.terminal_id !== undefined,
    );
    await started.engine.stop();

    const second = controllableRunner();
    second.control.cleanupError = new Error("daemon_not_connected");
    const restarted = engineFor(context, {
      scriptRunner: second.runner,
      now: () => new Date(Date.now() + 3 * 3_600_000),
    });
    await restarted.engine.processAvailable();
    await restarted.engine.stop();
    assert.equal((await onlyRun(context)).status, "timed_out");
    assert.equal(
      readScriptStepResult((await onlyStep(context)).output)?.cleanup?.terminal_id,
      "terminal-1",
    );

    second.control.cleanupError = undefined;
    await restarted.engine.sweepScriptTerminals("daemon-1");
    assert.equal(second.cleanups.length, 1);
    assert.equal(second.cleanups[0]?.target.terminalId, "terminal-1");
    assert.equal(readScriptStepResult((await onlyStep(context)).output)?.cleanup, undefined);
    assert.ok(second.sweeps.length > 0);
    for (const sweep of second.sweeps) {
      assert.deepEqual(sweep, { daemonId: "daemon-1", cwd: "/workspace/webapp" });
    }
  });

  it("does not sweep a daemon this process is not connected to", async () => {
    const context = await fixture();
    const first = controllableRunner();
    const started = engineFor(context, { scriptRunner: first.runner });
    await started.handler(context.trigger);
    await started.engine.processAvailable();
    await waitFor(() => first.runs.length === 1);
    await started.engine.stop();
    const second = controllableRunner();
    second.control.cleanupError = new Error("daemon_not_connected");
    const restarted = engineFor(context, {
      scriptRunner: second.runner,
      canDispatchToDaemon: () => false,
      now: () => new Date(Date.now() + 3 * 3_600_000),
    });
    await restarted.engine.processAvailable();
    await restarted.engine.sweepScriptTerminals("daemon-1");
    await restarted.engine.stop();
    assert.deepEqual(second.sweeps, []);
  });
});
