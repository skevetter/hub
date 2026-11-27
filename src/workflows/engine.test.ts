import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import {
  agentStep,
  compileHubConfig,
  compiledConfigurationHash,
  type CompiledAgent,
  type CompiledHubConfig,
} from "../config/compiler.js";
import { compileHubBundle } from "../config/bundle.js";
import {
  hashPromptPartialContent,
  type ResolvedPromptPartials,
} from "../config/prompt-partials.js";
import { createMemoryDatabase } from "../db/memory.js";
import type {
  Database,
  DurableProviderEvent,
  ProviderEventReceiptRecord,
  TriggerRunRecord,
} from "../db/types.js";
import type { AcceptedTriggerProviderMatch, TriggerProvider } from "../triggers/index.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { parseInvocation } from "../triggers/invocation.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { UNLIMITED_TEMPLATE } from "../entitlements/catalog.js";
import { EntitlementsService } from "../entitlements/service.js";
import { createDurableWorkflowHandler } from "./engine.js";
import { currentProjectConfigurationFiles } from "../test-utils/current-project-configuration.js";
import { createGitHubAuth } from "../auth/github.js";
import {
  createGitHubReactionClient,
  createGitHubTriggerProvider,
  type GitHubTriggerContext,
} from "../triggers/github/provider.js";
import { notifyAgentExecutionCompleted } from "../triggers/lifecycle.js";
import { runWithFailureTracking } from "../failures/index.js";
import { createLogger } from "../logger.js";
import { assertOneFailure, FailureLogStream } from "../test-utils/failure-logs.js";
import { once } from "node:events";
import { createWebhookSource } from "../triggers/github/webhook.js";
import { createFetchServer } from "../http/node-server.js";
import { createServerShutdown } from "../server-shutdown.js";
import { createDaemonDispatchLifecycle } from "../daemons/lifecycle.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import {
  GITHUB_BILLING_DENIAL,
  githubBillingTriggerContext,
} from "../test-utils/github-billing-notice.js";

describe("durable multi-step workflow engine", () => {
  it.each([
    { flag: false, requestProgress: () => undefined, warns: false },
    { flag: true, requestProgress: () => undefined, warns: false },
    {
      flag: true,
      requestProgress: () => {
        throw new Error("progress unavailable");
      },
      warns: true,
    },
    {
      flag: true,
      requestProgress: () => Promise.reject(new Error("progress unavailable")),
      warns: true,
    },
  ])(
    "requests progress once per new opted-in run (flag=$flag, warns=$warns)",
    async ({ flag, requestProgress, warns }) => {
      const document = compileTriggerDocument(`
name: progress-run
on:
  slack.mention:
    filters: { from_users: [U123] }
progress_message: ${String(flag)}
run:
  target: { daemon: runner, cwd: /workspace }
  agent: { provider: codex }
  prompt: work
`);
      const fixture = await workflowFixture({
        compiledConfiguration: { environments: [document.environment], triggers: document.events },
      });
      const receipt = await fixture.database.persistManualEvent({
        organizationId: "org-1",
        projectId: fixture.projectId,
        deliveryId: randomUUID(),
        source: "slack.mention",
        payload: {},
        receivedAt: new Date(),
      });
      assert.ok(receipt.status === "accepted");
      const provider = {
        ...providerMatch(fixture.configuration, fixture.revisionId),
        name: "slack",
        eventNames: ["slack.mention"] as const,
      } satisfies TriggerProvider;
      const onProgressRequested = vi.fn((run: TriggerRunRecord) => {
        assert.equal(run.outcome, "accepted");
        return requestProgress();
      });
      const onWorkflowRunAccepted = vi.fn(async () => {});
      const warn = vi.fn();
      const { handler } = createDurableWorkflowHandler({
        database: fixture.database,
        entitlements: fixture.entitlements,
        providers: [provider],
        onProgressRequested,
        onWorkflowRunAccepted,
        logger: { warn, error: vi.fn() },
      });

      await handler(receipt.event);
      await handler(receipt.event);

      const runs = await fixture.database.findTriggerRunsByProviderEventReceiptId(
        receipt.event.providerEventReceiptId,
      );
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.outcome, "accepted");
      assert.equal(onWorkflowRunAccepted.mock.calls.length, 1);
      assert.equal(onProgressRequested.mock.calls.length, flag ? 1 : 0);
      assert.equal(onProgressRequested.mock.calls[0]?.[0].id, flag ? runs[0]?.id : undefined);
      assert.deepEqual(
        warn.mock.calls,
        warns ? [[{ triggerRunId: runs[0]?.id }, "could not request run progress"]] : [],
      );
    },
  );

  it("drains an admitted webhook into a durable workflow before runtime teardown", async () => {
    const fixture = await workflowFixture();
    const { handler, engine } = engineFor(fixture, []);
    const accepting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secret = "shutdown-webhook-test";
    const source = createWebhookSource(secret, {
      accept: async () => {
        accepting.resolve();
        await release.promise;
        return {
          status: "accepted",
          receiptId: fixture.providerEventReceiptId,
          events: [fixture.trigger("the triggering body")],
        };
      },
      applyLifecycle: async () => undefined,
    });
    await source.start(handler);
    const server = createFetchServer((request) => source.handle(request));
    let resourcesStopped = false;
    const shutdown = createServerShutdown(
      server,
      async () => {
        await source.stop();
        await engine.stop();
        resourcesStopped = true;
      },
      { graceMs: 1000, hardExitMs: 1500, exit: (code) => assert.equal(code, 0) },
    );
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const body = JSON.stringify({
      action: "created",
      installation: { id: 42 },
      repository: { id: 9001, full_name: "acme/widgets" },
    });
    const response = fetch(`http://127.0.0.1:${address.port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": fixture.deliveryId,
        "x-github-event": "issue_comment",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      body,
    });
    await accepting.promise;
    const stopped = shutdown();
    try {
      assert.equal(resourcesStopped, false);
      release.resolve();
      const result = await response;
      assert.equal(result.status, 200);
      await result.text();
      assert.equal(await stopped, true);
      const runs = await fixture.database.findTriggerRunsByProviderEventReceiptId(
        fixture.providerEventReceiptId,
      );
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.configuredTriggerName, "route-request");
      assert.equal(runs[0]!.outcome, "accepted");
      assert.equal(resourcesStopped, true);
    } finally {
      release.resolve();
      await stopped;
      server.closeAllConnections();
      server.close();
      await fixture.database.close();
    }
  });

  it.each(["github", "discord"] as const)(
    "materializes one reusable environment from each %s execution identity before persistence",
    async (providerName) => {
      const rawConfiguration = executionWorktreeConfiguration();
      const compiled = structuredClone(compileHubConfig(rawConfiguration));
      for (const trigger of compiled.triggers) {
        for (const step of trigger.steps) agentStep(step).continuation = { mode: "conversation" };
      }
      const fixture = await workflowFixture({ compiledConfiguration: compiled });
      const baseProvider = providerMatch(fixture.configuration, fixture.revisionId);
      const provider = {
        ...baseProvider,
        name: providerName,
        async match(event) {
          const [match] = await baseProvider.match(event);
          assert.ok(match);
          return fixture.configuration.triggers.map((trigger) => ({
            ...match,
            triggerName: trigger.name,
            triggerContext: { provider: providerName },
            outputContext: { provider: providerName },
          }));
        },
      } satisfies TriggerProvider;
      const intents: LaunchMachineIntent[] = [];
      const { handler, engine } = createDurableWorkflowHandler({
        database: fixture.database,
        entitlements: fixture.entitlements,
        providers: [provider],
        dispatchLaunchMachineIntent: async (intent) => {
          intents.push(intent);
          const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
            intent.workflowStepRunId!,
          );
          assert.ok(execution);
          return { execution };
        },
      });

      await handler(fixture.trigger("the triggering body"));
      await engine.processAvailable();

      assert.equal(intents.length, 2);
      const branches = intents.map((intent) => {
        assert.equal(intent.environment.worktree?.mode, "branch-off");
        if (intent.environment.worktree?.mode !== "branch-off") return "";
        assert.equal(JSON.stringify(intent.environment.worktree).includes("${{"), false);
        return intent.environment.worktree.newBranch;
      });
      assert.equal(new Set(branches).size, 2);
      for (const intent of intents) await assertMaterializedIntent(intent, fixture);
    },
  );

  it("materializes ambient context only for the step that authors paseo.context", async () => {
    const fixture = await workflowFixture({ rawConfiguration: contextOptInConfiguration() });
    const prompts: string[] = [];
    const materializedExecutionIds: string[] = [];
    const baseProvider = providerMatch(fixture.configuration, fixture.revisionId);
    const provider = {
      ...baseProvider,
      async materializeContext(launch) {
        materializedExecutionIds.push(launch.executionId);
        assert.equal(launch.providerEventReceiptId, fixture.providerEventReceiptId);
        return { manual: { item: { title: "ambient" } } };
      },
    } satisfies TriggerProvider;
    const { handler, engine } = createDurableWorkflowHandler({
      database: fixture.database,
      entitlements: fixture.entitlements,
      providers: [provider],
      dispatchLaunchMachineIntent: async (intent) => {
        if (intent.prompt === "Trigger: the triggering body") {
          assert.deepEqual(materializedExecutionIds, []);
        }
        prompts.push(intent.prompt);
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        assert.ok(execution);
        return { execution };
      },
    });

    await handler(fixture.trigger("the triggering body"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const firstStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const firstExecution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      firstStep.id,
    );
    assert.ok(firstExecution);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: firstExecution.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      stepOutput: null,
      completedByAgent: true,
    });
    await engine.processAvailable();

    assert.deepEqual(prompts, [
      "Trigger: the triggering body",
      'Context: {"manual":{"item":{"title":"ambient"}}}\nTrigger: the triggering body',
    ]);
    assert.equal(materializedExecutionIds.length, 1);
  });

  it("fails an explicit context opt-in when its provider cannot materialize context", async () => {
    const fixture = await workflowFixture({ rawConfiguration: contextOnlyConfiguration() });
    const { handler, engine } = engineFor(fixture, []);

    await handler(fixture.trigger("the triggering body"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;

    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "failed");
    assert.equal(steps[0]?.status, "failed");
    assert.equal(steps[0]?.failureReason, "trigger_context_materializer_unavailable");
  });

  it("defers a step while its daemon cannot take a dispatch and runs it once the daemon is back", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const checkedDaemons: string[] = [];
    let connected = false;
    const { handler, engine } = engineFor(fixture, dispatches, {
      canDispatchToDaemon: (daemonId) => {
        checkedDaemons.push(daemonId);
        return connected;
      },
    });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const deferredStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    assert.deepEqual(dispatches, []);
    assert.ok(checkedDaemons.length >= 2);
    assert.equal(
      await fixture.database.findAgentExecutionByWorkflowStepRunId(deferredStep.id),
      undefined,
    );
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "running");

    connected = true;
    await engine.processAvailable();

    assert.equal(dispatches.length, 1);
    assert.ok(await fixture.database.findAgentExecutionByWorkflowStepRunId(deferredStep.id));
    await engine.stop();
  });

  it("carries provider options and startup timeout into persisted and dispatched launch intent", async () => {
    const rawConfiguration = deadlineConfiguration();
    const options = {
      sandbox_workspace_write: {
        writable_roots: ["/var/cache/npm"],
        network_access: false,
      },
    };
    const triggers = readUnknownArray(rawConfiguration["triggers"]);
    if (triggers === undefined) throw new Error("test trigger unavailable");
    const trigger = triggers[0];
    if (!isRecord(trigger)) throw new Error("test trigger unavailable");
    const steps = readUnknownArray(trigger["steps"]);
    if (steps === undefined) throw new Error("test steps unavailable");
    const authoredStep = steps[0];
    if (!isRecord(authoredStep)) throw new Error("test step unavailable");
    const agent = authoredStep["agent"];
    if (!isRecord(agent)) throw new Error("test agent unavailable");
    Reflect.set(agent, "options", options);
    Reflect.set(authoredStep, "startup_timeout", "3m");
    const fixture = await workflowFixture({ rawConfiguration });
    let dispatched: LaunchMachineIntent | undefined;
    const { handler, engine } = engineFor(fixture, [], {
      beforeDispatch: async (intent) => {
        dispatched = intent;
      },
    });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    assert.deepEqual(dispatched?.agent, { provider: "codex", options });
    assert.equal(dispatched?.startupTimeoutMs, 180_000);
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const persistedStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    assert.deepEqual(persistedStep.dispatchIntent?.agent, { provider: "codex", options });
    assert.equal(persistedStep.dispatchIntent?.startupTimeoutMs, 180_000);
  });

  it("logs an initial recovery rejection and retries on the next interval", async () => {
    vi.useFakeTimers();
    const canary = "workflow-recovery-secret-61f4";
    const stream = new FailureLogStream();
    const fixture = await workflowFixture();
    const recovery = vi
      .spyOn(fixture.database, "recoverWorkflowDeadlines")
      .mockRejectedValueOnce(new Error(canary));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const { engine } = createDurableWorkflowHandler({
      database: fixture.database,
      entitlements: fixture.entitlements,
      providers: [providerMatch(fixture.configuration, fixture.revisionId)],
      workerIntervalMs: 10,
      logger: createLogger(stream),
      dispatchLaunchMachineIntent: async (intent) => {
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return { execution };
      },
    });
    try {
      engine.start();
      assert.equal(recovery.mock.calls.length, 1);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      assert.equal(recovery.mock.calls.length, 2);
      assert.deepEqual(unhandled, []);
      assertOneFailure(stream, {
        operation: "workflow.worker.recover",
        component: "workflows",
        canary,
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await engine.stop();
      vi.useRealTimers();
    }
  });

  it.each([
    ["succeeded", "succeeded"],
    ["failed", "failed"],
  ] as const)(
    "notifies the provider once when the whole workflow %s",
    async (stepStatus, expected) => {
      const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
      const terminalStatuses: string[] = [];
      const { handler, engine } = engineFor(fixture, [], {
        onWorkflowRunTerminal: async (run) => {
          terminalStatuses.push(run.status);
        },
      });
      await handler(fixture.trigger("run"));
      await engine.processAvailable();
      const run = (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
      let steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
      const first = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
      assert.ok(first);
      await fixture.database.transitionAgentExecution(first.id, stepStatus, {
        result: { status: stepStatus },
      });
      await engine.processAvailable();
      if (stepStatus === "succeeded") {
        assert.deepEqual(terminalStatuses, []);
        steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
        const second = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[1]!.id);
        assert.ok(second);
        await fixture.database.transitionAgentExecution(second.id, "succeeded", {
          result: { status: "succeeded" },
        });
        await engine.processAvailable();
      }
      await engine.processAvailable();
      assert.deepEqual(terminalStatuses, [expected]);
    },
  );

  it.each([
    "missing comment",
    "missing installation",
    "missing reaction",
    "transport",
    "429",
    "500",
    "401",
    "403",
    "cleanup 500",
  ])(
    "settles GitHub terminal reactions across leases and restart: %s",
    async (scenario) => {
      const fixture = await workflowFixture({ rawConfiguration: allSkippedConfiguration() });
      let now = new Date(Date.now() + 60_000);
      let unavailable = true;
      const requests: string[] = [];
      const logs = new FailureLogStream();
      const logger = createLogger(logs);
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const auth = createGitHubAuth({
        appId: "123",
        privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        now: () => now.getTime(),
        // Retry backoff and the one second write spacing are real-time waits this test does not exercise.
        octokitPlugins: { retry: false, throttle: false },
        fetch: async (input, init) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname;
          const method = init?.method ?? "GET";
          requests.push(`${method} ${path}`);
          const token = path.endsWith("/access_tokens");
          const tokenStatus = scenario === "missing installation" ? 404 : 201;
          const status = token
            ? tokenStatus
            : terminalReactionStatus({ method, scenario, unavailable });
          let body: unknown = { id: 2 };
          if (status >= 400) body = { message: "unavailable" };
          else if (token)
            body = {
              token: "test-token",
              expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
            };
          return Response.json(body, { status, headers: { "retry-after": "0" } });
        },
      });
      const provider = createGitHubTriggerProvider({
        configurationStoreForProject: () => {
          throw new Error("not used for terminal delivery");
        },
        reactions: createGitHubReactionClient(auth),
      });
      const context: GitHubTriggerContext = {
        provider: "github",
        organizationId: "org-1",
        target: { installationId: 42, repository: "example/project" },
        reactionSubject: { kind: "issue_comment", commentId: 99 },
        event: {
          github: {
            delivery_id: "test",
            pull_request: null,
            event_name: "issue_comment",
            repository: { full_name: "example/project" },
            received_at: now.toISOString(),
            item: null,
          },
        },
      };
      const start = () =>
        createDurableWorkflowHandler({
          database: fixture.database,
          entitlements: fixture.entitlements,
          providers: [providerMatch(fixture.configuration, fixture.revisionId)],
          now: () => now,
          leaseMs: 1_000,
          logger,
          dispatchLaunchMachineIntent: async () => {
            throw new Error("all steps skipped");
          },
          onWorkflowRunAccepted: async () => ({ reactionId: 1 }),
          onWorkflowRunTerminal: (run) =>
            runWithFailureTracking(
              () =>
                notifyAgentExecutionCompleted({
                  provider,
                  triggerContext: context,
                  outputContext: context,
                  result: { status: "succeeded" },
                  reactionState: run.outcome === "accepted" ? run.reactionState : null,
                }),
              logger,
            ),
        });
      let { handler, engine } = start();
      const drain = async () => {
        await engine.processAvailable();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await engine.processAvailable();
        await engine.stop();
        ({ engine } = start());
      };
      try {
        await handler(fixture.trigger("run"));
        await drain();
        const [run] = await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        );
        assert.ok(run);
        const retryable = !scenario.startsWith("missing");
        if (retryable) {
          const pending = await fixture.database.findTriggerRunById(run.id);
          assert.ok(pending?.outcome === "accepted");
          assert.equal(pending.terminalNotificationDeliveredAt, null);
          assert.ok(logs.records().length > 0);
          const failedRequests = requests.length;
          await drain();
          assert.equal(requests.length, failedRequests);
          unavailable = false;
          now = new Date(now.getTime() + 1_001);
          await drain();
          assert.ok(requests.length > failedRequests);
        }
        const delivered = await fixture.database.findTriggerRunById(run.id);
        assert.ok(delivered?.outcome === "accepted");
        assert.notEqual(delivered.terminalNotificationDeliveredAt, null);
        assert.deepEqual(
          delivered.reactionState,
          ["missing comment", "missing installation"].includes(scenario) ? null : { reactionId: 2 },
        );
        if (!retryable) assert.deepEqual(logs.records(), []);
        const settledRequests = requests.length;
        await engine.stop();
        ({ engine } = start());
        for (let lease = 0; lease < 4; lease += 1) {
          now = new Date(now.getTime() + 1_001);
          await drain();
        }
        assert.equal(requests.length, settledRequests);
        if (!retryable) assert.deepEqual(logs.records(), []);
      } finally {
        await engine.stop();
      }
    },
    60_000,
  );

  it("does not repost a GitHub billing notice after recording delivery fails", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const database = createMemoryDatabase({ now: () => now });
    const notices: string[] = [];
    const findIssueCommentByMarker = vi.fn(async ({ marker }: { marker: string }) => {
      for (const body of notices) if (body.includes(marker)) return 1;
      return undefined;
    });
    const provider = createGitHubTriggerProvider({
      configurationStoreForProject: () => {
        throw new Error("not used");
      },
      reactions: { createReaction: async () => null, deleteReaction: async () => {} },
      billingUrlForOrganization: async () => "https://hub.test/settings/billing",
      comments: {
        findIssueCommentByMarker,
        createIssueComment: async ({ body }) => ({ id: notices.push(body) }),
      },
    });
    const run = await seedGitHubBillingFailure(database, now);
    const markDelivered = vi
      .spyOn(database, "markWorkflowRunTerminalNotificationDelivered")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const lifecycle = createDaemonDispatchLifecycle({
      database,
      connectionForDaemon: () => undefined,
      providers: [provider],
    });
    const { engine } = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [],
      now: () => now,
      logger: createLogger(new FailureLogStream()),
      onWorkflowRunTerminal: (terminalRun) => lifecycle.notifyWorkflowRunTerminal(terminalRun),
    });
    try {
      await engine.processAvailable();
      await vi.waitFor(() => assert.equal(markDelivered.mock.calls.length, 1));
      assert.equal(notices.length, 1);
      const pending = await database.findTriggerRunById(run.id);
      assert.ok(pending?.outcome === "accepted");
      assert.equal(pending.terminalNotificationDeliveredAt, null);

      now = new Date(now.getTime() + 30_001);
      await engine.processAvailable();
      await vi.waitFor(async () => {
        const delivered = await database.findTriggerRunById(run.id);
        assert.ok(delivered?.outcome === "accepted");
        assert.deepEqual(delivered.terminalNotificationDeliveredAt, now);
      });
      assert.equal(findIssueCommentByMarker.mock.calls.length, 2);
      assert.equal(notices.length, 1);
    } finally {
      await engine.stop();
      await lifecycle.stop();
    }
  });

  it("retries a failed workflow terminal outbox delivery", async () => {
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    let now = new Date("2026-08-06T12:00:00.000Z");
    const delivered: string[] = [];
    let failFirst = true;
    const { handler, engine } = createDurableWorkflowHandler({
      database: fixture.database,
      entitlements: fixture.entitlements,
      providers: [providerMatch(fixture.configuration, fixture.revisionId)],
      now: () => now,
      leaseMs: 1_000,
      dispatchLaunchMachineIntent: async (intent) => {
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return { execution };
      },
      onWorkflowRunTerminal: async (run) => {
        delivered.push(run.id);
        if (failFirst) {
          failFirst = false;
          throw new Error("provider unavailable");
        }
      },
    });
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const first = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!.id,
    );
    assert.ok(first);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: first.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: now,
    });
    await fixture.database.wakeWorkflowRun(run.id, now);
    await engine.processAvailable();
    const secondStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[1]!;
    const second = await fixture.database.findAgentExecutionByWorkflowStepRunId(secondStep.id);
    assert.ok(second);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: second.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: now,
    });
    await fixture.database.wakeWorkflowRun(run.id, now);

    await engine.processAvailable();
    assert.deepEqual(delivered, [run.id]);
    const failedDelivery = await fixture.database.findTriggerRunById(run.id);
    assert.equal(
      failedDelivery?.outcome === "accepted"
        ? failedDelivery.terminalNotificationDeliveredAt
        : "missing",
      null,
    );

    now = new Date("2026-08-06T12:00:01.001Z");
    await engine.processAvailable();
    assert.deepEqual(delivered, [run.id, run.id]);
    const completedDelivery = await fixture.database.findTriggerRunById(run.id);
    assert.equal(
      completedDelivery?.outcome === "accepted"
        ? completedDelivery.terminalNotificationDeliveredAt !== null
        : false,
      true,
    );
  });

  it("does not lose a terminal notification requested during an empty recovery pass", async () => {
    const fixture = await workflowFixture({ rawConfiguration: allSkippedConfiguration() });
    let releaseInitialClaim!: () => void;
    const initialClaimRelease = new Promise<void>((resolve) => {
      releaseInitialClaim = resolve;
    });
    let markInitialClaimStarted!: () => void;
    const initialClaimStarted = new Promise<void>((resolve) => {
      markInitialClaimStarted = resolve;
    });
    const controlledDatabase = delayFirstEmptyTerminalClaim(
      fixture.database,
      markInitialClaimStarted,
      initialClaimRelease,
    );
    const delivered: string[] = [];
    const { handler, engine } = engineFor({ ...fixture, database: controlledDatabase }, [], {
      onWorkflowRunTerminal: async (run) => {
        delivered.push(run.id);
      },
    });

    await handler(fixture.trigger("run"));
    const processing = engine.processAvailable();
    await initialClaimStarted;
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    await waitUntil(
      async () => (await fixture.database.findTriggerRunById(run.id))?.status === "succeeded",
    );
    releaseInitialClaim();
    await processing;
    await waitUntil(() => Promise.resolve(delivered.length === 1));

    assert.deepEqual(delivered, [run.id]);
  });

  it("keeps processing ready wakeups while a terminal provider hook is held", async () => {
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    let releaseTerminalHook: (() => void) | undefined;
    const terminalHookStarted = new Promise<void>((resolve) => {
      releaseTerminalHook = resolve;
    });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, {
      onWorkflowRunTerminal: async () => {
        await terminalHookStarted;
      },
    });

    try {
      await handler(fixture.trigger("run"));
      await engine.processAvailable();
      const firstRun = (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
      const firstSteps = await fixture.database.listWorkflowStepRunsForTriggerRun(firstRun.id);
      const firstExecution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
        firstSteps[0]!.id,
      );
      assert.ok(firstExecution);
      await fixture.database.completeWorkflowAgentExecution({
        executionId: firstExecution.id,
        executionStatus: "failed",
        stepStatus: "failed",
        result: { status: "failed" },
        observedAt: new Date(),
      });
      await fixture.database.wakeWorkflowRun(firstRun.id, new Date());

      const terminalPassCompleted = engine.processAvailable().then(() => true);
      assert.equal(await settlesQuickly(terminalPassCompleted), true);

      const secondReceipt = await fixture.database.persistManualEvent({
        organizationId: "org-1",
        projectId: fixture.projectId,
        deliveryId: randomUUID(),
        source: "manual.run",
        payload: {},
        receivedAt: new Date(),
      });
      if (secondReceipt.status !== "accepted") throw new Error("second receipt was not accepted");
      await handler({
        ...fixture.trigger("run"),
        providerEventReceiptId: secondReceipt.event.providerEventReceiptId,
        deliveryId: secondReceipt.event.deliveryId,
      });
      await engine.processAvailable();

      assert.equal(dispatches.length, 2);
    } finally {
      releaseTerminalHook?.();
      await engine.stop();
    }
  });

  it("keeps a shared accepted receipt replayable when one project route has no workflow match", async () => {
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const secondProject = await fixture.database.createProject({
      organizationId: "org-1",
      name: "Other Workflow",
      slug: randomUUID(),
      createdByUserId: "user-1",
    });
    const secondRevision = await fixture.database.insertProjectConfigurationRevision({
      projectId: secondProject.id,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: fixture.configuration,
      contentHash: compiledConfigurationHash(fixture.configuration),
      createdByUserId: "user-1",
    });
    await fixture.database.activateProjectConfigurationRevision(
      secondProject.id,
      secondRevision.id,
      [],
    );
    const receipt = await fixture.database.findProviderEventReceiptById(
      fixture.providerEventReceiptId,
    );
    assert.ok(receipt);
    setAcceptedRoutes(fixture.database, {
      ...receipt,
      acceptedRoutes: [
        {
          projectId: fixture.projectId,
          configurationRevisionId: fixture.revisionId,
          connectionId: null,
          resourceId: null,
        },
        {
          projectId: secondProject.id,
          configurationRevisionId: secondRevision.id,
          connectionId: null,
          resourceId: null,
        },
      ],
    });
    const { handler } = createDurableWorkflowHandler({
      database: fixture.database,
      entitlements: fixture.entitlements,
      providers: [
        {
          name: "manual",
          eventNames: ["manual.run"] as const,
          async match(external) {
            if (external.projectId === fixture.projectId) return "no_trigger_for_source";
            throw new Error("enqueue unavailable");
          },
        },
      ],
    });

    await assert.rejects(
      handler({
        ...fixture.trigger("run"),
        projectId: secondProject.id,
        configurationRevisionId: secondRevision.id,
      }),
      /enqueue unavailable/iu,
    );
    assert.deepEqual(await handler(fixture.trigger("run")), {
      providerEventReceiptId: fixture.providerEventReceiptId,
    });
    const replay = await fixture.database.persistManualEvent({
      organizationId: "org-1",
      projectId: fixture.projectId,
      deliveryId: fixture.deliveryId,
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    assert.equal(replay.status, "accepted");
    const replayReceipt = await fixture.database.findProviderEventReceiptById(
      fixture.providerEventReceiptId,
    );
    assert.equal(replayReceipt?.droppedReason, "no_trigger_for_source");
  });

  it("launches the exact committed partial content with inline-equivalent interpolation", async () => {
    const content = "Committed partial for ${{ paseo.prompt }} / ${{ paseo.inputs.repo }}";
    const fixture = await workflowFixture({
      rawConfiguration: partialRuntimeConfiguration(),
      resolvedPromptPartials: new Map([
        [
          ".paseo/workflows/partials/instructions.md",
          {
            path: ".paseo/workflows/partials/instructions.md",
            content,
            contentHash: hashPromptPartialContent(content),
          },
        ],
      ]),
    });
    const dispatches: string[] = [];
    const prompts: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, {
      beforeDispatch: async (intent) => {
        prompts.push(intent.prompt);
      },
    });

    await handler(fixture.trigger("repo=hub request"));
    await engine.processAvailable();

    assert.deepEqual(dispatches, ["unknown"]);
    assert.deepEqual(prompts, [
      "Committed partial for repo=hub request / hub\nInline repo=hub request / hub",
    ]);
  });

  it("skips classification for deterministic input and launches only the matching branch", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("repo=hub work"));
    assert.equal(
      (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      ).length,
      1,
    );
    await engine.processAvailable();

    let run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0];
    assert.ok(run && run.outcome === "accepted");
    let steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.deepEqual(
      steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work-hub", "running"],
        ["work-paseo", "pending"],
      ],
    );
    assert.deepEqual(dispatches, ["work-hub"]);

    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[1]!.id);
    assert.ok(execution);
    await fixture.database.transitionAgentExecution(execution.id, "succeeded", {
      result: { status: "succeeded" },
    });
    await fixture.database.completeWorkflowStep(execution.id, "succeeded", { status: "succeeded" });
    await engine.processAvailable();
    run = await fixture.database.findTriggerRunById(run.id);
    assert.equal(run?.status, "succeeded");
    steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.deepEqual(
      steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work-hub", "succeeded"],
        ["work-paseo", "skipped"],
      ],
    );
  });

  it("runs classification when input is absent and composes its validated output", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    assert.deepEqual(dispatches, ["classify"]);
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
    assert.ok(classifier);

    await fixture.database.completeWorkflowAgentExecution({
      executionId: classifier.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded", output: { repo: "paseo" } },
      stepOutput: { repo: "paseo" },
      completedByAgent: true,
    });
    await engine.processAvailable();
    assert.deepEqual(dispatches, ["classify", "work-paseo"]);
    assert.equal(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[1]!.status,
      "skipped",
    );
  });

  it("materializes finite named environment and agent selections from classifier output", async () => {
    const fixture = await workflowFixture({
      rawConfiguration: namedSelectionConfiguration(),
      namedAgents: {
        codex: {
          provider: "codex",
          model: "gpt-5.5",
          options: {
            sandbox_workspace_write: {
              writable_roots: ["/var/cache/npm"],
              network_access: false,
            },
          },
        },
        claude: { provider: "claude", model: "claude-opus-4-8" },
      },
    });
    const dispatches: LaunchMachineIntent[] = [];
    const { handler, engine } = engineFor(fixture, [], {
      beforeDispatch: async (intent) => {
        dispatches.push(intent);
      },
    });

    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const classifierStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      classifierStep.id,
    );
    assert.ok(classifier);

    await fixture.database.completeWorkflowAgentExecution({
      executionId: classifier.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: {
        status: "succeeded",
        output: { environment: "hub", agent: "codex" },
      },
      stepOutput: { environment: "hub", agent: "codex" },
      completedByAgent: true,
    });
    await engine.processAvailable();

    assert.equal(dispatches[1]?.environmentName, "hub");
    assert.deepEqual(dispatches[1]?.agent, {
      provider: "codex",
      model: "gpt-5.5",
      options: {
        sandbox_workspace_write: {
          writable_roots: ["/var/cache/npm"],
          network_access: false,
        },
      },
    });
  });

  it("activates and executes the migrated current-project classifier-to-worker fixture", async () => {
    const bundle = compileHubBundle(await currentProjectConfigurationFiles());
    const fixture = await workflowFixture({ compiledConfiguration: bundle.configuration });
    const dispatches: LaunchMachineIntent[] = [];
    const { handler, engine } = engineFor(fixture, [], {
      beforeDispatch: async (intent) => {
        dispatches.push(intent);
      },
    });

    await handler(fixture.trigger("investigate the routing failure"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const classifierStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      classifierStep.id,
    );
    assert.ok(classifier);
    assert.equal(dispatches[0]?.environmentName, "hub");
    assert.deepEqual(dispatches[0]?.agent, { provider: "claude", mode: "bypassPermissions" });

    await fixture.database.completeWorkflowAgentExecution({
      executionId: classifier.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: {
        status: "succeeded",
        output: { environment: "hub", agent: "codex" },
      },
      stepOutput: { environment: "hub", agent: "codex" },
      completedByAgent: true,
    });
    await engine.processAvailable();

    assert.deepEqual(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id)).map(
        ({ stepId }) => stepId,
      ),
      ["classify", "work"],
    );
    assert.equal(dispatches[1]?.environmentName, "hub");
    assert.equal(dispatches[1]?.prompt, "investigate the routing failure");
    assert.deepEqual(dispatches[1]?.agent, {
      provider: "codex",
      model: "gpt-5.5",
      thinkingOptionId: "xhigh",
      options: {
        sandbox_workspace_write: {
          writable_roots: ["/var/cache/npm"],
          network_access: false,
        },
      },
    });
    assert.deepEqual(dispatches[1]?.allowOutputs, [
      { type: "discord.reply", max: 1, required: true },
    ]);
  });

  it("fails when an unavailable output is evaluated outside a short-circuited branch", async () => {
    const fixture = await workflowFixture({ unavailableValue: true });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("repo=hub work"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.status, "failed");
    assert.match(run.failureReason ?? "", /unavailable|evaluation/iu);
    assert.deepEqual(dispatches, []);
  });

  it("fails prompt interpolation that reads a skipped prior step output without dispatching", async () => {
    const fixture = await workflowFixture({ rawConfiguration: skippedOutputPromptConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.equal(run.status, "failed");
    assert.match(run.failureReason ?? "", /steps\.classify\.outputs\.repo|unavailable/iu);
    assert.deepEqual(
      steps.map((step) => [step.stepId, step.status]),
      [
        ["classify", "skipped"],
        ["work", "failed"],
      ],
    );
    assert.deepEqual(dispatches, []);
  });

  it.each([
    { name: "a later step can be skipped", later: "${{ false }}", candidate: true },
    { name: "the later step always runs", later: undefined, candidate: false },
  ])("marks the first step as a reply candidate only when $name", async ({ later, candidate }) => {
    const raw = replyCandidateConfiguration(later);
    const compiled = structuredClone(compileHubConfig(raw));
    for (const trigger of compiled.triggers) trigger.replyMessage = true;
    const fixture = await workflowFixture({
      rawConfiguration: raw,
      compiledConfiguration: compiled,
    });
    const intents: LaunchMachineIntent[] = [];
    const { handler, engine } = engineFor(fixture, [], {
      beforeDispatch: async (intent) => {
        intents.push(intent);
      },
    });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.replyCaptureCandidate, candidate ? true : undefined);
    assert.equal(intents[0]?.replyMessage, undefined);
    assert.deepEqual(intents[0]?.allowOutputs, []);
  });

  it("does not persist or dispatch skipped-step GitHub authority", async () => {
    const fixture = await workflowFixture({ rawConfiguration: skippedAuthorityConfiguration() });
    const intents: LaunchMachineIntent[] = [];
    const { handler, engine } = engineFor(fixture, [], {
      beforeDispatch: async (intent) => {
        intents.push(intent);
      },
    });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.deepEqual(
      steps.map((step) => [step.stepId, step.status]),
      [
        ["classifier", "skipped"],
        ["work", "running"],
      ],
    );
    assert.equal(
      await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id),
      undefined,
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.github, undefined);
    assert.deepEqual(intents[0]?.env, {
      SOME_TOKEN: "${{ paseo.connections.some-connection.token }}",
    });
  });

  it("persists final values composed from a one-step structured output", async () => {
    const fixture = await workflowFixture({ rawConfiguration: finalValueConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: execution.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded", output: { decision: "ship" } },
      stepOutput: { decision: "ship" },
      completedByAgent: true,
    });
    await engine.processAvailable();

    const completed = await fixture.database.findTriggerRunById(run.id);
    assert.equal(completed?.status, "succeeded");
    assert.deepEqual(completed?.values, { final_decision: "ship" });
  });

  it("fails a classifier without launching downstream work", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
    assert.ok(classifier);
    await fixture.database.transitionAgentExecution(classifier.id, "failed", {
      result: { reason: "classifier_failed" },
    });
    await fixture.database.completeWorkflowStep(
      classifier.id,
      "failed",
      { reason: "classifier_failed" },
      "classifier_failed",
    );
    await engine.processAvailable();
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "failed");
    assert.deepEqual(dispatches, ["classify"]);
  });

  it("times out a classifier without launching downstream work", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("investigate"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
    assert.ok(classifier);
    await fixture.database.transitionAgentExecution(classifier.id, "failed", {
      result: { reason: "timed_out" },
    });
    await fixture.database.completeWorkflowStep(
      classifier.id,
      "timed_out",
      { reason: "timed_out" },
      "timed_out",
    );
    await engine.processAvailable();
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "timed_out");
    assert.deepEqual(dispatches, ["classify"]);
  });

  it("restarts after structured completion and creates exactly one downstream execution", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const first = engineFor(fixture, dispatches);
    await first.handler(fixture.trigger("investigate"));
    await first.engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const classifierStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const classifier = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      classifierStep.id,
    );
    assert.ok(classifier);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: classifier.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded", output: { repo: "hub" } },
      stepOutput: { repo: "hub" },
      completedByAgent: true,
    });

    const restarted = engineFor(fixture, dispatches);
    await restarted.engine.processAvailable();
    await fixture.database.wakeWorkflowRun(run.id, new Date());
    await restarted.engine.processAvailable();
    assert.deepEqual(dispatches, ["classify", "work-hub"]);
    assert.equal(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id)).filter(
        (step) => step.agentExecutionId !== null,
      ).length,
      2,
    );
  });

  it.each([
    { terminalStatus: "succeeded" as const, expectedRunStatus: "running" as const },
    { terminalStatus: "failed" as const, expectedRunStatus: "failed" as const },
  ])(
    "reconciles a terminal $terminalStatus execution before evaluating downstream work",
    async ({ terminalStatus, expectedRunStatus }) => {
      const fixture = await workflowFixture({ terminalRecovery: true });
      const dispatches: string[] = [];
      const first = engineFor(fixture, dispatches);
      await first.handler(fixture.trigger("repo=hub work"));
      await first.engine.processAvailable();

      const run = (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
      const firstStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const firstExecution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
        firstStep.id,
      );
      assert.ok(firstExecution);
      assert.deepEqual(dispatches, ["first"]);

      await fixture.database.transitionAgentExecution(firstExecution.id, terminalStatus, {
        result: { status: terminalStatus },
      });

      const restarted = engineFor(fixture, dispatches, {
        beforeDispatch: async (intent) => {
          if (intent.prompt !== "Downstream") return;
          assert.equal(
            (await fixture.database.findWorkflowStepRunById(firstStep.id))?.status,
            terminalStatus,
          );
        },
      });
      await restarted.engine.processAvailable();
      await restarted.engine.processAvailable();

      assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, expectedRunStatus);
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(firstStep.id))?.status,
        terminalStatus,
      );
      assert.deepEqual(
        dispatches,
        terminalStatus === "succeeded" ? ["first", "downstream"] : ["first"],
      );
    },
  );

  it.each([
    { executionStatus: "succeeded" as const, stepStatus: "succeeded" as const },
    { executionStatus: "failed" as const, stepStatus: "failed" as const },
    { executionStatus: "failed" as const, stepStatus: "timed_out" as const },
  ])(
    "atomically completes workflow-owned $stepStatus agent executions in memory",
    async ({ executionStatus, stepStatus }) => {
      const fixture = await workflowFixture({ terminalRecovery: true });
      const dispatches: string[] = [];
      const { handler, engine } = engineFor(fixture, dispatches);
      await handler(fixture.trigger("repo=hub work"));
      await engine.processAvailable();
      const run = (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
      const firstStep = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(firstStep.id);
      assert.ok(execution);

      const terminal = await fixture.database.completeWorkflowAgentExecution({
        executionId: execution.id,
        executionStatus,
        stepStatus,
        result: { status: executionStatus, reason: stepStatus },
        stepOutput: { status: stepStatus },
      });
      const duplicate = await fixture.database.completeWorkflowAgentExecution({
        executionId: execution.id,
        executionStatus,
        stepStatus,
        result: { status: executionStatus, reason: "duplicate" },
        stepOutput: { status: "duplicate" },
      });

      assert.equal(terminal.transitioned, true);
      assert.equal(duplicate.transitioned, false);
      assert.equal(
        (await fixture.database.findAgentExecutionById(execution.id))?.status,
        executionStatus,
      );
      assert.equal(
        (await fixture.database.findWorkflowStepRunById(firstStep.id))?.status,
        stepStatus,
      );
      assert.equal(
        (await fixture.database.findTriggerRunById(run.id))?.status,
        stepStatus === "succeeded" ? "running" : stepStatus,
      );
      await engine.processAvailable();
      assert.deepEqual(
        dispatches,
        stepStatus === "succeeded" ? ["first", "downstream"] : ["first"],
      );
    },
  );

  it("persists step hard and idle deadlines capped by the whole-run deadline", async () => {
    const now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, { now: () => now });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    assert.equal(execution.deadlineAt?.toISOString(), "2026-08-06T12:01:00.000Z");
    assert.equal(execution.idleDeadlineAt?.toISOString(), "2026-08-06T12:00:20.000Z");

    assert.equal(run.deadlineAt.toISOString(), "2026-08-06T12:02:00.000Z");
  });

  it("times out a live step when the whole-run deadline expires", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({
      rawConfiguration: deadlineConfiguration({ idleTimeout: "1m" }),
    });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, { now: () => now });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);

    now = new Date("2026-08-06T12:02:00.000Z");
    await engine.processAvailable();

    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "timed_out");
    assert.equal((await fixture.database.findWorkflowStepRunById(step.id))?.status, "timed_out");
    assert.equal((await fixture.database.findAgentExecutionById(execution.id))?.status, "failed");
  });

  it("fails a step at its hard deadline without extending the run", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({
      rawConfiguration: deadlineConfiguration({ idleTimeout: "1m" }),
    });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, { now: () => now });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    now = new Date("2026-08-06T12:01:00.000Z");
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    assert.equal(run.status, "timed_out");
    assert.equal(run.deadlineKind, "step_hard");
    assert.equal(step.status, "timed_out");
    assert.equal(step.deadlineKind, "step_hard");
    assert.equal(dispatches.length, 1);
  });

  it("refreshes only the persisted idle deadline for a live workflow step", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, { now: () => now });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    const hardDeadline = execution.deadlineAt;

    now = new Date("2026-08-06T12:00:10.000Z");
    const refreshed = await fixture.database.setAgentExecutionIdleDeadline(
      execution.id,
      new Date("2026-08-06T12:00:30.000Z"),
      now,
      now,
    );
    assert.equal(refreshed.deadlineAt?.getTime(), hardDeadline?.getTime());
    assert.equal(refreshed.idleDeadlineAt?.toISOString(), "2026-08-06T12:00:30.000Z");
    assert.equal(
      (await fixture.database.findWorkflowStepRunById(step.id))?.idleDeadlineAt?.toISOString(),
      "2026-08-06T12:00:30.000Z",
    );
  });

  it("does not dispatch a later step after the whole-run deadline between steps", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, { now: () => now });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const first = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const firstExecution = await fixture.database.findAgentExecutionByWorkflowStepRunId(first.id);
    assert.ok(firstExecution);
    await fixture.database.transitionAgentExecution(firstExecution.id, "succeeded", {
      result: { status: "succeeded" },
    });
    await fixture.database.completeWorkflowStep(firstExecution.id, "succeeded", {
      status: "succeeded",
    });

    now = new Date("2026-08-06T12:02:00.000Z");
    await engine.processAvailable();

    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.equal(dispatches.length, 1);
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "timed_out");
    assert.equal(steps[1]?.status, "timed_out");
    assert.equal(steps[1]?.deadlineKind, "whole_run");
  });

  it("wins a completion-at-deadline race with the deadline transition", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({
      rawConfiguration: deadlineConfiguration({ idleTimeout: "1m" }),
    });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches, { now: () => now });

    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.outcome, "accepted");
    const step = (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(step.id);
    assert.ok(execution);
    now = execution.deadlineAt!;

    const completion = await fixture.database.completeWorkflowAgentExecution({
      executionId: execution.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: now,
    });
    assert.equal(completion.deadlineKind, "step_hard");
    assert.equal(completion.execution.status, "failed");
    assert.equal((await fixture.database.findTriggerRunById(run.id))?.status, "timed_out");
  });

  it("meters one unit per execution, not once per trigger, across a multi-step workflow", async () => {
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const first = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!.id,
    );
    assert.ok(first);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: first.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: new Date(),
    });
    await fixture.database.wakeWorkflowRun(run.id, new Date());
    await engine.processAvailable();

    // Two executions were created, so two units were consumed — the old once-per-trigger meter
    // would report 1 here.
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 2);
    assert.equal(dispatches.length, 2);
  });

  it("denies the second execution once the meter is full and fails that run with the reason", async () => {
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    await fixture.entitlements.override(
      "org-1",
      { meters: { "executions.monthly": { limit: 1 } } },
      "admin-1",
      "Trial cap",
    );
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("run"));
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const first = await fixture.database.findAgentExecutionByWorkflowStepRunId(
      (await fixture.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!.id,
    );
    assert.ok(first);
    await fixture.database.completeWorkflowAgentExecution({
      executionId: first.id,
      executionStatus: "succeeded",
      stepStatus: "succeeded",
      result: { status: "succeeded" },
      observedAt: new Date(),
    });
    await fixture.database.wakeWorkflowRun(run.id, new Date());
    await engine.processAvailable();

    const failed = await fixture.database.findTriggerRunById(run.id);
    assert.equal(failed?.status, "failed");
    assert.match(
      failed?.outcome === "accepted" ? (failed.failureReason ?? "") : "",
      /executions\.monthly/u,
    );
    // Only the first execution was ever created; the denied second one reserved nothing.
    assert.equal(dispatches.length, 1);
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);
  });

  it("denies a second single-execution trigger once the meter is full", async () => {
    const fixture = await workflowFixture();
    await fixture.entitlements.override(
      "org-1",
      { meters: { "executions.monthly": { limit: 1 } } },
      "admin-1",
      "Trial cap",
    );
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);

    await handler(fixture.trigger("repo=hub work"));
    await engine.processAvailable();
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);

    const second = await fixture.database.persistManualEvent({
      organizationId: "org-1",
      projectId: fixture.projectId,
      deliveryId: randomUUID(),
      source: "manual.run",
      payload: {},
      receivedAt: new Date(),
    });
    if (second.status !== "accepted") throw new Error("second receipt was not accepted");
    await handler({
      ...fixture.trigger("repo=hub work"),
      providerEventReceiptId: second.event.providerEventReceiptId,
      deliveryId: second.event.deliveryId,
    });
    await engine.processAvailable();

    const secondRun = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(
        second.event.providerEventReceiptId,
      )
    )[0];
    assert.equal(secondRun?.status, "failed");
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);
    assert.equal(dispatches.length, 1);
  });

  it("meters nothing when an accepted trigger skips every step", async () => {
    const fixture = await workflowFixture({ rawConfiguration: allSkippedConfiguration() });
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    await engine.processAvailable();

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    assert.equal(run.status, "succeeded");
    assert.deepEqual(dispatches, []);
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 0);
  });

  it("does not double-consume when an already-running execution is replayed", async () => {
    const fixture = await workflowFixture();
    const dispatches: string[] = [];
    const { handler, engine } = engineFor(fixture, dispatches);
    await handler(fixture.trigger("repo=hub work"));
    await engine.processAvailable();
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);

    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    await fixture.database.wakeWorkflowRun(run.id, new Date());
    await engine.processAvailable();

    // The step's execution is already live, so re-processing the wakeup creates nothing new.
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);
    assert.equal(dispatches.length, 1);
  });

  it("does not double-consume when dispatch crashes after an execution is reserved", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: deadlineConfiguration() });
    let crashNextDispatch = true;
    const { handler, engine } = createDurableWorkflowHandler({
      database: fixture.database,
      entitlements: fixture.entitlements,
      providers: [providerMatch(fixture.configuration, fixture.revisionId)],
      now: () => now,
      leaseMs: 1_000,
      dispatchLaunchMachineIntent: async (intent) => {
        if (crashNextDispatch) {
          crashNextDispatch = false;
          throw new Error("dispatch crashed after reservation");
        }
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return { execution };
      },
    });
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    // The execution was created and one unit reserved before dispatch threw.
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);

    now = new Date("2026-08-06T12:00:02.000Z");
    await engine.processAvailable();

    // Recovery re-dispatches the already-created execution; it does not reserve a second unit.
    assert.equal((await fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);
  });

  it("does not rematerialize context when recovering a persisted pre-handoff execution", async () => {
    let now = new Date("2026-08-06T12:00:00.000Z");
    const fixture = await workflowFixture({ rawConfiguration: contextOnlyConfiguration() });
    let materializations = 0;
    let crashNextDispatch = true;
    const provider = {
      ...providerMatch(fixture.configuration, fixture.revisionId),
      async materializeContext() {
        materializations += 1;
        return { ambient: "once" };
      },
    } satisfies TriggerProvider;
    const { handler, engine } = createDurableWorkflowHandler({
      database: fixture.database,
      entitlements: fixture.entitlements,
      providers: [provider],
      now: () => now,
      leaseMs: 1_000,
      dispatchLaunchMachineIntent: async (intent) => {
        if (crashNextDispatch) {
          crashNextDispatch = false;
          throw new Error("dispatch crashed after reservation");
        }
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return { execution };
      },
    });
    await handler(fixture.trigger("run"));
    await engine.processAvailable();
    now = new Date("2026-08-06T12:00:02.000Z");
    await engine.processAvailable();

    assert.equal(materializations, 1);
    const run = (
      await fixture.database.findTriggerRunsByProviderEventReceiptId(fixture.providerEventReceiptId)
    )[0]!;
    const steps = await fixture.database.listWorkflowStepRunsForTriggerRun(run.id);
    const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
    assert.equal(execution?.launchIntent?.prompt, 'Context: {"ambient":"once"}\nTrigger: run');
  });
});

describe("workflow engine transient database failures", () => {
  const poolTimeout = () => new Error("timeout exceeded when trying to connect");

  /** Fails the named database methods with `error` this many times, then lets them through. */
  function withFaults(
    database: Database,
    error: () => Error = poolTimeout,
  ): { database: Database; fail(method: keyof Database, times: number): void } {
    const remaining = new Map<PropertyKey, number>();
    const proxy = new Proxy(database, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const left = remaining.get(property) ?? 0;
          if (left > 0) {
            remaining.set(property, left - 1);
            throw error();
          }
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
    return { database: proxy, fail: (method, times) => remaining.set(method, times) };
  }

  async function setup(options: { error?: () => Error } = {}) {
    const fixture = await workflowFixture({ rawConfiguration: contextOnlyConfiguration() });
    const faulty = withFaults(fixture.database, options.error);
    const stream = new FailureLogStream();
    const sleeps: number[] = [];
    const dispatches: string[] = [];
    const failDispatch = { times: 0 };
    const provider = {
      ...providerMatch(fixture.configuration, fixture.revisionId),
      async materializeContext() {
        return { ambient: "once" };
      },
    } satisfies TriggerProvider;
    const { handler, engine } = createDurableWorkflowHandler({
      database: faulty.database,
      entitlements: fixture.entitlements,
      providers: [provider],
      logger: createLogger(stream),
      retry: {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        random: () => 1,
      },
      dispatchLaunchMachineIntent: async (intent) => {
        if (failDispatch.times > 0) {
          failDispatch.times -= 1;
          throw (options.error ?? poolTimeout)();
        }
        dispatches.push(dispatchLabel(intent));
        const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId!,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return { execution };
      },
    });
    await handler(fixture.trigger("run"));
    const run = async () =>
      (
        await fixture.database.findTriggerRunsByProviderEventReceiptId(
          fixture.providerEventReceiptId,
        )
      )[0]!;
    const finish = async () => {
      const steps = await fixture.database.listWorkflowStepRunsForTriggerRun((await run()).id);
      const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(steps[0]!.id);
      assert.ok(execution);
      await fixture.database.transitionAgentExecution(execution.id, "succeeded", {
        result: { status: "succeeded" },
      });
      await engine.processAvailable();
    };
    return { fixture, faulty, stream, sleeps, dispatches, failDispatch, engine, run, finish };
  }

  it("retries a pool acquire timeout while preparing the wakeup and the run ends succeeded", async () => {
    const test = await setup();
    test.faulty.fail("findTriggerRunById", 2);
    await test.engine.processAvailable();
    assert.deepEqual(test.sleeps, [250, 500]);
    assert.equal((await test.run()).status, "running");
    assert.equal(test.dispatches.length, 1);
    await test.finish();
    assert.equal((await test.run()).status, "succeeded");
    assert.equal(test.stream.records().length, 2, "each retry is a warning, not a failure");
    assert.ok(test.stream.records().every((record) => record["level"] === 40));
  });

  it("retries a reset connection while creating the execution without a second reservation", async () => {
    const test = await setup({ error: () => new Error("Connection terminated unexpectedly") });
    test.faulty.fail("createWorkflowStepExecution", 2);
    await test.engine.processAvailable();
    assert.equal(test.dispatches.length, 1);
    assert.equal((await test.fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);
    await test.finish();
    assert.equal((await test.run()).status, "succeeded");
  });

  it("retries a failed dispatch of a created execution once and launches it exactly once", async () => {
    const test = await setup();
    test.failDispatch.times = 2;
    await test.engine.processAvailable();
    assert.deepEqual(test.sleeps, [250, 500]);
    assert.equal(test.dispatches.length, 1);
    assert.equal((await test.fixture.entitlements.usage("org-1", "executions.monthly")).used, 1);
    await test.finish();
    assert.equal((await test.run()).status, "succeeded");
  });

  it("retries a serialization failure", async () => {
    const test = await setup({
      error: () => Object.assign(new Error("could not serialize access"), { code: "40001" }),
    });
    test.faulty.fail("linkWorkflowStepRunExecution", 1);
    await test.engine.processAvailable();
    assert.equal(test.dispatches.length, 1);
    await test.finish();
    assert.equal((await test.run()).status, "succeeded");
  });

  it("reports one failure with the attempt count when every attempt fails, and keeps the run alive", async () => {
    const test = await setup();
    test.faulty.fail("findTriggerRunById", 100);
    await test.engine.processAvailable();
    assert.equal(test.sleeps.length, 5);
    const failures = test.stream.records().filter((record) => record["level"] === 50);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!["operation"], "workflow.wakeup.process");
    assert.match(JSON.stringify(failures[0]), /"attempts":6/u);
    assert.equal(test.dispatches.length, 0);
    assert.equal((await test.run()).status, "running");
  });

  it("fails fast on an error that is not transient", async () => {
    const test = await setup({ error: () => new Error("workflow trigger not found") });
    test.faulty.fail("findTriggerRunById", 1);
    await test.engine.processAvailable();
    assert.deepEqual(test.sleeps, []);
    const failures = test.stream.records().filter((record) => record["level"] === 50);
    assert.equal(failures.length, 1);
    assert.equal(JSON.stringify(failures[0]).includes("attempts"), false);
  });
});

interface Fixture {
  database: Database;
  entitlements: EntitlementsService;
  providerEventReceiptId: string;
  deliveryId: string;
  projectId: string;
  revisionId: string;
  configuration: CompiledHubConfig;
  trigger(message: string): DurableProviderEvent;
}

async function seedGitHubBillingFailure(database: Database, now: Date) {
  const context = githubBillingTriggerContext();
  const { run } = await database.createAcceptedTriggerRun({
    organizationId: context.organizationId,
    projectId: "billing-project",
    configurationRevisionId: "billing-revision",
    providerEventReceiptId: "billing-receipt",
    configuredTriggerName: "billing",
    prompt: "raw",
    inputs: {},
    triggerContext: context,
    outputContext: context,
    deadlineAt: new Date(now.getTime() + 60_000),
    stepIds: ["step"],
  });
  await database.failWorkflowRun(run.id, "failed", GITHUB_BILLING_DENIAL);
  return run;
}

async function workflowFixture(
  options: {
    unavailableValue?: boolean;
    terminalRecovery?: boolean;
    rawConfiguration?: Record<string, unknown>;
    compiledConfiguration?: CompiledHubConfig;
    resolvedPromptPartials?: ResolvedPromptPartials;
    namedAgents?: Record<string, CompiledAgent>;
  } = {},
): Promise<Fixture> {
  const database = createMemoryDatabase({ organizationIds: ["org-1"] });
  // A real EntitlementsService over the SAME database the engine uses — not an auto-unlimited
  // proxy over a separate store. Metering the engine performs is therefore observable here, and
  // a per-execution regression actually fails these tests. Stamped unlimited by default; tests
  // that exercise the meter override it down.
  const entitlements = new EntitlementsService(database, { seats: async () => 0 });
  await entitlements.stamp("org-1", UNLIMITED_TEMPLATE, { source: "provisioning", planId: null });
  const project = await database.createProject({
    organizationId: "org-1",
    name: "Workflow",
    slug: randomUUID(),
    createdByUserId: "user-1",
  });
  const raw =
    options.rawConfiguration ??
    (options.terminalRecovery ? terminalRecoveryConfiguration() : baseConfiguration(options));
  const compiled =
    options.compiledConfiguration ??
    compileHubConfig(raw, {
      ...(options.resolvedPromptPartials === undefined
        ? {}
        : { resolvedPromptPartials: options.resolvedPromptPartials }),
      ...(options.namedAgents === undefined ? {} : { namedAgents: options.namedAgents }),
    });
  const configuration: CompiledHubConfig = {
    environments: compiled.environments.map((environment) => {
      if (environment.kind !== "daemon") return environment;
      return {
        name: environment.name,
        kind: "daemon",
        daemon: environment.daemon,
        daemonId: "daemon-1",
        cwd: environment.cwd,
        ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
      };
    }),
    triggers: compiled.triggers,
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
  if (receipt.status !== "accepted") throw new Error("workflow receipt was not accepted");
  return {
    database,
    entitlements,
    providerEventReceiptId: receipt.event.providerEventReceiptId,
    deliveryId: receipt.event.deliveryId,
    projectId: project.id,
    revisionId: revision.id,
    configuration,
    trigger(message) {
      return {
        providerEventReceiptId: receipt.event.providerEventReceiptId,
        organizationId: "org-1",
        projectId: project.id,
        configurationRevisionId: revision.id,
        source: "manual.run",
        deliveryId: receipt.event.deliveryId,
        payload: { input: message },
        receivedAt: new Date(),
        connectionId: null,
        resourceId: null,
      };
    },
  };
}

function setAcceptedRoutes(database: Database, receipt: ProviderEventReceiptRecord): void {
  const receipts: unknown = Reflect.get(database, "providerEventReceipts");
  if (!(receipts instanceof Map)) throw new Error("memory receipt store unavailable");
  receipts.set(receipt.id, receipt);
}

function partialRuntimeConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "partial-request",
        on: "manual.run",
        max_runtime: "1h",
        inputs: { repo: { type: "string", choices: ["hub"] } },
        steps: [
          {
            id: "work-hub",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [
              { include: "partials/instructions.md" },
              { text: "Inline ${{ paseo.prompt }} / ${{ paseo.inputs.repo }}" },
            ],
          },
        ],
      },
    ],
  };
}

async function assertMaterializedIntent(intent: LaunchMachineIntent, fixture: Fixture) {
  const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
    intent.workflowStepRunId!,
  );
  assert.ok(execution);
  assert.equal(intent.background, intent.triggerName === "first");
  assert.equal(intent.completeOnTurnEnd, intent.triggerName === "first" ? true : undefined);
  assert.equal("completeOnTurnEnd" in intent, intent.triggerName === "first");
  assert.equal(
    execution.launchIntent?.completeOnTurnEnd,
    intent.triggerName === "first" ? true : undefined,
  );
  assert.deepEqual(intent.continuation?.compatibility, {
    agent: intent.agent,
    target: fixture.configuration.environments[0],
    ...(intent.background ? { background: true } : {}),
    env: {},
    github: null,
  });
  assert.equal(
    intent.title,
    intent.triggerName === "first" ? `Intake \u00b7 ${execution.id}` : undefined,
  );
  assert.equal(
    execution.launchIntent?.environment.worktree?.mode === "branch-off"
      ? execution.launchIntent.environment.worktree.newBranch
      : undefined,
    `trigger-${execution.id}`,
  );
}

function engineFor(
  fixture: Fixture,
  dispatches: string[],
  options: {
    beforeDispatch?: (intent: LaunchMachineIntent) => Promise<void>;
    now?: () => Date;
    onWorkflowRunTerminal?: (run: TriggerRunRecord) => Promise<void>;
    canDispatchToDaemon?: (daemonId: string) => boolean;
  } = {},
) {
  const { beforeDispatch, now, onWorkflowRunTerminal, canDispatchToDaemon } = options;
  return createDurableWorkflowHandler({
    database: fixture.database,
    entitlements: fixture.entitlements,
    providers: [providerMatch(fixture.configuration, fixture.revisionId)],
    ...(now === undefined ? {} : { now }),
    ...(canDispatchToDaemon === undefined ? {} : { canDispatchToDaemon }),
    ...(onWorkflowRunTerminal === undefined ? {} : { onWorkflowRunTerminal }),
    dispatchLaunchMachineIntent: async (intent) => {
      await beforeDispatch?.(intent);
      dispatches.push(dispatchLabel(intent));
      const execution = await fixture.database.findAgentExecutionByWorkflowStepRunId(
        intent.workflowStepRunId!,
      );
      if (execution === undefined) throw new Error("workflow execution was not persisted");
      return {
        execution,
      };
    },
  });
}

function deadlineConfiguration(options: { idleTimeout?: string } = {}): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "deadline-route",
        on: "manual.run",
        max_runtime: "2m",
        steps: [
          {
            id: "first",
            environment: "runner",
            max_runtime: "1m",
            idle_timeout: options.idleTimeout ?? "20s",
            agent: { provider: "codex" },
            prompt: [{ text: "run" }],
          },
          {
            id: "second",
            environment: "runner",
            max_runtime: "1m",
            idle_timeout: options.idleTimeout ?? "20s",
            agent: { provider: "codex" },
            prompt: [{ text: "run" }],
          },
        ],
      },
    ],
  };
}

function contextOptInConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "context-opt-in",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "without-context",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Trigger: ${{ paseo.prompt }}" }],
          },
          {
            id: "with-context",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Context: ${{ paseo.context }}\nTrigger: ${{ paseo.prompt }}" }],
          },
        ],
      },
    ],
  };
}

function contextOnlyConfiguration(): Record<string, unknown> {
  const configuration = contextOptInConfiguration();
  const triggers = readUnknownArray(configuration["triggers"]);
  const trigger = triggers?.[0];
  const steps = isRecord(trigger) ? readUnknownArray(trigger["steps"]) : undefined;
  if (trigger === undefined || steps?.[1] === undefined) {
    throw new Error("context opt-in fixture is incomplete");
  }
  return {
    ...configuration,
    triggers: [{ ...trigger, steps: [steps[1]] }],
  };
}

function terminalReactionStatus(options: {
  method: string;
  scenario: string;
  unavailable: boolean;
}): number {
  const { method, scenario, unavailable } = options;
  if (method === "DELETE") return scenario === "cleanup 500" && unavailable ? 500 : 404;
  if (scenario === "missing comment") return 404;
  if (unavailable && scenario === "transport") throw new TypeError("fetch failed");
  return unavailable && ["429", "500", "401", "403"].includes(scenario) ? Number(scenario) : 201;
}

function allSkippedConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "all-skipped",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "never",
            if: "${{ false }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Never runs" }],
          },
        ],
      },
    ],
  };
}

function skippedOutputPromptConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "skipped-output-prompt",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "classify",
            if: "${{ false }}",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Classify" }],
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["repo"],
                properties: { repo: { enum: ["hub"] } },
              },
            },
          },
          {
            id: "work",
            if: "${{ true }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Repo ${{ steps.classify.outputs.repo }}" }],
          },
        ],
      },
    ],
  };
}

function namedSelectionConfiguration(): Record<string, unknown> {
  return {
    environments: [
      { name: "paseo", kind: "daemon", daemon: "runner", cwd: "/workspace/paseo" },
      { name: "hub", kind: "daemon", daemon: "runner", cwd: "/workspace/hub" },
    ],
    triggers: [
      {
        name: "named-selection",
        on: "manual.run",
        max_runtime: "1h",
        values: {
          environment: "${{ steps.classifier.outputs.environment }}",
          agent: "${{ steps.classifier.outputs.agent }}",
        },
        steps: [
          {
            id: "classifier",
            environment: "paseo",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Classify" }],
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["environment", "agent"],
                properties: {
                  environment: { enum: ["paseo", "hub"] },
                  agent: { enum: ["codex", "claude"] },
                },
              },
            },
          },
          {
            id: "worker",
            environment: "${{ values.environment }}",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: "${{ values.agent }}",
            prompt: [{ text: "Work" }],
          },
        ],
      },
    ],
  };
}

function replyCandidateConfiguration(laterCondition: string | undefined): Record<string, unknown> {
  const step = (id: string, condition?: string) => ({
    id,
    ...(condition === undefined ? {} : { if: condition }),
    environment: "runner",
    max_runtime: "10m",
    idle_timeout: "1m",
    agent: { provider: "codex" },
    prompt: [{ text: id }],
  });
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "reply-candidate",
        on: "manual.run",
        max_runtime: "1h",
        steps: [step("first"), step("last", laterCondition)],
      },
    ],
  };
}

function skippedAuthorityConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "skipped-authority",
        on: "manual.run",
        max_runtime: "1h",
        steps: [
          {
            id: "classifier",
            if: "${{ false }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Classify" }],
            github: {
              connection: "getpaseo-github",
              repositories: ["getpaseo/paseo"],
              permissions: { contents: "write" },
            },
          },
          {
            id: "work",
            if: "${{ true }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work" }],
            env: { SOME_TOKEN: "${{ paseo.connections.some-connection.token }}" },
          },
        ],
      },
    ],
  };
}

function finalValueConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "final-value",
        on: "manual.run",
        max_runtime: "1h",
        values: {
          final_decision: "${{ steps.decide.outputs.decision }}",
        },
        steps: [
          {
            id: "decide",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Decide" }],
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["decision"],
                properties: { decision: { enum: ["ship"] } },
              },
            },
          },
        ],
      },
    ],
  };
}

function providerMatch(configuration: CompiledHubConfig, revisionId: string) {
  return {
    name: "manual",
    eventNames: ["manual.run"] as const,
    async match(external): Promise<readonly AcceptedTriggerProviderMatch[]> {
      const trigger = configuration.triggers[0]!;
      const input =
        isRecord(external.payload) && typeof external.payload["input"] === "string"
          ? external.payload["input"]
          : "";
      const invocation = parseInvocation(input, trigger.inputs);
      if (invocation.status !== "accepted")
        throw new Error("test invocation unexpectedly rejected");
      return [
        {
          triggerName: trigger.name,
          triggerContext: { provider: "manual" },
          outputContext: { provider: "manual" },
          configurationRevisionId: revisionId,
          hubConfig: configuration,
          conversation: null,
          invocation,
        },
      ];
    },
  } satisfies TriggerProvider;
}

function baseConfiguration(options: { unavailableValue?: boolean }): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "route-request",
        on: "manual.run",
        max_runtime: "1h",
        inputs: { repo: { type: "string", choices: ["paseo", "hub"] } },
        values: {
          repo:
            options.unavailableValue === true
              ? "${{ steps.classify.outputs.repo }}"
              : "${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}",
        },
        steps: [
          {
            id: "classify",
            if: "${{ paseo.inputs.repo == null }}",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Classify" }],
            output: {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["repo"],
                properties: { repo: { enum: ["paseo", "hub"] } },
              },
            },
          },
          {
            id: "work-hub",
            if: "${{ values.repo == 'hub' }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work hub" }],
          },
          {
            id: "work-paseo",
            if: "${{ values.repo == 'paseo' }}",
            environment: "runner",
            max_runtime: "10m",
            idle_timeout: "1m",
            agent: { provider: "codex" },
            prompt: [{ text: "Work paseo" }],
          },
        ],
      },
    ],
  };
}

function terminalRecoveryConfiguration(): Record<string, unknown> {
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/workspace" }],
    triggers: [
      {
        name: "terminal-recovery",
        on: "manual.run",
        max_runtime: "1h",
        inputs: { repo: { type: "string", choices: ["hub"] } },
        steps: [
          {
            id: "first",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "First" }],
          },
          {
            id: "downstream",
            if: "${{ paseo.inputs.repo == 'hub' }}",
            environment: "runner",
            max_runtime: "2m",
            idle_timeout: "30s",
            agent: { provider: "codex" },
            prompt: [{ text: "Downstream" }],
          },
        ],
      },
    ],
  };
}

function executionWorktreeConfiguration(): Record<string, unknown> {
  const step = (id: string, title?: string) => ({
    id,
    environment: "runner",
    max_runtime: "10m",
    idle_timeout: "1m",
    agent: { provider: "codex" },
    ...(title === undefined ? {} : { title, background: true, complete_on_turn_end: true }),
    prompt: [{ text: "Do the work." }],
  });
  return {
    environments: [
      {
        name: "runner",
        kind: "daemon",
        daemon: "runner",
        cwd: "/workspace",
        worktree: { mode: "branch-off", newBranch: "trigger-${{ paseo.execution.id }}" },
      },
    ],
    triggers: ["first", "second"].map((name) => ({
      name,
      on: "manual.run",
      max_runtime: "1h",
      steps: [
        step(`work-${name}`, name === "first" ? "Intake · ${{ paseo.execution.id }}" : undefined),
      ],
    })),
  };
}

function dispatchLabel(intent: {
  workflowStepRunId?: string;
  triggerName: string;
  prompt: string;
}): string {
  if (intent.workflowStepRunId === undefined) return "missing";
  if (intent.prompt === "First") return "first";
  if (intent.prompt === "Downstream") return "downstream";
  if (intent.triggerName !== "route-request") return "unknown";
  if (intent.prompt.startsWith("Classify")) return "classify";
  return intent.prompt.includes("paseo") ? "work-paseo" : "work-hub";
}

async function settlesQuickly<T>(promise: Promise<T>): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
}

async function waitUntil(observation: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await observation()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for workflow state");
}

function delayFirstEmptyTerminalClaim(
  database: Database,
  markStarted: () => void,
  release: Promise<void>,
): Database {
  let firstClaim = true;
  return new Proxy(database, {
    get(target, property) {
      if (property === "claimPendingWorkflowRunTerminalNotification") {
        return async (now: Date, leaseMs: number) => {
          if (firstClaim) {
            firstClaim = false;
            markStarted();
            await release;
            return undefined;
          }
          return target.claimPendingWorkflowRunTerminalNotification(now, leaseMs);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return value;
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnknownArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
