import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { compiledConfigurationHash, type CompiledHubConfig } from "../config/compiler.js";
import { createMemoryDatabase } from "./memory.js";
import { createDatabase } from "./pg.js";
import { embeddedDatabaseRuntime } from "./runtime/index.js";
import { scriptTerminalName } from "../workflows/script-output.js";
import { ScriptStepRuntime } from "../workflows/script-step.js";
import type { Database } from "./types.js";
import type { AuthServer } from "../auth/server.js";
import { ProjectDashboard } from "../projects/dashboard.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const CONFIGURATION: CompiledHubConfig = {
  environments: [
    { name: "target", kind: "daemon", daemon: "devbox", daemonId: "daemon-1", cwd: "/work" },
  ],
  triggers: [
    {
      name: "deploy",
      on: "github.notification",
      maxRuntimeMs: 600_000,
      inputs: {},
      values: {},
      filters: { repo: "acme/webapp", reason: "review_requested" },
      steps: [
        { kind: "script", id: "run", environment: "target", maxRuntimeMs: 600_000, script: "true" },
      ],
    },
  ],
};

interface Harness {
  database: Database;
  projectId: string;
  close: () => Promise<void>;
}

async function memoryHarness(): Promise<Harness> {
  const database = createMemoryDatabase({ organizationIds: ["org-1"] });
  const project = await database.createProject({
    organizationId: "org-1",
    name: "Scripts",
    slug: "scripts",
    createdByUserId: "user-1",
  });
  return { database, projectId: project.id, close: async () => undefined };
}

async function embeddedHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "hub-script-steps-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
  await runtime.migrate();
  await runtime.query("insert into organization (id, name, slug) values ('org-1', 'Scripts', 's')");
  await runtime.query(
    "insert into projects (id, organization_id, name, slug) values ($1, 'org-1', 'Default', 'default')",
    [PROJECT_ID],
  );
  return {
    database: createDatabase(runtime, locks),
    projectId: PROJECT_ID,
    close: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function acceptedRun({ database, projectId }: Harness, stepIds = ["run"]) {
  const revision = await database.insertProjectConfigurationRevision({
    projectId,
    sourceKind: "manual",
    sourceEvidence: { kind: "test" },
    normalizedConfiguration: CONFIGURATION,
    contentHash: compiledConfigurationHash(CONFIGURATION),
  });
  await database.activateProjectConfigurationRevision(projectId, revision.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: "org-1",
    projectId,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: new Date(),
  });
  if (receipt.status !== "accepted") throw new Error("receipt was not accepted");
  const created = await database.createAcceptedTriggerRun({
    organizationId: "org-1",
    projectId,
    configurationRevisionId: revision.id,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    configuredTriggerName: "deploy",
    prompt: "",
    inputs: {},
    triggerContext: { provider: "manual" },
    outputContext: { provider: "manual" },
    deadlineAt: new Date(Date.now() + 3_600_000),
    stepIds,
  });
  const [step] = await database.listWorkflowStepRunsForTriggerRun(created.run.id);
  assert.ok(step);
  return { run: created.run, step };
}

const backends = [
  ["in-memory", memoryHarness],
  ["embedded PostgreSQL", embeddedHarness],
] as const;

describe.each(backends)("script step persistence (%s)", (_name, open) => {
  it("projects only displayed detail and authoritative agent completion", async () => {
    const harness = await open();
    const { database } = harness;
    try {
      const { run } = await acceptedRun(harness, [
        "explicit",
        "inferred",
        "failed",
        "ended",
        "script",
      ]);
      const steps = await database.listWorkflowStepRunsForTriggerRun(run.id);
      const variants = [
        {
          result: { status: "succeeded" },
          output: { completion: "inferred_from_turn_end", secret: "user output" },
          completedByAgent: true,
        },
        {
          result: { status: "succeeded", completion: "inferred_from_turn_end", output: "answer" },
          output: { status: "succeeded", completion: "inferred_from_turn_end", output: "answer" },
          completedByAgent: false,
        },
        {
          result: { status: "failed" },
          output: { completion: "inferred_from_turn_end" },
          completedByAgent: false,
        },
        {
          result: { status: "succeeded" },
          output: { completion: "inferred_from_turn_end" },
          completedByAgent: false,
        },
      ];
      for (const [index, variant] of variants.entries()) {
        const step = steps[index]!;
        const execution = await database.insertAgentExecution({
          organizationId: "org-1",
          projectId: harness.projectId,
          machineId: null,
          triggerContext: {},
          outputContext: {},
          configurationRevisionId: run.configurationRevisionId,
          workflowStepRunId: step.id,
        });
        await database.linkWorkflowStepRunExecution(step.id, execution.id);
        await database.completeWorkflowAgentExecution({
          executionId: execution.id,
          executionStatus: index === 2 ? "failed" : "succeeded",
          stepStatus: index === 2 ? "failed" : "succeeded",
          result: variant.result,
          stepOutput: variant.output,
          completedByAgent: variant.completedByAgent,
        });
      }
      database.resolveTenantRouteAccess = async () => ({
        organization: { id: "org-1", name: "Scripts", slug: "s" },
        membership: { id: "membership-1", role: "owner" },
      });
      const auth: AuthServer = {
        handle: async () => new Response(),
        resources: async () => {
          throw new Error("unused");
        },
        resolveOrganizationAccess: async () => {
          throw new Error("unused");
        },
        resolveAccount: async () => ({
          session: { id: "session-1", activeOrganizationId: "org-1" },
          account: { id: "user-1", name: "User", email: "user@example.test" },
          isInstanceOperator: false,
        }),
        rejectCookieMutation: () => undefined,
        close: async () => undefined,
      };
      const detail = await new ProjectDashboard(database, auth).activityRunDetail(
        new Request("https://hub.test/o/s"),
        { organizationSlug: "s", runId: run.id },
      );
      assert.ok(detail);
      assert.deepEqual(Object.keys(detail.run).sort(), [
        "completedAt",
        "configuredTriggerName",
        "createdAt",
        "failureReason",
        "id",
        "outcome",
        "payloadExpiredAt",
        "payloadSummary",
        "provider",
        "receivedAt",
        "repo",
        "source",
        "status",
      ]);
      assert.equal(detail.run.payloadExpiredAt, null);
      assert.equal(detail.run.payloadSummary, null);
      for (const step of detail.steps) {
        assert.equal(step.outputExpired, false);
        assert.equal(step.payloadSummary, null);
        assert.deepEqual(Object.keys(step).sort(), [
          "completedAt",
          "completion",
          "failureReason",
          "id",
          "isAgent",
          "ordinal",
          "output",
          "outputExpired",
          "payloadSummary",
          "startedAt",
          "status",
          "stepId",
        ]);
      }
      assert.deepEqual(
        detail.steps.map(({ isAgent, completion }) => ({ isAgent, completion })),
        [
          { isAgent: true, completion: "explicit_finish" },
          { isAgent: true, completion: "inferred_from_turn_end" },
          { isAgent: true, completion: null },
          { isAgent: true, completion: null },
          { isAgent: false, completion: null },
        ],
      );
      assert.deepEqual(detail.steps[0]?.output, variants[0]?.output);
      assert.deepEqual(detail.steps[1]?.output, variants[1]?.output);
      assert.deepEqual(detail.steps[2]?.output, variants[2]?.output);
      assert.deepEqual(detail.steps[3]?.output, variants[3]?.output);
    } finally {
      await harness.close();
    }
  });

  it("reads an organization-scoped run with ordered steps", async () => {
    const harness = await open();
    try {
      const { run } = await acceptedRun(harness, ["third", "first", "second"]);
      const detail = await harness.database.findOrganizationActivityRun("org-1", run.id);
      assert.ok(detail);
      assert.equal(detail.run.id, run.id);
      assert.deepEqual(
        detail.steps.map(({ stepId, ordinal }) => ({ stepId, ordinal })),
        [
          { stepId: "third", ordinal: 0 },
          { stepId: "first", ordinal: 1 },
          { stepId: "second", ordinal: 2 },
        ],
      );
      assert.equal(await harness.database.findOrganizationActivityRun("org-2", run.id), undefined);
      assert.equal(
        await harness.database.findOrganizationActivityRun("org-1", randomUUID()),
        undefined,
      );
    } finally {
      await harness.close();
    }
  });

  it("starts a pending step once and records the terminal while it runs", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { step } = await acceptedRun(harness);
      const startedAt = new Date();
      const deadlineAt = new Date(startedAt.getTime() + 660_000);

      const first = await database.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt,
        deadlineAt,
      });
      assert.equal(first?.started, true);
      assert.equal(first?.stepRun.status, "running");
      assert.equal(first?.stepRun.agentExecutionId, null);
      assert.equal(first?.stepRun.deadlineAt?.getTime(), deadlineAt.getTime());

      const second = await database.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt,
        deadlineAt,
      });
      assert.equal(second?.started, false);

      const handle = { terminal_id: "terminal-1", daemon_id: "daemon-1" };
      const recorded = await database.updateWorkflowScriptStep(step.id, {
        status: "running",
        output: handle,
        at: new Date(),
      });
      assert.equal(recorded?.status, "running");
      assert.deepEqual(recorded?.output, handle);
      assert.equal(recorded?.completedAt, null);
    } finally {
      await close();
    }
  });

  it("finishes a step with its result and wakes the run, and ignores a later update", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { run, step } = await acceptedRun(harness);
      await database.deleteWorkflowWakeup(run.id);
      await database.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
      });
      const result = { exit_code: 3, output_tail: "boom", truncated: false };

      const finished = await database.updateWorkflowScriptStep(step.id, {
        status: "failed",
        output: result,
        failureReason: "script exited 3",
        at: new Date(),
      });
      assert.equal(finished?.status, "failed");
      assert.deepEqual(finished?.output, result);
      assert.equal(finished?.failureReason, "script exited 3");
      assert.ok(finished?.completedAt);
      const wakeup = await database.claimWorkflowWakeup(new Date(Date.now() + 1_000), 30_000);
      assert.equal(wakeup?.triggerRunId, run.id);

      const late = await database.updateWorkflowScriptStep(step.id, {
        status: "succeeded",
        output: { exit_code: 0, output_tail: "", truncated: false },
        at: new Date(),
      });
      assert.equal(late?.status, "failed");
      assert.deepEqual(late?.output, result);
    } finally {
      await close();
    }
  });

  it("does not start a step whose run has ended", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { run, step } = await acceptedRun(harness);
      await database.failWorkflowRun(run.id, "failed", "stopped", step.stepId);
      const started = await database.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
      });
      assert.equal(started?.started, false);
    } finally {
      await close();
    }
  });

  it("lets deadline recovery time out a script step nothing is watching", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { run, step } = await acceptedRun(harness);
      const startedAt = new Date(Date.now() - 120_000);
      await database.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt,
        deadlineAt: new Date(startedAt.getTime() + 60_000),
      });
      const recoveries = await database.recoverWorkflowDeadlines(new Date());
      assert.deepEqual(
        recoveries.map(({ triggerRunId, executionIds }) => ({ triggerRunId, executionIds })),
        [{ triggerRunId: run.id, executionIds: [] }],
      );
      const [after] = await database.listWorkflowStepRunsForTriggerRun(run.id);
      assert.equal(after?.status, "timed_out");
    } finally {
      await close();
    }
  });
  it("writes the first output with the start", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { step } = await acceptedRun(harness);
      const first = { daemon_id: "daemon-1", cwd: "/work" };
      const started = await database.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        output: first,
      });
      assert.deepEqual(started?.stepRun.output, first);
    } finally {
      await close();
    }
  });

  it("lists ended steps that still name a terminal or a pending cleanup, and nothing else", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { run, step } = await acceptedRun(harness);
      await database.startWorkflowScriptStep({
        stepRunId: step.id,
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        output: { daemon_id: "daemon-1", cwd: "/work", terminal_id: "terminal-1" },
      });
      // Running: a watcher owns it.
      assert.deepEqual(await database.listWorkflowScriptStepsPendingCleanup(), []);

      await database.failWorkflowRun(run.id, "failed", "stopped", step.stepId);
      const pending = await database.listWorkflowScriptStepsPendingCleanup();
      assert.deepEqual(
        pending.map(({ id }) => id),
        [step.id],
      );

      const settled = { exit_code: null, output_tail: "", truncated: false };
      await database.setWorkflowScriptStepOutput(step.id, {
        ...settled,
        cleanup: { daemon_id: "daemon-1", cwd: "/work", name: "hub-script-x" },
      });
      assert.equal((await database.listWorkflowScriptStepsPendingCleanup()).length, 1);

      const cleared = await database.setWorkflowScriptStepOutput(step.id, settled);
      assert.deepEqual(cleared?.output, settled);
      assert.deepEqual(await database.listWorkflowScriptStepsPendingCleanup(), []);
    } finally {
      await close();
    }
  });

  it("holds a released wakeup until its retry time", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { run } = await acceptedRun(harness);
      const now = new Date();
      const claimed = await database.claimWorkflowWakeup(new Date(now.getTime() + 1_000), 30_000);
      assert.equal(claimed?.triggerRunId, run.id);
      const retryAt = new Date(now.getTime() + 60_000);
      await database.releaseWorkflowWakeup(run.id, now, claimed.leaseExpiresAt!, retryAt);

      assert.equal(
        await database.claimWorkflowWakeup(new Date(now.getTime() + 10_000), 30_000),
        undefined,
      );
      const later = await database.claimWorkflowWakeup(new Date(retryAt.getTime() + 1), 30_000);
      assert.equal(later?.triggerRunId, run.id);
    } finally {
      await close();
    }
  });

  it("does not add a wakeup for a run a live watcher handles", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { run } = await acceptedRun(harness);
      await database.deleteWorkflowWakeup(run.id);
      const now = new Date();

      await database.recoverWorkflowWakeups(now, [run.id]);
      assert.equal(
        await database.claimWorkflowWakeup(new Date(now.getTime() + 1_000), 30_000),
        undefined,
      );

      await database.recoverWorkflowWakeups(now);
      const added = await database.claimWorkflowWakeup(new Date(now.getTime() + 1_000), 30_000);
      assert.equal(added?.triggerRunId, run.id);
    } finally {
      await close();
    }
  });
  it("never treats an ended agent step as a script step, whatever its output says", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const { run, step } = await acceptedRun(harness);
      const lookalike = {
        daemon_id: "daemon-1",
        cwd: "/work",
        terminal_id: "terminal-1",
        cleanup: { daemon_id: "daemon-1", cwd: "/work", name: "hub-script-x" },
      };
      const execution = await database.insertAgentExecution({
        organizationId: "org-1",
        projectId: harness.projectId,
        machineId: null,
        triggerContext: null,
        outputContext: null,
        configurationRevisionId: run.configurationRevisionId,
        workflowStepRunId: step.id,
      });
      await database.linkWorkflowStepRunExecution(step.id, execution.id);
      await database.completeWorkflowStep(execution.id, "succeeded", lookalike);
      const ended = await database.findWorkflowStepRunById(step.id);
      assert.equal(ended?.status, "succeeded");
      assert.deepEqual(ended?.output, lookalike);

      assert.deepEqual(await database.listWorkflowScriptStepsPendingCleanup(), []);
      assert.equal(
        await database.setWorkflowScriptStepOutput(step.id, { overwritten: true }),
        undefined,
      );
      assert.deepEqual((await database.findWorkflowStepRunById(step.id))?.output, lookalike);
    } finally {
      await close();
    }
  });
  it("keeps sweeping when a terminal's name carries no step id", async () => {
    const harness = await open();
    const { database, close } = harness;
    try {
      const ended = await acceptedRun(harness);
      await database.startWorkflowScriptStep({
        stepRunId: ended.step.id,
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        output: { daemon_id: "daemon-1", cwd: "/work" },
      });
      await database.failWorkflowRun(ended.run.id, "failed", "stopped", ended.step.stepId);
      const running = await acceptedRun(harness);
      await database.startWorkflowScriptStep({
        stepRunId: running.step.id,
        startedAt: new Date(),
        deadlineAt: new Date(Date.now() + 60_000),
        output: { daemon_id: "daemon-1", cwd: "/work" },
      });

      const owned: Record<string, boolean> = {};
      const runtime = new ScriptStepRuntime({
        database,
        runner: {
          run: async () => {
            throw new Error("unused");
          },
          cleanup: async () => undefined,
          sweep: async (_daemon, _scope, keep) => {
            for (const name of [
              "hub-script-not-a-uuid",
              "hub-script-",
              "hub-script-00000000-0000-4000-8000-00000000000z",
              scriptTerminalName(ended.step.id),
              scriptTerminalName(running.step.id),
              "somebody-elses",
            ]) {
              owned[name] = await keep(name);
            }
            return { stopped: 0, unconfirmed: 0 };
          },
        },
        providers: [],
        limits: { maxPerDaemon: 5, maxPerTrigger: 3 },
        now: () => new Date(),
        canDispatchToDaemon: undefined,
        report: (error) => {
          throw error;
        },
        failRun: async () => undefined,
        notifyStarted: async () => undefined,
      });

      await runtime.sweep("daemon-1");

      assert.deepEqual(owned, {
        "hub-script-not-a-uuid": false,
        "hub-script-": false,
        "hub-script-00000000-0000-4000-8000-00000000000z": false,
        [scriptTerminalName(ended.step.id)]: false,
        [scriptTerminalName(running.step.id)]: true,
        "somebody-elses": false,
      });
    } finally {
      await close();
    }
  });
});
