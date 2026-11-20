import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { AgentSessions } from "./index.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { AgentExecutionRecord } from "../db/types.js";
import { OutputExecutorRegistry, replyOutputTool } from "../execution-capabilities/outputs.js";
import { FinishCallRegistry } from "../execution-capabilities/finish-calls.js";
import { createExecutionCapabilityServer } from "../execution-capabilities/server.js";
import { TestAgents } from "./test-utils.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { RunPayloadRetention } from "../run-payload-retention/index.js";
import {
  build14Selection,
  credentialHistories,
  upgradedSelection,
  type LegacyLaunchIntent,
} from "./credential-test-fixtures.js";

async function fixture(
  now = Date.now,
  finishCalls?: FinishCallRegistry,
  onInsertAgentExecution?: (execution: AgentExecutionRecord) => void,
) {
  const database = createMemoryDatabase({
    now: () => new Date(now()),
    ...(onInsertAgentExecution === undefined ? {} : { onInsertAgentExecution }),
  });
  const connection = new TestAgents();
  const outputs = new OutputExecutorRegistry();
  const replies: { executionId: string; context: unknown }[] = [];
  outputs.register({
    type: "test.reply",
    tool: replyOutputTool,
    execute: async (input) => {
      replies.push({ executionId: input.agentExecutionId, context: input.outputContext });
    },
  });
  const sessions = new AgentSessions(database, "secret", "https://hub.test", outputs, now);
  const capabilities = createExecutionCapabilityServer({
    database,
    outputs,
    completionTokenSecret: "secret",
    ...(finishCalls === undefined ? {} : { finishCalls }),
    completeExecution: async ({ executionId }) =>
      (await database.transitionAgentExecution(executionId, "succeeded")).execution,
  });
  async function arrival(
    key: string | null | false = "conversation",
    target = "daemon",
    env: Record<string, string> = {},
    prompt = "hello",
    overrides: Partial<LaunchMachineIntent> = {},
    standalone = false,
  ) {
    const executionId = randomUUID();
    const intent: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId: "org",
      projectId: "project",
      triggerRunId: randomUUID(),
      triggerName: "answer",
      environmentName: "target",
      environment: { kind: "daemon", daemonId: target, authoredSlug: target, cwd: "/repo" },
      agent: { provider: "codex" },
      prompt,
      env,
      allowOutputs: [{ type: "test.reply", max: 1 }],
      autoArchive: true,
      background: false,
      triggerContext: {},
      outputContext: { arrival: executionId },
      configurationRevisionId: randomUUID(),
      hubConfig: {},
      ...(key === false ? {} : { continuation: { key, compatibility: { target } } }),
      ...overrides,
    };
    const storedIntent = { ...intent };
    if (standalone) Reflect.deleteProperty(storedIntent, "triggerRunId");
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org",
      projectId: "project",
      machineId: null,
      triggerContext: {},
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: storedIntent,
      ...(intent.deadlineAt === undefined ? {} : { deadlineAt: intent.deadlineAt }),
    });
    return {
      executionId,
      dispatch: () =>
        sessions.dispatch({
          executionId,
          intent,
          connection,
          onEvent: () => {},
          createOptions: async () => ({
            provider: "codex",
            cwd: "/repo",
            env: intent.github === undefined ? {} : { GH_TOKEN: "scoped-github-token" },
            toolPolicy: { preapproved: [] },
          }),
        }),
    };
  }
  async function execution(id: string) {
    const item = await database.findAgentExecutionById(id);
    if (!item) throw new Error("missing execution");
    return item;
  }
  async function call(
    executionId: string,
    name: string,
    args: Record<string, unknown>,
    ownerId = executionId,
  ) {
    const owner = await execution(ownerId);
    const session = await database.findAgentSession(owner.agentSessionId!);
    if (!session || session.optionsReducedAt != null) throw new Error("missing bootstrap options");
    const mcp = session.creationOptions.mcpServers!["hub"]!;
    const response = await capabilities.handleSession(
      new Request(mcp.url, {
        method: "POST",
        headers: {
          ...mcp.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { ...args, executionId } },
        }),
      }),
      session.id,
    );
    const result: unknown = await response.json();
    return result;
  }
  return { database, connection, sessions, replies, arrival, execution, call };
}

test("settles a canceled execution whose agent creation never finished", async () => {
  const f = await fixture();
  const request = await f.arrival();
  vi.spyOn(f.connection, "create").mockRejectedValueOnce(new Error("creation failed"));
  await expect(request.dispatch()).rejects.toThrow("creation failed");
  const { execution } = await f.database.transitionAgentExecution(request.executionId, "failed", {
    result: { status: "canceled" },
    hubAction: "interrupt",
  });
  expect(execution.agentSessionId).not.toBeNull();
  const control = vi.spyOn(f.connection, "control");
  await expect(
    f.sessions.interruptStoppedExecution(execution, f.connection, "stop", []),
  ).resolves.toBe("target_gone");
  expect(control).not.toHaveBeenCalled();
  expect(f.connection.deliveries).toEqual([]);
});

test("same-key arrivals share an agent; an earlier completion cannot archive newer work", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  const [a, b] = await Promise.all([first.dispatch(), second.dispatch()]);
  expect(a.agentId).toBe(b.agentId);
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.deliveries).toHaveLength(2);
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(0);
  await f.database.transitionAgentExecution(second.executionId, "succeeded");
  await f.sessions.control(await f.execution(second.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(1);
  const third = await f.arrival();
  expect(await third.dispatch()).toMatchObject({ agentId: a.agentId, action: "restored" });
  expect(f.connection.restorations).toBe(1);
});

test("session tools keep each arrival's destination and reject stale or foreign execution IDs", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  await first.dispatch();
  await second.dispatch();
  expect(await f.call(first.executionId, "reply", { content: "first" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(await f.call(first.executionId, "finish_execution", {})).toMatchObject({
    result: { content: [{ type: "text", text: "Execution finished" }] },
  });
  expect(await f.call(first.executionId, "reply", { content: "stale" })).toMatchObject({
    result: { isError: true },
  });
  expect(await f.call(second.executionId, "reply", { content: "second" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(f.replies).toEqual([
    { executionId: first.executionId, context: { arrival: first.executionId } },
    { executionId: second.executionId, context: { arrival: second.executionId } },
  ]);
  const foreign = await f.arrival("another");
  await foreign.dispatch();
  expect(
    await f.call(foreign.executionId, "finish_execution", {}, second.executionId),
  ).toMatchObject({ result: { isError: true } });
});

test("new-agent policy isolates arrivals and incompatible targets fail without replacement", async () => {
  const f = await fixture();
  const a = await f.arrival(null);
  const b = await f.arrival(null);
  expect((await a.dispatch()).agentId).not.toBe((await b.dispatch()).agentId);
  const first = await f.arrival();
  await first.dispatch();
  const changed = await f.arrival("conversation", "different-daemon");
  await expect(changed.dispatch()).rejects.toThrow("Continuation settings differ");
  expect(f.connection.creates).toHaveLength(3);
});

test("ordinary launches use agent sessions and preserve long prompts without enabling continuation", async () => {
  const f = await fixture();
  const prompt = "Investigate this request.\n" + "Full request context. ".repeat(1_000);
  const first = await f.arrival(false, "daemon", {}, prompt);
  const second = await f.arrival(false, "daemon", {}, prompt);
  const a = await first.dispatch();
  const replay = await first.dispatch();
  const b = await second.dispatch();
  expect(replay.agentId).toBe(a.agentId);
  expect(b.agentId).not.toBe(a.agentId);
  expect(f.connection.creates).toHaveLength(2);
  expect(f.connection.deliveries).toEqual([
    { agentId: a.agentId, text: prompt },
    { agentId: b.agentId, text: prompt },
  ]);
});

test("steering keeps the active agent's scoped credentials instead of requiring a new agent", async () => {
  const f = await fixture();
  const env = { TOKEN: "${{ paseo.connections.support.token }}" };
  const github = {
    connection: "getpaseo-github",
    repositories: ["getpaseo/paseo"],
    permissions: { contents: "write" as const },
    durationMs: 60 * 60 * 1000,
  };
  const first = await f.arrival("conversation", "daemon", env, "first request", { github });
  const original = await first.dispatch();
  const next = await f.arrival("conversation", "daemon", env, "follow-up", { github });
  expect(await next.dispatch()).toMatchObject({ agentId: original.agentId, action: "continued" });
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.creates[0]?.env).toEqual({ GH_TOKEN: "scoped-github-token" });
  expect(f.connection.deliveries).toHaveLength(2);
});

test("steering cannot extend the active agent's original max-runtime deadline", async () => {
  const f = await fixture();
  const deadlineAt = new Date("2030-01-01T01:00:00Z");
  const first = await f.arrival("conversation", "daemon", {}, "first request", { deadlineAt });
  await first.dispatch();
  const next = await f.arrival("conversation", "daemon", {}, "follow-up", {
    deadlineAt: new Date("2030-01-01T01:30:00Z"),
  });
  await next.dispatch();
  expect((await f.execution(first.executionId)).deadlineAt).toEqual(deadlineAt);
  expect((await f.execution(next.executionId)).deadlineAt).toEqual(deadlineAt);
});

test("a completed credentialed task gets a fresh agent and isolates the previous agent's tools", async () => {
  const f = await fixture();
  const github = {
    connection: "getpaseo-github",
    repositories: ["getpaseo/paseo"],
    permissions: { contents: "write" as const },
    durationMs: 60 * 60 * 1000,
  };
  const first = await f.arrival("conversation", "daemon", {}, "first", { github });
  const original = await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.releaseAuthority(await f.execution(first.executionId), async () => {});
  const next = await f.arrival("conversation", "daemon", {}, "next task", { github });
  const fresh = await next.dispatch();
  expect(fresh.agentId).not.toBe(original.agentId);
  expect(f.connection.creates).toHaveLength(2);
  expect(await f.call(next.executionId, "finish_execution", {}, first.executionId)).toMatchObject({
    result: { isError: true },
  });
});

test("an expired credentialed launch still rotates its session in memory", async () => {
  const f = await fixture(() => Date.parse("2026-10-01T00:00:00Z"));
  const env = { TOKEN: "${{ paseo.connections.support.token }}" };
  const first = await f.arrival("conversation", "daemon", env, "old launch", {}, true);
  const original = await first.dispatch();
  const completed = await f.database.transitionAgentExecution(first.executionId, "succeeded");
  const sessionId = completed.execution.agentSessionId!;
  const cutoff = new Date("2026-10-19T00:00:00Z");
  const now = new Date("2026-11-18T00:00:00Z");
  expect(await f.database.expireLaunchIntent(first.executionId, cutoff, now)).toBe(true);
  expect(await f.database.reduceSessionOptions(sessionId, cutoff, now)).toBe(true);
  expect(await f.execution(first.executionId)).toMatchObject({
    launchIntent: null,
    usedTemporaryCredentials: true,
  });
  const next = await f.arrival("conversation", "daemon", env);
  expect(await next.dispatch()).toMatchObject({ action: "created" });
  expect((await f.execution(next.executionId)).daemonAgentId).not.toBe(original.agentId);
  expect((await f.database.findAgentSession(sessionId))?.continuationKey).toBeNull();
});

test.each(credentialHistories)(
  "preserves credential selection for $key in memory",
  async (history) => {
    const old = new Date("2026-10-10T00:00:00Z");
    const now = new Date("2026-11-18T00:00:00Z");
    for (const phase of ["migrated", "backfilled", "redacted"] as const) {
      let nextHistory:
        | { intent: LegacyLaunchIntent; fact: boolean | null; ordinal: number }
        | undefined;
      const f = await fixture(
        () => old.getTime(),
        undefined,
        (execution) => {
          if (nextHistory === undefined) return;
          const { intent, fact, ordinal } = nextHistory;
          Reflect.set(execution, "launchIntent", intent);
          execution.usedTemporaryCredentials = fact;
          execution.startedAt = new Date(old.getTime() + ordinal);
        },
      );
      async function addHistory(intent: LegacyLaunchIntent, ordinal: number) {
        nextHistory = { intent, fact: history.migrated[ordinal] ?? null, ordinal };
        const arrival = await f.arrival(history.key);
        nextHistory = undefined;
        return arrival;
      }
      const [initial, ...remaining] = history.intents;
      const first = await addHistory(initial ?? null, 0);
      const original = await first.dispatch();
      const { execution } = await f.database.transitionAgentExecution(
        first.executionId,
        "succeeded",
      );
      const ids = [first.executionId];
      for (const [index, intent] of remaining.entries()) {
        const extra = await addHistory(intent, index + 1);
        await f.database.attachExecutionToSession(extra.executionId, execution.agentSessionId!);
        await f.database.transitionAgentExecution(extra.executionId, "succeeded");
        ids.push(extra.executionId);
      }
      const before = await Promise.all(ids.map((id) => f.execution(id)));
      expect(build14Selection(before.map(({ launchIntent }) => launchIntent))).toBe(
        history.build14,
      );
      expect(before.map(({ usedTemporaryCredentials }) => usedTemporaryCredentials)).toEqual(
        history.migrated,
      );
      if (phase !== "migrated") {
        const sweep = new RunPayloadRetention(f.database, {
          mode: phase === "backfilled" ? "count" : "on",
          retentionDays: 30,
          maxRunsPerPass: 50,
        });
        expect((await sweep.runBatch(now)).complete).toBe(true);
        const after = await Promise.all(ids.map((id) => f.execution(id)));
        expect(after.map(({ usedTemporaryCredentials }) => usedTemporaryCredentials)).toEqual(
          history.backfilled,
        );
        expect(after.map(({ launchIntentExpiredAt }) => launchIntentExpiredAt != null)).toEqual(
          history.backfilled.map((fact) => phase === "redacted" && fact !== null),
        );
      }
      const chronological = await f.database.listAgentSessionExecutions(execution.agentSessionId!);
      expect(chronological.map(({ id }) => id)).toEqual(ids);
      const next = await f.arrival(history.key);
      const expected = upgradedSelection(history);
      const selected = await next.dispatch();
      expect(selected.action).toBe(expected);
      expect(selected.agentId === original.agentId).toBe(expected === "continued");
    }
  },
);

test("a ping cannot send more work after the inherited deadline while timeout cleanup is pending", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const f = await fixture(() => now);
  const first = await f.arrival("conversation", "daemon", {}, "first", {
    deadlineAt: new Date(now + 1000),
  });
  await first.dispatch();
  now += 1000;
  const next = await f.arrival("conversation", "daemon", {}, "too late", {
    deadlineAt: new Date(now + 1000),
  });
  await expect(next.dispatch()).rejects.toThrow("execution_deadline_exceeded");
  expect(f.connection.deliveries).toHaveLength(1);
});

test("a session finish call is recorded against the execution named in its arguments", async () => {
  const finishCalls = new FinishCallRegistry();
  const f = await fixture(Date.now, finishCalls);
  const first = await f.arrival();
  const second = await f.arrival();
  await first.dispatch();
  await second.dispatch();
  const owners: boolean[][] = [];
  const transition = f.database.transitionAgentExecution.bind(f.database);
  vi.spyOn(f.database, "transitionAgentExecution").mockImplementation(async (...args) => {
    owners.push([
      finishCalls.ownsOutcome(first.executionId),
      finishCalls.ownsOutcome(second.executionId),
    ]);
    return transition(...args);
  });

  await f.call(first.executionId, "finish_execution", {});

  // Only the execution that named itself was registered, and before its completion ran.
  expect(owners).toEqual([[true, false]]);
  // Its completion ended it, so the entry is freed once the call returns.
  expect(finishCalls.size).toBe(0);

  const rejected = await f.call(second.executionId, "finish_execution", { unexpected: true });
  expect(rejected).toMatchObject({ result: { isError: true } });
  expect(finishCalls.ownsOutcome(second.executionId)).toBe(false);
});
