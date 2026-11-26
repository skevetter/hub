import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DaemonAgentMissingError,
  DaemonFrameNotSentError,
  type AgentConnection,
  type AgentSnapshot,
} from "../daemons/agents/index.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { StopInterruptCoverage } from "../db/stop-interrupt.js";
import type { Database } from "../db/types.js";
import { OutputExecutorRegistry } from "../execution-capabilities/outputs.js";
import {
  DEFAULT_STARTUP_TIMEOUT_MS,
  type LaunchMachineIntent,
} from "../dispatcher/launch-machine-intent.js";
import { AgentSessionError, AgentSessions, sessionLock } from "./index.js";

const intent: LaunchMachineIntent = {
  kind: "launch_machine",
  organizationId: "org",
  projectId: "project",
  triggerRunId: "run",
  triggerName: "trigger",
  environmentName: "target",
  environment: { kind: "daemon", daemonId: "daemon", cwd: "/repo", authoredSlug: "target" },
  agent: { provider: "codex" },
  prompt: "hello",
  env: {},
  allowOutputs: [],
  autoArchive: false,
  background: false,
  triggerContext: {},
  outputContext: {},
  configurationRevisionId: "revision",
  hubConfig: {},
};

const agent: AgentSnapshot = { id: "agent", workspaceId: "workspace", status: "idle" };

function insertExecution(database: Database, id: string, deadlineAt?: Date) {
  return database.insertAgentExecution({
    id,
    organizationId: "org",
    projectId: "project",
    machineId: null,
    triggerContext: {},
    outputContext: {},
    configurationRevisionId: "revision",
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });
}

async function fixture() {
  const database = createMemoryDatabase();
  const execution = await insertExecution(database, "execution", new Date(1000));
  const sessions = new AgentSessions(
    database,
    "fixture-secret",
    "https://hub.test",
    new OutputExecutorRegistry(),
    () => 0,
  );
  const events: unknown[][] = [];
  const unsubscribe = () => {
    events.push(["unsubscribe"]);
  };
  const connection: AgentConnection = {
    async create(...args) {
      events.push(["create", ...args]);
      return agent;
    },
    async get(...args) {
      events.push(["get", ...args]);
      return agent;
    },
    async restore(...args) {
      events.push(["restore", ...args]);
      return true;
    },
    async watch(agentId) {
      events.push(["watch", agentId]);
      return unsubscribe;
    },
    async send(...args) {
      events.push(["send", ...args]);
    },
    async control(...args) {
      events.push(["control", ...args.slice(0, 3)]);
      args[3]?.();
    },
  };
  const dispatch = (overrides: Partial<LaunchMachineIntent> = {}, executionId = execution.id) =>
    sessions.dispatch({
      executionId,
      intent: { ...intent, ...overrides },
      connection,
      onEvent: () => {},
      createOptions: async () => {
        events.push(["prepare"]);
        return { provider: "codex", cwd: "/repo", env: {} };
      },
      beforePromptSend: () => {
        events.push(["beforePromptSend"]);
      },
    });
  return { database, sessions, execution, events, unsubscribe, connection, dispatch };
}

function traceDatabase(database: Database, events: unknown[][]) {
  const lock = database.withAdvisoryLock.bind(database);
  database.withAdvisoryLock = (key, body) =>
    lock(key, async () => {
      events.push(["lock", key]);
      try {
        return await body();
      } finally {
        events.push(["unlock"]);
      }
    });
  const save = database.saveAgentSession.bind(database);
  database.saveAgentSession = async (value) => {
    events.push(["save", Object.keys(value), value.agentId, value.continuationKey]);
    return save(value);
  };
  const attachSession = database.attachExecutionToSession.bind(database);
  database.attachExecutionToSession = async (...args) => {
    events.push(["attachSession", ...args]);
    await attachSession(...args);
  };
  const attachAgent = database.attachAgentToExecution.bind(database);
  database.attachAgentToExecution = async (...args) => {
    events.push(["attachAgent", ...args]);
    return attachAgent(...args);
  };
  const limit = database.limitAgentExecutionDeadline.bind(database);
  database.limitAgentExecutionDeadline = async (...args) => {
    events.push(["limit", ...args]);
    return limit(...args);
  };
}

test("dispatch prepares outside the lock and saves, attaches and delivers in order", async () => {
  const f = await fixture();
  traceDatabase(f.database, f.events);
  const result = await f.dispatch();
  const stored = await f.database.findAgentExecutionById(f.execution.id);
  assert.ok(stored?.agentSessionId);
  const id = stored.agentSessionId;
  const sessionKeys = [
    "id",
    "projectId",
    "organizationId",
    "continuationKey",
    "daemonId",
    "agentId",
    "workspaceId",
    "compatibility",
    "tools",
    "capabilityTokenHash",
    "creationOptions",
  ];
  assert.deepEqual(result, { agentId: "agent", unsubscribe: f.unsubscribe, action: "created" });
  assert.deepEqual(Object.keys(result), ["agentId", "unsubscribe", "action"]);
  assert.deepEqual(f.events, [
    ["prepare"],
    ["lock", `agent-session:${id}`],
    ["save", sessionKeys, null, null],
    ["attachSession", f.execution.id, id],
    ["create", id, { provider: "codex", cwd: "/repo", env: {} }, DEFAULT_STARTUP_TIMEOUT_MS],
    ["save", sessionKeys, "agent", null],
    ["attachAgent", f.execution.id, "daemon", "agent"],
    ["get", "agent"],
    ["attachSession", f.execution.id, id, "created"],
    ["watch", "agent"],
    ["beforePromptSend"],
    ["send", "agent", f.execution.id, "hello", DEFAULT_STARTUP_TIMEOUT_MS],
    ["unlock"],
  ]);
});

test("dispatch restores archived agents, rejects incompatible settings and reports interrupted agents", async () => {
  const f = await fixture();
  const continuation = { key: "thread", compatibility: { model: "one" } };
  await f.dispatch({ continuation });
  const execution = await f.database.findAgentExecutionById(f.execution.id);
  assert.ok(execution?.agentSessionId);
  const session = await f.database.findAgentSession(execution.agentSessionId);
  assert.ok(session && session.optionsReducedAt == null);
  assert.deepEqual(Object.keys(session.creationOptions), ["provider", "cwd", "env", "mcpServers"]);
  assert.deepEqual(Object.keys(session.creationOptions.mcpServers?.["hub"] ?? {}), [
    "type",
    "url",
    "headers",
  ]);
  const lock = sessionLock(session);
  traceDatabase(f.database, f.events);
  f.events.length = 0;
  f.connection.get = async () => ({ ...agent, status: "closed", archivedAt: "archived" });
  assert.deepEqual(await f.dispatch({ continuation, startupTimeoutMs: 23 }), {
    agentId: "agent",
    unsubscribe: f.unsubscribe,
    action: "restored",
  });
  assert.deepEqual(f.events, [
    ["lock", lock],
    ["limit", execution.id, execution.deadlineAt],
    ["attachSession", execution.id, session.id],
    ["attachAgent", execution.id, "daemon", "agent"],
    ["restore", "workspace", 23],
    ["attachSession", execution.id, session.id, "restored"],
    ["watch", "agent"],
    ["beforePromptSend"],
    [
      "send",
      "agent",
      execution.id,
      `Hub execution: ${execution.id}\nUse this executionId for Hub tool calls for this request.\n\nhello`,
      23,
    ],
    ["unlock"],
  ]);
  f.events.length = 0;
  await assert.rejects(f.dispatch({ continuation: { ...continuation, compatibility: {} } }), {
    constructor: AgentSessionError,
    message:
      "Continuation settings differ from the existing agent; use a different key or choose a new agent",
  });
  assert.deepEqual(f.events, [["lock", lock], ["unlock"]]);
  f.connection.get = async () => ({ ...agent, status: "error" });
  await assert.rejects(f.dispatch({ continuation }), {
    constructor: AgentSessionError,
    message: "agent_interrupted",
  });
});

test("dispatch releases the lock before retrying preparation after a session disappears", async () => {
  const f = await fixture();
  const continuation = { key: "thread", compatibility: {} };
  await f.dispatch({ continuation });
  traceDatabase(f.database, f.events);
  f.events.length = 0;
  const find = f.database.findAgentSession.bind(f.database);
  let reads = 0;
  f.database.findAgentSession = (...args) =>
    ++reads === 2 ? Promise.resolve(undefined) : find(...args);
  assert.deepEqual(await f.dispatch({ continuation }), {
    agentId: "agent",
    unsubscribe: f.unsubscribe,
    action: "continued",
  });
  assert.deepEqual(
    f.events.map(([kind]) => kind),
    [
      "lock",
      "unlock",
      "lock",
      "limit",
      "attachSession",
      "attachAgent",
      "get",
      "attachSession",
      "watch",
      "beforePromptSend",
      "send",
      "unlock",
    ],
  );
});

test("dispatch inherits an active deadline before attachment, then rotates a finished credentialed session", async () => {
  const f = await fixture();
  const continuation = { key: "thread", compatibility: {} };
  const first = await f.dispatch({ continuation });
  const original = await f.database.findAgentExecutionById(f.execution.id);
  assert.ok(original?.agentSessionId);
  const next = await insertExecution(f.database, "next");
  traceDatabase(f.database, f.events);
  f.events.length = 0;
  await f.dispatch({ continuation }, next.id);
  assert.deepEqual(f.events.slice(1, 3), [
    ["limit", next.id, original.deadlineAt],
    ["attachSession", next.id, original.agentSessionId],
  ]);
  const older = { ...original, status: "succeeded" as const, usedTemporaryCredentials: true };
  const list = f.database.listAgentSessionExecutions.bind(f.database);
  f.database.listAgentSessionExecutions = (id) =>
    id === original.agentSessionId ? Promise.resolve([older]) : list(id);
  const third = await insertExecution(f.database, "third");
  f.connection.create = async () => ({ ...agent, id: "fresh" });
  f.connection.get = async () => ({ ...agent, id: "fresh" });
  f.events.length = 0;
  const rotated = await f.dispatch({ continuation }, third.id);
  assert.equal(first.agentId, "agent");
  assert.deepEqual(rotated, { agentId: "fresh", unsubscribe: f.unsubscribe, action: "created" });
  assert.deepEqual(
    f.events.slice(0, 4).map(([kind]) => kind),
    ["prepare", "lock", "save", "save"],
  );
  assert.equal((await f.database.findAgentSession(original.agentSessionId))?.continuationKey, null);
});

interface StopCase {
  name: string;
  mode?: "missing" | "mismatch" | "unsent" | "written" | "unwritten";
  coverage?: StopInterruptCoverage;
  offline?: boolean;
  noTarget?: boolean;
  stale?: boolean;
  refuseStart?: boolean;
  refuseAck?: boolean;
  result?: string | string[];
  trace: string[];
}

async function stopFixture(options: StopCase) {
  const f = await fixture();
  const current = {
    ...f.execution,
    hubAction: options.stale ? null : ("interrupt" as const),
    daemonId: "daemon",
    daemonAgentId: options.noTarget ? null : agent.id,
  };
  traceDatabase(f.database, f.events);
  f.database.findAgentExecutionById = async (id) => {
    f.events.push(["execution", id]);
    return current;
  };
  configureStopStore(f, options);
  return { ...f, current };
}

function configureStopStore(f: Awaited<ReturnType<typeof fixture>>, options: StopCase) {
  const store = f.database.stopInterrupts;
  store.coverage = async (...args) => {
    f.events.push(["coverage", ...args]);
    return options.coverage;
  };
  store.start = async (...args) => {
    f.events.push(["start", ...args]);
    return !options.refuseStart;
  };
  store.resetUnsent = async (...args) => {
    f.events.push(["reset", ...args]);
  };
  store.recordWrite = async (...args) => {
    f.events.push(["record", ...args]);
  };
  store.acknowledge = async (...args) => {
    f.events.push(["ack", ...args]);
    return !options.refuseAck;
  };
  f.connection.get = async (...args) => {
    f.events.push(["get", ...args]);
    if (options.mode === "missing") throw new DaemonAgentMissingError("missing");
    return options.mode === "mismatch" ? { ...agent, id: "other" } : agent;
  };
  f.connection.control = async (id, workspace, action, written) => {
    f.events.push(["control", id, workspace, action]);
    if (options.mode === "unsent") throw new DaemonFrameNotSentError();
    if (options.mode !== "unwritten") written?.();
    if (options.mode !== undefined) throw new Error("control failure");
  };
}

const coverage = ["coverage"];
const get = [...coverage, "get"];
const start = [...get, "start"];
const control = [...start, "control"];
const cases: StopCase[] = [
  { name: "stale", stale: true, trace: [] },
  { name: "no target offline", noTarget: true, offline: true, trace: [] },
  { name: "no target online", noTarget: true, result: "target_gone", trace: [] },
  {
    name: "coalesced even offline",
    coverage: "coalesced",
    offline: true,
    result: "coalesced",
    trace: coverage,
  },
  { name: "offline", offline: true, trace: coverage },
  { name: "missing agent", mode: "missing", result: "target_gone", trace: get },
  { name: "mismatched agent", mode: "mismatch", result: "target_gone", trace: get },
  { name: "start refused", refuseStart: true, trace: start },
  { name: "definitely unsent", mode: "unsent", trace: [...control, "reset"] },
  {
    name: "observed write",
    mode: "written",
    result: "delivery_unconfirmed",
    trace: [...control, "record"],
  },
  { name: "uncertain write", mode: "unwritten", result: "delivery_unconfirmed", trace: control },
  { name: "ack refused", refuseAck: true, trace: [...control, "ack"] },
  { name: "ack accepted", result: [], trace: [...control, "ack"] },
];

for (const scenario of cases) {
  test(`interrupt preserves the ${scenario.name} outcome and side-effect order`, async () => {
    const f = await stopFixture(scenario);
    assert.deepEqual(
      await f.sessions.interruptStoppedExecution(
        f.current,
        scenario.offline ? undefined : f.connection,
        "token",
        [],
      ),
      scenario.result,
    );
    const callArgs: Record<string, unknown[]> = {
      coverage: ["execution", "agent"],
      get: ["agent"],
      start: ["execution", "token", "agent"],
      control: ["agent", "workspace", "interrupt"],
      reset: ["execution", "token"],
      record: ["execution", "token"],
      ack: ["execution", "token", []],
    };
    const target = scenario.noTarget ? "execution" : "agent";
    const trace = scenario.trace.map((name) =>
      Array.of<unknown>(name).concat(callArgs[name] ?? []),
    );
    assert.deepEqual(f.events, [
      ["lock", `stop-agent:daemon:${target}`],
      ["execution", "execution"],
      ...trace,
      ["unlock"],
    ]);
  });
}

test("interrupt checks active peers in session order before writing under the session lock", async () => {
  const f = await stopFixture({ name: "peers", trace: [] });
  f.database.findAgentExecutionById = async (id) => {
    f.events.push(["execution", id]);
    return current;
  };
  const current = { ...f.current, agentSessionId: "session", daemonAgentId: null };
  const session = {
    id: "session",
    projectId: "project",
    organizationId: "org",
    continuationKey: null,
    daemonId: "daemon",
    agentId: "agent",
    workspaceId: "workspace",
    compatibility: "",
    tools: [],
    capabilityTokenHash: "",
    creationOptions: { provider: "codex" as const, cwd: "/repo", env: {} },
  };
  f.database.findAgentSession = async (id) => {
    f.events.push(["session", id]);
    return session;
  };
  f.database.listAgentSessionExecutions = async (id) => {
    f.events.push(["peers", id]);
    return [
      { ...current, id: "b", status: "running" },
      { ...current, id: "inactive", status: "succeeded" },
      { ...current, id: "a", status: "spawning" },
    ];
  };
  assert.equal(
    await f.sessions.interruptStoppedExecution(current, f.connection, "token", ["a"]),
    "delivery_unconfirmed",
  );
  const prefix = [
    ["session", "session"],
    ["lock", "agent-session:session"],
    ["execution", "execution"],
    ["session", "session"],
    ["coverage", "execution", "agent"],
    ["peers", "session"],
  ];
  assert.deepEqual(f.events, [...prefix, ["unlock"]]);
  f.events.length = 0;
  assert.deepEqual(
    await f.sessions.interruptStoppedExecution(current, f.connection, "token", ["a", "b"]),
    ["b", "a"],
  );
  assert.deepEqual(f.events, [
    ...prefix,
    ["get", "agent"],
    ["start", "execution", "token", "agent"],
    ["control", "agent", "workspace", "interrupt"],
    ["ack", "execution", "token", ["b", "a"]],
    ["unlock"],
  ]);
});
