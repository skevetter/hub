import { describe, expect, it } from "vitest";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import { runWithFailureTracking } from "../failures/index.js";
import { takeResponseLifecycle } from "../http/response-lifecycle.js";
import { FinishCallRegistry } from "./finish-calls.js";
import { OutputExecutorRegistry, replyOutputTool } from "./outputs.js";
import { createExecutionCapabilityServer } from "./server.js";

const executionId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const origin = "https://hub.test";
const token = "test-token";
const secret = "test-signing-key";
const time = new Date("2026-01-01T00:00:00Z");
const attempt = {
  id: "attempt-1",
  outputType: "test.reply",
  status: "pending",
  startedAt: time,
  leaseExpiresAt: time,
  completedAt: null,
} as const;

type Fault =
  | "unavailable"
  | "materialize"
  | "move"
  | "finish"
  | "ack"
  | "begin"
  | "limit"
  | "deliver"
  | "record"
  | "record-failure"
  | "read";

interface Probe {
  session?: boolean;
  plainSessionToolOnly?: boolean;
  badRoute?: boolean;
  bearer?: string | null;
  secretGone?: boolean;
  attached?: boolean;
  status?: AgentExecutionRecord["status"];
  required?: boolean;
  structured?: boolean;
  fault?: Fault;
  method: string;
  params?: unknown;
  requestMethod?: string;
  accept?: string;
  abort?: boolean;
  missing?: boolean;
  noSecret?: boolean;
}

async function fixtureExecution(probe: Probe): Promise<AgentExecutionRecord> {
  const execution = await createMemoryDatabase().insertAgentExecution({
    id: executionId,
    organizationId: "org",
    projectId: "project",
    machineId: null,
    configurationRevisionId: executionId,
    completionTokenHash: hashAgentExecutionCompletionToken(token),
    triggerContext: {},
    outputContext: { destination: "test" },
    launchIntent: {
      kind: "launch_machine",
      organizationId: "org",
      projectId: "project",
      configurationRevisionId: executionId,
      triggerRunId: sessionId,
      triggerName: "test",
      environmentName: "test",
      environment: { kind: "daemon", daemonId: "daemon", authoredSlug: "test", cwd: "/test" },
      prompt: "test",
      agent: { provider: "codex" },
      allowOutputs: [{ type: "test.reply", max: 2, required: probe.required ?? false }],
      autoArchive: false,
      background: false,
      triggerContext: {},
      outputContext: {},
      hubConfig: {},
      ...(probe.structured
        ? { outputSchema: { type: "object", additionalProperties: false } }
        : {}),
    },
  });
  execution.status = probe.status ?? "running";
  execution.agentSessionId = probe.attached === false ? null : sessionId;
  return execution;
}

function fixtureDatabase(
  probe: Probe,
  execution: AgentExecutionRecord,
  trace: unknown[],
): Database {
  const plainTool = { ...replyOutputTool, name: "plain", inputSchema: { type: "object" } } as const;
  const session = {
    id: sessionId,
    organizationId: "org",
    projectId: "project",
    continuationKey: null,
    daemonId: "daemon",
    compatibility: "test",
    agentId: "agent",
    workspaceId: "workspace",
    optionsReducedAt: time,
    creationOptions: { provider: "codex", model: null },
    capabilityTokenHash: hashAgentExecutionCompletionToken(token),
    tools: probe.plainSessionToolOnly ? [plainTool] : [replyOutputTool, plainTool],
  } satisfies NonNullable<Awaited<ReturnType<Database["findAgentSession"]>>>;
  let reads = 0;
  return Object.assign(createMemoryDatabase(), {
    async findAgentSession(id: string) {
      trace.push(["session", id]);
      return probe.missing ? undefined : session;
    },
    async findAgentExecutionById(id: string) {
      trace.push(["execution", id]);
      reads += 1;
      if (probe.fault === "read" && reads > 1) throw new Error("read failed");
      return probe.missing ? undefined : execution;
    },
    async beginAgentExecutionOutput(...args: Parameters<Database["beginAgentExecutionOutput"]>) {
      trace.push(["begin", ...args]);
      if (probe.fault === "begin") throw new Error("claim failed");
      return probe.fault === "limit" ? undefined : attempt;
    },
    async completeAgentExecutionOutput(
      ...args: Parameters<Database["completeAgentExecutionOutput"]>
    ) {
      trace.push(["record", ...args]);
      return probe.fault === "record" ? undefined : execution;
    },
    async failAgentExecutionOutput(...args: Parameters<Database["failAgentExecutionOutput"]>) {
      trace.push(["fail", ...args]);
      if (probe.fault === "record-failure") throw new Error("failure record failed");
      return true;
    },
    async recordAgentExecutionHubAcknowledgement(
      ...args: Parameters<Database["recordAgentExecutionHubAcknowledgement"]>
    ) {
      trace.push(["ack", ...args]);
      if (probe.fault === "ack") throw new Error("ack failed");
      return execution;
    },
  } satisfies Partial<Database>);
}

function fixtureServer(
  probe: Probe,
  execution: AgentExecutionRecord,
  trace: unknown[],
  factory: typeof createExecutionCapabilityServer,
) {
  const database = fixtureDatabase(probe, execution, trace);
  const finishCalls = new FinishCallRegistry();
  const outputs = new OutputExecutorRegistry();
  const completionToken = { completionTokenSecret: secret };
  outputs.register({
    type: "test.reply",
    tool: replyOutputTool,
    available(context) {
      trace.push(["available", context]);
      if (probe.secretGone) Reflect.deleteProperty(options, "completionTokenSecret");
      if (probe.fault === "materialize") throw new Error("materialize failed");
      return probe.fault !== "unavailable";
    },
    async execute(input) {
      trace.push(["deliver", input]);
      if (probe.fault === "deliver" || probe.fault === "record-failure")
        throw new Error("delivery failed");
    },
  });
  const options: Parameters<typeof factory>[0] = {
    ...(probe.noSecret ? {} : completionToken),
    database,
    finishCalls,
    outputs,
    now: () => time,
    async completeExecution(input) {
      trace.push(["finish", input, finishCalls.ownsOutcome(executionId)]);
      if (probe.fault === "finish") throw new Error("completion failed");
      execution.status = probe.fault === "move" ? "failed" : "succeeded";
      return execution;
    },
  };
  return { server: factory(options), finishCalls };
}

function probeRouteId(probe: Probe): string {
  if (probe.badRoute) return "not-a-uuid";
  return probe.session ? sessionId : executionId;
}

function requestFor(probe: Probe, routeId: string) {
  const requestMethod = probe.requestMethod ?? "POST";
  const bearer = probe.bearer === undefined ? `Bearer ${token}` : probe.bearer;
  return new Request(`${origin}/${routeId}`, {
    method: requestMethod,
    headers: {
      "content-type": "application/json",
      accept: probe.accept ?? "application/json, text/event-stream",
      ...(bearer === null ? {} : { authorization: bearer }),
    },
    ...(requestMethod === "POST"
      ? {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: probe.method,
            params: probe.params,
          }),
        }
      : {}),
  });
}

export async function runCapabilityProbe(
  probe: Probe,
  factory = createExecutionCapabilityServer,
  trackLogs = runWithFailureTracking,
) {
  const trace: unknown[] = [];
  const execution = await fixtureExecution(probe);
  const { server, finishCalls } = fixtureServer(probe, execution, trace, factory);
  const routeId = probeRouteId(probe);
  const request = requestFor(probe, routeId);
  const log = (record: unknown, message?: unknown) => {
    if (typeof record !== "object" || record === null || !("err" in record)) return;
    const error = record.err;
    if (typeof error !== "object" || error === null || !("message" in error)) return;
    const kind = "failureKind" in record ? record.failureKind : undefined;
    trace.push(["log", kind, error.message, message]);
  };
  return trackLogs(
    async () => {
      try {
        const response = await (probe.session
          ? server.handleSession(request, routeId)
          : server.handle(request, routeId));
        const body = await response.text();
        const lifecycle = takeResponseLifecycle(response);
        if (probe.abort) await lifecycle?.onAbort?.();
        else await lifecycle?.onFinish();
        return {
          status: response.status,
          headers: [...response.headers],
          body,
          lifecycle: lifecycle !== undefined,
          trace,
          registrySize: finishCalls.size,
        };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return { error: [error.name, error.message], trace, registrySize: finishCalls.size };
      }
    },
    { warn: log, error: log },
  );
}

export const reply = { name: "reply", arguments: { content: "hello" } };
export const finish = { name: "finish_execution" };

function call(params: unknown = finish, probe: Partial<Probe> = {}): Probe {
  return { method: "tools/call", params, ...probe };
}

function sessionCall(params: typeof reply | typeof finish = finish, probe: Partial<Probe> = {}) {
  const args = "arguments" in params ? params.arguments : {};
  return call({ ...params, arguments: { ...args, executionId } }, { session: true, ...probe });
}

export const capabilityCases: Record<string, [Probe, number, string]> = {
  "execution discovery": [{ method: "tools/list" }, 200, '"finish_execution"'],
  "session discovery": [
    { method: "tools/list", session: true },
    200,
    '"required":["content","executionId"]',
  ],
  "session discovery without schema properties": [
    { method: "tools/list", session: true, plainSessionToolOnly: true },
    200,
    '"required":["executionId"]',
  ],
  "unauthenticated execution": [call(finish, { bearer: null }), 401, '"unauthorized"'],
  "malformed bearer": [call(finish, { bearer: "Bearer two tokens" }), 401, '"unauthorized"'],
  "wrong token": [call(finish, { bearer: "Bearer wrong" }), 401, '"unauthorized"'],
  "missing execution": [call(finish, { missing: true }), 401, '"unauthorized"'],
  "invalid execution route": [call(finish, { badRoute: true }), 401, '"unauthorized"'],
  "invalid session route": [sessionCall(finish, { badRoute: true }), 401, '"unauthorized"'],
  "missing session": [sessionCall(finish, { missing: true }), 401, '"unauthorized"'],
  "missing session bearer": [sessionCall(finish, { bearer: null }), 401, '"unauthorized"'],
  "wrong session bearer": [sessionCall(finish, { bearer: "Bearer wrong" }), 401, '"unauthorized"'],
  "missing session configuration": [sessionCall(finish, { noSecret: true }), 401, '"unauthorized"'],
  "terminal execution": [call(finish, { status: "failed" }), 409, '"execution_not_live"'],
  "terminal session execution": [
    sessionCall(finish, { status: "failed" }),
    200,
    "Execution is not live in this agent session",
  ],
  "detached session execution": [
    sessionCall(finish, { attached: false }),
    200,
    "Execution is not live in this agent session",
  ],
  "omitted session execution argument": [
    call(finish, { session: true }),
    200,
    "A valid executionId is required",
  ],
  "malformed session execution argument": [
    call({ ...finish, arguments: { executionId: "wrong" } }, { session: true }),
    200,
    "A valid executionId is required",
  ],
  "unknown tool": [call({ name: "unknown" }), 200, "Tool unknown not found"],
  "invalid reply": [
    call({ ...reply, arguments: { content: "" } }),
    200,
    "Invalid arguments for tool:",
  ],
  "invalid finish": [
    call({ ...finish, arguments: { extra: 0 } }),
    200,
    "Invalid arguments for tool:",
  ],
  "finish with missing output": [
    call(finish, { required: true }),
    200,
    "Required output missing: test.reply (call `reply`). Call the named Hub tool, then retry `finish_execution`.",
  ],
  "unavailable required output": [
    call(finish, { required: true, fault: "unavailable" }),
    409,
    "required output capability unavailable: test.reply",
  ],
  "unexpected materialization error": [
    call(finish, { fault: "materialize" }),
    409,
    "A required output capability is unavailable. Check the workflow output configuration.",
  ],
  "session materialization error": [
    sessionCall(finish, { fault: "materialize" }),
    200,
    "materialize failed",
  ],
  "finish succeeds": [call(), 200, "Execution finished"],
  "finish succeeds with output": [
    call({ ...finish, arguments: { output: {} } }, { structured: true }),
    200,
    "Execution finished",
  ],
  "session secret removed during materialization": [
    sessionCall(finish, { secretGone: true }),
    200,
    "or CryptoKey. Received undefined",
  ],
  "session finish succeeds": [sessionCall(), 200, "Execution finished"],
  "finish proceeds after a failed terminal read": [
    call(finish, { fault: "read" }),
    200,
    "Execution finished",
  ],
  "finish loses transition": [
    call(finish, { fault: "move" }),
    200,
    "Execution could not be finished because its state changed. Reload its current status before finishing again.",
  ],
  "finish throws": [
    call(finish, { fault: "finish" }),
    200,
    "Execution could not be finished. Check its current status and required outputs. If it happens again, quote reference ",
  ],
  "acknowledgement throws": [
    call(finish, { fault: "ack" }),
    200,
    "Execution could not be finished. Check its current status and required outputs. If it happens again, quote reference ",
  ],
  "reply succeeds": [call(reply), 200, "Output sent"],
  "session reply succeeds": [sessionCall(reply), 200, "Output sent"],
  "reply response aborts": [call(reply, { abort: true }), 200, "Output sent"],
  "output claim throws": [call(reply, { fault: "begin" }), 200, "claim failed"],
  "output limit": [call(reply, { fault: "limit" }), 200, "Output limit reached for test.reply"],
  "delivery fails": [
    call(reply, { fault: "deliver" }),
    200,
    "Output delivery failed. Check the provider connection and output configuration before calling `reply` again.",
  ],
  "recording fails": [call(reply, { fault: "record" }), 200, "Output delivery failed."],
  "failure recording fails": [
    call(reply, { fault: "record-failure" }),
    200,
    "Output delivery failed.",
  ],
};

const initializeParams = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "probe", version: "1" },
};

const discoveryCases = [
  [
    { method: "initialize", params: initializeParams },
    {
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "paseo-hub-execution", version: "1.0.0" },
      },
      jsonrpc: "2.0",
      id: 7,
    },
  ],
  [
    { method: "tools/list" },
    {
      result: {
        tools: [
          {
            name: "finish_execution",
            description: "Completes this execution and records its optional structured output.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: "reply",
            description:
              "Sends a reply to the conversation that triggered this execution. (up to 2 times).",
            inputSchema: {
              type: "object",
              properties: { content: { type: "string", minLength: 1 } },
              required: ["content"],
              additionalProperties: false,
            },
          },
        ],
      },
      jsonrpc: "2.0",
      id: 7,
    },
  ],
  [
    { method: "initialize", session: true, params: initializeParams },
    {
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "paseo-hub-session", version: "1.0.0" },
      },
      jsonrpc: "2.0",
      id: 7,
    },
  ],
  [
    { method: "tools/list", session: true },
    {
      result: {
        tools: [
          {
            name: "reply",
            description: "Sends a reply to the conversation that triggered this execution.",
            inputSchema: {
              type: "object",
              properties: {
                content: { type: "string", minLength: 1 },
                executionId: {
                  type: "string",
                  description: "Execution ID supplied with the request prompt.",
                },
              },
              required: ["content", "executionId"],
              additionalProperties: false,
            },
          },
          {
            name: "plain",
            description: "Sends a reply to the conversation that triggered this execution.",
            inputSchema: {
              type: "object",
              properties: {
                executionId: {
                  type: "string",
                  description: "Execution ID supplied with the request prompt.",
                },
              },
              required: ["executionId"],
            },
          },
        ],
      },
      jsonrpc: "2.0",
      id: 7,
    },
  ],
] as const;

describe("execution capability behavior", () => {
  for (const [name, [probe, status, message]] of Object.entries(capabilityCases)) {
    it(name, async () => {
      const outcome = await runCapabilityProbe(probe);
      expect(outcome.status).toBe(status);
      expect(outcome.body).toContain(message);
    });
  }

  it("preserves exact initialization and tool discovery for both MCP endpoints", async () => {
    for (const [probe, expected] of discoveryCases) {
      const outcome = await runCapabilityProbe(probe);
      expect(outcome.status).toBe(200);
      const body: unknown = JSON.parse(outcome.body ?? "");
      expect(body).toStrictEqual(expected);
    }
  });

  it("passes the derived token and owns the finish outcome before completion", async () => {
    const outcome = await runCapabilityProbe(sessionCall());
    const derived = deriveAgentExecutionCompletionToken(secret, executionId);
    expect(outcome.trace).toContainEqual(["finish", { executionId, token: derived }, true]);
    expect(outcome.trace).toContainEqual([
      "ack",
      executionId,
      { kind: "finish_execution", status: "completed", observedAt: time },
    ]);
    expect(outcome.lifecycle).toBe(true);
    expect(outcome.registrySize).toBe(0);
  });

  it("preserves output claim, delivery, and record argument order", async () => {
    const outcome = await runCapabilityProbe(call(reply));
    expect(outcome.trace.slice(-3)).toStrictEqual([
      ["begin", executionId, "test.reply", 2, time],
      [
        "deliver",
        {
          agentExecutionId: executionId,
          attemptId: attempt.id,
          toolType: "test.reply",
          args: reply.arguments,
          outputContext: { destination: "test" },
        },
      ],
      ["record", executionId, attempt.id, time],
    ]);
  });
});
