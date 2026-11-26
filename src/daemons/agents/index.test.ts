import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { expect, test, vi } from "vitest";
import { DaemonAgentError, DaemonAgents, type AgentEvent } from "./index.js";
import { DaemonResponseLostError, type DaemonCreateAgentOptions } from "../protocol.js";

const prompt = "Full request context. ".repeat(1_000) + "End.";
const options: DaemonCreateAgentOptions = {
  provider: "codex",
  cwd: "/workspace",
  env: { REQUEST_ENV: "configured" },
  providerOptions: { sandbox_mode: "workspace-write" },
  toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }] },
};

function connect(
  requests: Record<string, unknown>[],
  titleResponse: (requestId: unknown) => Record<string, unknown> = (requestId) => ({
    type: "workspace.title.set.response",
    payload: { requestId, workspaceId: "workspace", accepted: true, title: "x", error: null },
  }),
  reportFailure?: (error: unknown, operation: string) => void,
): DaemonAgents {
  const agents = new DaemonAgents(
    (frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      requests.push(message);
      const requestId = message["requestId"];
      if (message["type"] === "workspace.title.set.request") {
        agents.receive({ type: "session", message: titleResponse(requestId) });
        return;
      }
      agents.receive({
        type: "session",
        message: {
          type:
            message["type"] === "create_agent_request" ? "status" : "send_agent_message_response",
          payload: {
            requestId,
            status: "agent_created",
            accepted: true,
            agent: { id: "agent", workspaceId: "workspace", status: "idle" },
          },
        },
      });
    },
    undefined,
    reportFailure,
  );
  enable(agents);
  return agents;
}

test("ordinary creation keeps prompt delivery separate from creation and preserves provider configuration", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const created = await agents.create("stable-creation-key", options);
  await agents.send(created.id, "stable-message-key", prompt);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    type: "create_agent_request",
    idempotencyKey: "stable-creation-key",
    config: {
      provider: options.provider,
      cwd: options.cwd,
      providerOptions: options.providerOptions,
      toolPolicy: options.toolPolicy,
    },
    env: options.env,
  });
  expect(requests[0]).not.toHaveProperty("initialPrompt");
  expect(requests[0]).not.toHaveProperty("config.title");
  expect(requests[1]).toMatchObject({
    type: "send_agent_message_request",
    agentId: created.id,
    messageId: "stable-message-key",
    text: prompt,
  });
});

test("timeline sends a projected request and returns entries with cursors", async () => {
  const epoch = "timeline-epoch";
  const page = {
    epoch,
    reset: false,
    staleCursor: false,
    gap: true,
    startCursor: { epoch, seq: 5 },
    endCursor: { epoch, seq: 7 },
    hasOlder: true,
    hasNewer: false,
    entries: [
      {
        item: { type: "user_message", text: "hello", messageId: "message-key" },
        turnId: "turn",
        timestamp: "2026-11-20T12:00:00.000Z",
        seqStart: 5,
        seqEnd: 7,
      },
    ],
  };
  const query = { direction: "after", cursor: { epoch, seq: 3 }, limit: 10 } as const;
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.object({ requestId: z.string() }).loose() })
      .parse(JSON.parse(frame));
    expect(message).toEqual({
      type: "fetch_agent_timeline_request",
      agentId: "agent",
      requestId: message.requestId,
      projection: "projected",
      ...query,
    });
    agents.receive({
      type: "session",
      message: {
        type: "fetch_agent_timeline_response",
        payload: {
          ...page,
          requestId: message.requestId,
          agentId: "agent",
          agent: null,
          direction: query.direction,
          projection: "projected",
          window: { minSeq: 1, maxSeq: 7, nextSeq: 8 },
          error: null,
          entries: page.entries.map((entry) => ({
            ...entry,
            provider: "codex",
            sourceSeqRanges: [{ startSeq: 5, endSeq: 7 }],
            collapsed: ["identity"],
          })),
        },
      },
    });
  });
  enable(agents);
  await expect(agents.timeline("agent", query)).resolves.toEqual(page);
});

test("agent stream events keep the daemon seq and epoch", async () => {
  const agents = connect([]);
  const listener = vi.fn<(event: AgentEvent) => void>();
  const unwatch = await agents.watch("agent", listener);
  listener.mockClear();
  const payload = {
    agentId: "agent",
    event: {
      type: "timeline",
      provider: "codex",
      item: { type: "user_message", text: "hello", messageId: "message-key" },
    },
    timestamp: "2026-11-20T12:00:00.000Z",
  };
  agents.receive({
    type: "session",
    message: { type: "agent_stream", payload: { ...payload, seq: 0, epoch: "timeline-epoch" } },
  });
  agents.receive({ type: "session", message: { type: "agent_stream", payload } });
  expect(listener).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenNthCalledWith(1, {
    ...payload,
    type: "agent_stream",
    timestamp: expect.any(String) as unknown,
    seq: 0,
    epoch: "timeline-epoch",
  });
  expect(listener).toHaveBeenNthCalledWith(2, {
    ...payload,
    type: "agent_stream",
    timestamp: expect.any(String) as unknown,
  });
  unwatch();
  agents.close();
});

test.each(["agent_request_key_conflict", "agent_request_outcome_unknown"])(
  "keeps rpc error code %s on DaemonAgentError",
  async (code) => {
    const agents = new DaemonAgents((frame) => {
      const { message } = z
        .object({ message: z.object({ requestId: z.string() }) })
        .parse(JSON.parse(frame));
      agents.receive({
        type: "session",
        message: {
          type: "rpc_error",
          payload: { requestId: message.requestId, error: "Send rejected", code },
        },
      });
    });
    enable(agents);
    const outcome = await agents
      .send("agent", "message-key", "hello")
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(DaemonAgentError);
    expect(outcome).toMatchObject({ message: "Send rejected", code });
  },
);

test("rejects a legacy create failure without treating its code as an RPC error code", async () => {
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.object({ requestId: z.string() }) })
      .parse(JSON.parse(frame));
    agents.receive({
      type: "session",
      message: {
        type: "status",
        payload: {
          requestId: message.requestId,
          status: "agent_create_failed",
          code: "legacy_code",
        },
      },
    });
  });
  enable(agents);
  const error = await agents.create("key", options).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(DaemonAgentError);
  expect(error).toMatchObject({ message: "Daemon request rejected", code: undefined });
});

test.each(["agent_stream", "agent_update"])(
  "consumes a malformed %s without notifying watchers",
  async (type) => {
    const agents = connect([]);
    const listener = vi.fn<(event: AgentEvent) => void>();
    const unwatch = await agents.watch("agent", listener);
    listener.mockClear();
    expect(
      agents.receive({ type: "session", message: { type, payload: { kind: "upsert" } } }),
    ).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    unwatch();
    agents.close();
  },
);

test("a lost send acknowledgement rejects with DaemonResponseLostError", async () => {
  vi.useFakeTimers();
  const sendFrame = vi.fn<(frame: string) => void>();
  const agents = new DaemonAgents(sendFrame);
  try {
    enable(agents);
    const send = agents.send("agent", "message-key", "hello", 100);
    const rejected = expect(send).rejects.toBeInstanceOf(DaemonResponseLostError);
    expect(sendFrame).toHaveBeenCalledOnce();
    expect(sendFrame).toHaveBeenCalledWith(expect.stringContaining('"messageId":"message-key"'));
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    agents.close();
    vi.useRealTimers();
  }
});

test("a titled creation names the agent and then the workspace the daemon created for it", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const created = await agents.create("key", {
    ...options,
    title: "Hub agent",
    workspaceTitle: "Hub · pr-triage · e6a296d1",
  });
  expect(created.workspaceId).toBe("workspace");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    type: "create_agent_request",
    config: { title: "Hub agent" },
  });
  expect(requests[1]).toMatchObject({
    type: "workspace.title.set.request",
    workspaceId: "workspace",
    title: "Hub · pr-triage · e6a296d1",
  });
});

test("a rejected workspace title is reported and leaves the titled agent usable", async () => {
  const requests: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const agents = connect(
    requests,
    (requestId) => ({
      type: "rpc_error",
      payload: { requestId, error: "Workspace not found" },
    }),
    (error, operation) => failures.push(`${operation}: ${String(error)}`),
  );
  const created = await agents.create("key", {
    ...options,
    title: "Hub agent",
    workspaceTitle: "Hub · pr-triage · e6a296d1",
  });
  expect(created.id).toBe("agent");
  expect(requests.map((request) => request["type"])).toEqual([
    "create_agent_request",
    "workspace.title.set.request",
  ]);
  expect(failures).toEqual(["daemon.workspace.title.set: Error: Workspace not found"]);
});

test("requires ordinary agent RPCs and durable receipts instead of falling back to Hub creation", async () => {
  const frames: string[] = [];
  const agents = new DaemonAgents((frame) => frames.push(frame));
  await expect(agents.create("key", options)).rejects.toThrow("Update the Paseo daemon");
  expect(frames).toEqual([]);
});

test("a lost response remains recoverable instead of reporting a rejected creation", async () => {
  const agents = new DaemonAgents(() => {});
  enable(agents);
  const creation = agents.create("key", options);
  agents.close();
  await expect(creation).rejects.toBeInstanceOf(DaemonResponseLostError);
});

test.each(["create", "get", "send", "restore", "interrupt", "archive", "watch"] as const)(
  "%s remains recoverable after close without sending a frame or reopening on server info",
  async (operation) => {
    const frames: string[] = [];
    const agents = new DaemonAgents((frame) => frames.push(frame));
    enable(agents);
    agents.close();
    enable(agents);
    const start = () => {
      if (operation === "create") return agents.create("key", options);
      if (operation === "get") return agents.get("agent");
      if (operation === "send") return agents.send("agent", "message", "hello");
      if (operation === "restore") return agents.restore("workspace");
      if (operation === "watch") return agents.watch("agent", () => {});
      return agents.control("agent", "workspace", operation);
    };
    const outcome = start().catch((error: unknown) => error);
    expect(await outcome).toBeInstanceOf(DaemonResponseLostError);
    expect(frames).toEqual([]);
  },
);

test("a send resuming after an awaited dispatch step reports recoverable transport loss", async () => {
  const frames: string[] = [];
  const agents = new DaemonAgents((frame) => frames.push(frame));
  enable(agents);
  const ready = Promise.withResolvers<void>();
  const dispatch = (async () => {
    await ready.promise;
    await agents.send("agent", "message", "hello");
  })().catch((error: unknown) => error);
  agents.close();
  ready.resolve();
  expect(await dispatch).toBeInstanceOf(DaemonResponseLostError);
  expect(frames).toEqual([]);
});

test("close rejects every pending RPC, clears timers, and leaves no unhandled rejection", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const frames: string[] = [];
  const agents = new DaemonAgents((frame) => frames.push(frame));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    enable(agents);
    const outcomes = [
      agents.create("key", options),
      agents.get("agent"),
      agents.send("agent", "message", "hello"),
      agents.restore("workspace"),
      agents.control("agent", "workspace", "interrupt"),
      agents.watch("agent", () => {}),
    ].map((request) => request.catch((error: unknown) => error));
    expect(vi.getTimerCount()).toBe(6);
    agents.close();
    agents.close();
    for (const outcome of await Promise.all(outcomes))
      expect(outcome).toBeInstanceOf(DaemonResponseLostError);
    expect(vi.getTimerCount()).toBe(0);
    await setImmediate();
    expect(frames).toHaveLength(6);
    expect(unhandled).toEqual([]);
  } finally {
    agents.close();
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  }
});

test.each([
  "fetch_agents_request",
  "agent.timeline.set_subscription.request",
  "fetch_agent_request",
])(
  "closing during watch's %s rejects instead of leaving a live subscription",
  async (pendingType) => {
    const requests: Record<string, unknown>[] = [];
    const pending = Promise.withResolvers<void>();
    const events: AgentEvent[] = [];
    const agents = new DaemonAgents((frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      requests.push(message);
      if (message["type"] === pendingType) {
        pending.resolve();
        return;
      }
      agents.receive({
        type: "session",
        message: { type: "response", payload: { requestId: message["requestId"] } },
      });
    });
    enable(agents);
    const outcome = agents
      .watch("agent", (event) => events.push(event))
      .catch((error: unknown) => error);
    try {
      await pending.promise;
      const sent = requests.length;
      agents.close();
      expect(await outcome).toBeInstanceOf(DaemonResponseLostError);
      expect(requests).toHaveLength(sent);
      expect(
        agents.receive({
          type: "session",
          message: {
            type: "agent_update",
            payload: {
              kind: "upsert",
              agent: { id: "agent", workspaceId: "workspace", status: "idle" },
            },
          },
        }),
      ).toBe(false);
      expect(events).toEqual([]);
    } finally {
      agents.close();
    }
  },
);

test.each(["title", "restore", "watch"] as const)(
  "close between %s RPCs prevents a follow-up frame",
  async (operation) => {
    const frames: string[] = [];
    const agents = new DaemonAgents((frame) => {
      frames.push(frame);
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      agents.receive({
        type: "session",
        message: {
          type: "response",
          payload: {
            requestId: message["requestId"],
            agent: { id: "agent", workspaceId: "workspace", status: "idle" },
            state: { kind: "recoverable" },
          },
        },
      });
      agents.close();
    });
    enable(agents);
    const start = () => {
      if (operation === "title")
        return agents.create("key", { ...options, workspaceTitle: "Workspace" });
      if (operation === "restore") return agents.restore("workspace");
      return agents.watch("agent", () => {});
    };
    await expect(start()).rejects.toBeInstanceOf(DaemonResponseLostError);
    expect(frames).toHaveLength(1);
  },
);

test.each(["title", "watch"] as const)(
  "a lost %s response remains recoverable instead of being swallowed as best effort",
  async (operation) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failures: unknown[] = [];
    const requests: Record<string, unknown>[] = [];
    const events: AgentEvent[] = [];
    const agents = new DaemonAgents(
      (frame) => {
        const { message } = z
          .object({ message: z.record(z.string(), z.unknown()) })
          .parse(JSON.parse(frame));
        requests.push(message);
        if (
          message["type"] ===
          (operation === "title" ? "workspace.title.set.request" : "fetch_agent_request")
        )
          return;
        agents.receive({
          type: "session",
          message: {
            type: "response",
            payload: {
              requestId: message["requestId"],
              agent: { id: "agent", workspaceId: "workspace", status: "idle" },
            },
          },
        });
      },
      undefined,
      (error) => failures.push(error),
    );
    enable(agents);
    try {
      const outcome = (
        operation === "title"
          ? agents.create("key", { ...options, workspaceTitle: "Workspace" })
          : agents.watch("agent", (event) => events.push(event))
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toBeInstanceOf(DaemonResponseLostError);
      expect(failures).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(requests).toHaveLength(operation === "title" ? 2 : 3);
      agents.receive({
        type: "session",
        message: {
          type: "agent_update",
          payload: {
            kind: "upsert",
            agent: { id: "agent", workspaceId: "workspace", status: "idle" },
          },
        },
      });
      expect(events).toEqual([]);
    } finally {
      agents.close();
      vi.useRealTimers();
    }
  },
);

function enable(agents: DaemonAgents): void {
  agents.receive({
    type: "session",
    message: {
      type: "server_info",
      payload: { features: { hubAgentRpc: true, agentRequestReceipts: true } },
    },
  });
}

test.each(["create", "restore", "send"] as const)(
  "%s honors the supplied startup wait without changing the RPC",
  async (operation) => {
    vi.useFakeTimers();
    let respond: (() => void) | undefined;
    const agents = new DaemonAgents((frame) => {
      const { message } = z
        .object({ message: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(frame));
      const reply = () =>
        agents.receive({
          type: "session",
          message: {
            type: "response",
            payload: {
              requestId: message["requestId"],
              state: { kind: "recoverable" },
              accepted: true,
              agent: { id: "agent", workspaceId: "workspace", status: "idle" },
            },
          },
        });
      if (message["type"] === "workspace.recovery.inspect.request") reply();
      else respond = reply;
      expect(message).not.toHaveProperty("timeoutMs");
    });
    try {
      enable(agents);
      const start = () => {
        if (operation === "create") return agents.create("key", options, 180_000);
        if (operation === "restore") return agents.restore("workspace", 180_000);
        return agents.send("agent", "message-key", "hello", 180_000);
      };
      const outcome = start().then(
        () => "accepted",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(150_000);
      expect(respond).toBeDefined();
      respond!();
      expect(await outcome).toBe("accepted");

      const expired = start().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(180_000);
      expect(await expired).toBeInstanceOf(DaemonResponseLostError);
    } finally {
      agents.close();
      vi.useRealTimers();
    }
  },
);

test.each([true, false])(
  "passes background %s at the create request boundary",
  async (background) => {
    const requests: Record<string, unknown>[] = [];
    const agents = connect(requests);
    agents.receive({
      type: "session",
      message: {
        type: "server_info",
        payload: {
          features: {
            hubAgentRpc: true,
            agentRequestReceipts: true,
            backgroundWorkspaces: true,
          },
        },
      },
    });
    await agents.create("background-key", { ...options, background });
    expect(requests[0]).toMatchObject({ type: "create_agent_request", background });
    expect(requests[0]).not.toHaveProperty("config.background");
  },
);

test.each([undefined, false])(
  "creates and sends the prompt when backgroundWorkspaces is %s",
  async (backgroundWorkspaces) => {
    const requests: Record<string, unknown>[] = [];
    const agents = connect(requests);
    agents.receive({
      type: "session",
      message: {
        type: "server_info",
        payload: {
          features: {
            hubAgentRpc: true,
            agentRequestReceipts: true,
            backgroundWorkspaces,
          },
        },
      },
    });
    const created = await agents.create("key", { ...options, background: true });
    await agents.send(created.id, "message-key", "Run the trigger");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      type: "create_agent_request",
      background: true,
    });
    expect(requests[1]).toMatchObject({
      type: "send_agent_message_request",
      agentId: created.id,
      text: "Run the trigger",
    });
  },
);

test("observes agents without requiring the background-workspace feature", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const unwatch = await agents.watch("agent", () => {});
  expect(requests[0]).toMatchObject({
    type: "fetch_agents_request",
    includeBackground: true,
    subscribe: { subscriptionId: "hub-continuation" },
  });
  unwatch();
  agents.close();
});

test("every watch reads current state even when the directory subscription already exists", async () => {
  const requests: Record<string, unknown>[] = [];
  const agents = connect(requests);
  const first: AgentEvent[] = [];
  const second: AgentEvent[] = [];
  const unwatchFirst = await agents.watch("agent", (event) => first.push(event));
  const unwatchSecond = await agents.watch("agent", (event) => second.push(event));
  expect(requests.filter((request) => request["type"] === "fetch_agents_request")).toHaveLength(1);
  expect(requests.filter((request) => request["type"] === "fetch_agent_request")).toHaveLength(2);
  const expected = [
    {
      type: "agent_snapshot",
      agent: { id: "agent", workspaceId: "workspace", status: "idle" },
      timestamp: expect.any(String) as unknown,
    },
  ];
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
  unwatchFirst();
  unwatchSecond();
  agents.close();
});

test.each([
  { name: "missing", payload: {} },
  { name: "null", payload: { agent: null } },
  { name: "invalid", payload: { agent: { id: "agent", status: "unknown" } } },
  {
    name: "other-agent",
    payload: { agent: { id: "other", workspaceId: "workspace", status: "idle" } },
  },
  { name: "rejected", payload: { error: "Unsupported request" } },
])("keeps live observation when the snapshot response is $name", async (response) => {
  const events: AgentEvent[] = [];
  const agents = new DaemonAgents((frame) => {
    const { message } = z
      .object({ message: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(frame));
    const snapshot = message["type"] === "fetch_agent_request";
    agents.receive({
      type: "session",
      message: {
        type: snapshot && response.name === "rejected" ? "rpc_error" : "response",
        payload: {
          requestId: message["requestId"],
          ...(snapshot ? response.payload : {}),
        },
      },
    });
  });
  enable(agents);
  const unwatch = await agents.watch("agent", (event) => events.push(event));
  expect(events).toEqual([]);
  agents.receive({
    type: "session",
    message: {
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: { id: "agent", workspaceId: "workspace", status: "idle" },
      },
    },
  });
  expect(events).toMatchObject([{ type: "agent_update", agent: { status: "idle" } }]);
  unwatch();
  agents.close();
});
