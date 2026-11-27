import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  ScriptRunAborted,
  type ScriptRunInput,
  type ScriptStepRunner,
} from "../daemons/terminals/script.js";
import { createMemoryDatabase } from "../db/memory.js";
import { scriptTerminalName } from "./script-output.js";
import {
  MAX_EVENT_JSON_BYTES,
  SCRIPT_RUNNER_UNAVAILABLE_REASON,
  ScriptStepRuntime,
  type ScriptStepLaunch,
  type ScriptStepRuntimeOptions,
} from "./script-step.js";

const now = new Date("2026-01-01T00:00:00Z");
const wakeup = {
  triggerRunId: "run",
  availableAt: now,
  leaseExpiresAt: null,
  leasedBeforeClaim: false,
};

async function fixture(triggerContext: unknown = { provider: "manual", event: { name: "demo" } }) {
  const database = createMemoryDatabase();
  const { run } = await database.createAcceptedTriggerRun({
    id: "run",
    organizationId: "org_1",
    projectId: "project",
    configurationRevisionId: "revision",
    providerEventReceiptId: "receipt",
    configuredTriggerName: "demo",
    prompt: "",
    inputs: {},
    triggerContext,
    outputContext: null,
    deadlineAt: new Date(now.getTime() + 2_000),
    stepIds: ["script"],
    createdAt: now,
  });
  const [stepRun] = await database.listWorkflowStepRunsForTriggerRun(run.id);
  if (stepRun === undefined) throw new Error("missing step run");
  const launch: ScriptStepLaunch = {
    run,
    stepRun,
    step: {
      id: "script",
      kind: "script",
      environment: "local",
      maxRuntimeMs: 3_000,
      script: "echo demo",
    },
    daemonId: "daemon",
    cwd: "/repo",
    runAlreadyStarted: false,
  };
  const failures: unknown[] = [];
  const options: ScriptStepRuntimeOptions = {
    database,
    runner: undefined,
    providers: [],
    limits: { maxPerDaemon: 1, maxPerTrigger: 1 },
    now: () => now,
    canDispatchToDaemon: undefined,
    report: () => undefined,
    failRun: async (...args) => {
      failures.push(args);
    },
    notifyStarted: async () => undefined,
  };
  return { launch, options, failures };
}

function runner(run: ScriptStepRunner["run"]): ScriptStepRunner {
  return {
    run,
    cleanup: async () => undefined,
    sweep: async () => ({ stopped: 0, unconfirmed: 0 }),
  };
}

describe("script step runtime characterization", () => {
  it("fails an unavailable runner without using the wakeup", async () => {
    const { launch, options, failures } = await fixture();
    expect(await new ScriptStepRuntime(options).start(launch, wakeup)).toBe(undefined);
    expect(failures).toEqual([["run", SCRIPT_RUNNER_UNAVAILABLE_REASON, "script"]]);
  });

  it("forwards the nullable lease on disconnected start and orphan recovery", async () => {
    const { launch, options } = await fixture();
    const releases: unknown[] = [];
    options.database.releaseWorkflowWakeup = async (...args) => {
      releases.push(args);
    };
    options.runner = runner(async () => {
      throw new Error("must not run");
    });
    options.canDispatchToDaemon = () => false;
    const runtime = new ScriptStepRuntime(options);
    expect(await runtime.start(launch, wakeup)).toBe("deferred");
    expect(await runtime.recoverOrphan(launch, wakeup)).toBe("deferred");
    expect(releases).toEqual([
      ["run", now, null],
      ["run", now, null],
    ]);
  });

  it("reports an unavailable materializer before trying to start a terminal", async () => {
    const { launch, options, failures } = await fixture({ provider: "other", event: {} });
    options.runner = runner(async () => {
      throw new Error("must not run");
    });
    const runtime = new ScriptStepRuntime(options);
    expect(await runtime.start(launch, wakeup)).toBe(undefined);
    expect(failures).toEqual([["run", "trigger_context_materializer_unavailable", "script"]]);
  });

  it("rejects event JSON beyond the byte limit", async () => {
    const { launch, options, failures } = await fixture({
      provider: "manual",
      event: "x".repeat(MAX_EVENT_JSON_BYTES),
    });
    options.runner = runner(async () => {
      throw new Error("must not run");
    });
    expect(await new ScriptStepRuntime(options).start(launch, wakeup)).toBe(undefined);
    expect(failures).toEqual([
      [
        "run",
        `The event data is larger than ${MAX_EVENT_JSON_BYTES} bytes, which is too large to pass to a script.`,
        "script",
      ],
    ]);
  });

  it("preserves literal launch arguments and the timeout result", async () => {
    const { launch, options } = await fixture();
    const inputs: ScriptRunInput[] = [];
    const reached = Promise.withResolvers<void>();
    options.runner = runner(async (_daemonId, input) => {
      inputs.push(input);
      await input.onTerminal?.({ id: "terminal", workspaceId: "workspace" });
      reached.resolve();
      return { status: "timed_out", exitCode: null, outputTail: "tail", truncated: true };
    });
    const runtime = new ScriptStepRuntime(options);
    await runtime.start(launch, wakeup);
    await reached.promise;
    await runtime.stop();
    const input = inputs[0];
    expect(input?.cwd).toBe("/repo");
    expect(input?.script).toBe("echo demo");
    expect(input?.eventJson).toBe('{"name":"demo"}');
    expect(input?.timeoutMs).toBe(2_000);
    const step = await options.database.findWorkflowStepRunById(launch.stepRun.id);
    expect(step?.output).toEqual({ exit_code: null, output_tail: "tail", truncated: true });
    expect(step?.failureReason).toBe(
      "script timed out after 2s, when the trigger's deadline came first (the step allows 3s)",
    );
  });

  it.each(["pending cleanup", "terminal handle"] as const)(
    "persists the %s when a running step is canceled",
    async (outputKind) => {
      const { launch, options } = await fixture();
      const { database } = options;
      const ready = Promise.withResolvers<void>();
      options.runner = runner(async (_daemonId, input) => {
        if (input.signal === undefined) throw new Error("missing abort signal");
        await input.onTerminal?.({ id: "terminal", workspaceId: "workspace" });
        const aborted = once(input.signal, "abort");
        ready.resolve();
        await aborted;
        const cleanup = {
          cwd: "/repo",
          name: input.name,
          terminalId: "terminal",
          workspaceId: "workspace",
        };
        throw new ScriptRunAborted(outputKind === "pending cleanup" ? cleanup : undefined);
      });
      const runtime = new ScriptStepRuntime(options);
      await runtime.start(launch, wakeup);
      await ready.promise;
      await database.cancelTriggerRun(launch.run.organizationId, launch.run.id);
      await runtime.stop();
      const step = await database.findWorkflowStepRunById(launch.stepRun.id);
      const handle = {
        daemon_id: "daemon",
        cwd: "/repo",
        terminal_id: "terminal",
        workspace_id: "workspace",
      };
      expect(step?.status).toBe("canceled");
      expect(step?.output).toEqual(
        outputKind === "pending cleanup"
          ? {
              exit_code: null,
              output_tail: "",
              truncated: false,
              cleanup: { ...handle, name: scriptTerminalName(launch.stepRun.id) },
            }
          : handle,
      );
    },
  );
});
