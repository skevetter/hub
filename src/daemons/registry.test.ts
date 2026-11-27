import { z } from "zod";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DaemonRecord } from "../db/types.js";
import { classifyFailure } from "../failures/index.js";
import { HubDaemonHelloSchema } from "../hub/protocol.js";
import { createLogger } from "../logger.js";
import { assertOneFailure, FailureLogStream } from "../test-utils/failure-logs.js";
import { DaemonDisconnectedError } from "./disconnected-error.js";
import { DaemonResponseLostError } from "./protocol.js";
import { ActiveDaemonRegistry, createDaemonUpgradeHandler } from "./registry.js";
import { DaemonRegistryHarness } from "./test-utils/daemon-registry-harness.js";

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}

describe("daemon socket deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function unopenedSocket(): WebSocket {
    const socket = z
      .instanceof(WebSocket)
      .parse(Reflect.construct(WebSocket, [null, undefined, { autoPong: true }]));
    vi.spyOn(socket, "send").mockImplementation(() => {});
    return socket;
  }

  function setup(closeImmediately: boolean) {
    const now = new Date();
    const daemon: DaemonRecord = {
      id: "shutdown-daemon",
      slug: "shutdown-daemon",
      machineId: "shutdown-machine",
      serverId: "shutdown-server",
      daemonPublicKey: "public-key",
      credentialVerifier: "verifier",
      permissions: ["hub.execute"],
      registeredByApiKeyId: null,
      registeredByCliCredentialId: null,
      status: "active",
      presence: "connected",
      connectedAt: now,
      disconnectedAt: null,
      lastSeenAt: now,
      createdAt: now,
    };
    const stream = new FailureLogStream();
    const setDaemonPresence = vi.fn(async (): Promise<void> => undefined);
    const registry = new ActiveDaemonRegistry(
      {
        touchDaemon: async () => undefined,
        setDaemonPresence,
      },
      undefined,
      createLogger(stream),
    );
    const socket = unopenedSocket();
    const close = vi.spyOn(socket, "close").mockImplementation(() => {
      if (closeImmediately) socket.emit("close", 1001, Buffer.alloc(0));
    });
    const terminate = vi.spyOn(socket, "terminate").mockImplementation(() => {
      setTimeout(() => socket.emit("close", 1006, Buffer.alloc(0)), 1);
    });
    registry.accept(daemon, socket);
    return { registry, daemon, socket, close, terminate, stream, setDaemonPresence };
  }

  it("reports a disconnect once per socket generation and ignores a replaced socket", async () => {
    const { registry, daemon, socket } = setup(true);
    const disconnected = vi.fn<(record: DaemonRecord) => void>();
    const unsubscribe = registry.onDisconnected(disconnected);

    const current = unopenedSocket();
    registry.accept(daemon, current, "legacy");
    socket.emit("close", 4001, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disconnected.mock.calls.length, 0);

    current.emit("close", 1000, Buffer.alloc(0));
    current.emit("close", 1000, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(disconnected.mock.calls, [[daemon]]);

    const reconnected = unopenedSocket();
    registry.accept(daemon, reconnected, "legacy");
    reconnected.emit("close", 1000, Buffer.alloc(0));
    await registry.stop();
    assert.deepEqual(disconnected.mock.calls, [[daemon], [daemon]]);
    unsubscribe();
  });

  it("exposes timeline history through the active agent adapter", async () => {
    const { registry, daemon } = setup(true);
    const socket = unopenedSocket();
    registry.accept(daemon, socket, "legacy");
    const connection = registry.connection(daemon.id);
    assert(connection);
    assert.equal(connection.history, connection.agents);
    socket.emit("close", 1000, Buffer.alloc(0));
    await registry.stop();
  });

  it("terminates an unresponsive socket after one second and reports the deadline", async () => {
    vi.useFakeTimers();
    const { registry, socket, close, terminate, stream } = setup(false);
    let stopped = false;
    const stopping = registry.stop().then(() => {
      stopped = true;
      return undefined;
    });
    assert.deepEqual(close.mock.calls, [[1001, "server shutdown"]]);
    await vi.advanceTimersByTimeAsync(999);
    assert.equal(stopped, false);
    assert.equal(terminate.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(stopped, false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    assert.equal(terminate.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(socket.listenerCount("close"), 1);
    assertOneFailure(stream, {
      operation: "daemon.socket.close",
      component: "daemons",
      failureKind: "network",
      canary: "shutdown-never-logged",
    });
  });

  it("waits for offline presence after asynchronous terminated socket close", async () => {
    vi.useFakeTimers();
    const { registry, socket, setDaemonPresence } = setup(false);
    const offlinePresence = Promise.withResolvers<void>();
    setDaemonPresence.mockReturnValue(offlinePresence.promise);
    let stopped = false;
    const stopping = registry.stop().then(() => {
      stopped = true;
      return undefined;
    });

    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(stopped, false);
    assert.equal(setDaemonPresence.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(setDaemonPresence.mock.calls.length, 1);
    assert.equal(stopped, false);

    offlinePresence.resolve();
    await stopping;
    assert.equal(stopped, true);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(socket.listenerCount("close"), 1);
  });

  it("rejects shutdown if a terminated socket does not close within one second", async () => {
    vi.useFakeTimers();
    const { registry, socket, terminate, setDaemonPresence } = setup(false);
    terminate.mockImplementation(() => {});
    let settled = false;
    const stopping = registry.stop();
    void stopping.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    const rejected = assert.rejects(stopping, {
      message: "daemon socket did not close after termination",
    });

    await vi.advanceTimersByTimeAsync(1999);
    assert.equal(terminate.mock.calls.length, 1);
    assert.equal(settled, false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    assert.equal(settled, true);
    assert.equal(setDaemonPresence.mock.calls.length, 0);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(socket.listenerCount("close"), 1);
  });

  it.each(["close", "terminate"] as const)(
    "cleans up shutdown waiters when %s throws",
    async (method) => {
      vi.useFakeTimers();
      const { registry, socket, close, terminate } = setup(false);
      const failure = new Error("socket shutdown failed");
      const operation = method === "close" ? close : terminate;
      operation.mockImplementation(() => {
        throw failure;
      });
      const rejected = assert.rejects(registry.stop(), failure);
      if (method === "terminate") await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      assert.equal(vi.getTimerCount(), 0);
      assert.equal(socket.listenerCount("close"), 1);
    },
  );

  it("clears the shutdown timer after a normal close handshake", async () => {
    vi.useFakeTimers();
    const { registry, terminate, stream } = setup(true);
    await registry.stop();
    assert.equal(vi.getTimerCount(), 0);
    await vi.advanceTimersByTimeAsync(1000);
    assert.equal(terminate.mock.calls.length, 0);
    assert.equal(stream.failures().length, 0);
  });

  function setupProviderRead() {
    vi.useFakeTimers();
    const { registry, daemon, socket } = setup(true);
    const send = vi.spyOn(socket, "send");
    const receive = (message: unknown) => {
      socket.emit("message", Buffer.from(JSON.stringify({ type: "session", message })));
    };
    receive({
      type: "status",
      payload: {
        status: "server_info",
        serverId: daemon.serverId,
        permissions: daemon.permissions,
        features: { providersSnapshot: true },
      },
    });
    const connection = registry.connection(daemon.id);
    assert(connection);
    const requestId = () => {
      const sent = send.mock.calls.at(-1)?.[0];
      assert(typeof sent === "string");
      return z.object({ message: z.object({ requestId: z.string() }) }).parse(JSON.parse(sent))
        .message.requestId;
    };
    return {
      registry,
      daemon,
      socket,
      send,
      connection,
      requestId,
      receive,
      isPending: (id: string) => registry["pendingByDaemon"].get(daemon.id)?.has(id) ?? false,
    };
  }

  it.each(["getProviderSnapshot", "refreshProviderSnapshot"] as const)(
    "removes %s after 20 seconds without an answer",
    async (method) => {
      const { connection, requestId, isPending } = setupProviderRead();
      const rejected = assert.rejects(connection[method]({}), (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.message, "daemon_provider_timeout");
        assert.equal(classifyFailure(error), "timeout");
        return true;
      });
      const id = requestId();

      await vi.advanceTimersByTimeAsync(19_999);
      assert.equal(isPending(id), true);
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      assert.equal(isPending(id), false);
      assert.equal(vi.getTimerCount(), 0);
    },
  );

  it("clears the provider deadline when a snapshot arrives in time", async () => {
    const { connection, requestId, receive } = setupProviderRead();
    const snapshot = connection.getProviderSnapshot({});
    await vi.advanceTimersByTimeAsync(19_999);
    const payload = { requestId: requestId(), entries: [], generatedAt: new Date().toISOString() };
    receive({ type: "get_providers_snapshot_response", payload });

    assert.deepEqual(await snapshot, payload);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("ignores a late snapshot answer while a retry is pending", async () => {
    const { connection, requestId, receive, isPending } = setupProviderRead();
    const rejected = assert.rejects(connection.getProviderSnapshot({}), {
      message: "daemon_provider_timeout",
    });
    const expiredId = requestId();
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;

    const retry = connection.getProviderSnapshot({});
    const payload = { requestId: requestId(), entries: [], generatedAt: new Date().toISOString() };
    receive({
      type: "get_providers_snapshot_response",
      payload: { ...payload, requestId: expiredId },
    });
    assert.equal(isPending(expiredId), false);
    assert.equal(isPending(payload.requestId), true);
    assert.equal(vi.getTimerCount(), 1);

    receive({ type: "get_providers_snapshot_response", payload });
    assert.deepEqual(await retry, payload);
  });

  it("clears the provider deadline on an RPC error", async () => {
    const { connection, requestId, receive } = setupProviderRead();
    const rejected = assert.rejects(connection.refreshProviderSnapshot({}), {
      message: "refresh failed",
    });
    receive({ type: "rpc_error", payload: { requestId: requestId(), error: "refresh failed" } });

    await rejected;
    assert.equal(vi.getTimerCount(), 0);
  });

  it("clears the provider deadline when a refresh is not acknowledged", async () => {
    const { connection, requestId, receive, isPending } = setupProviderRead();
    const rejected = assert.rejects(connection.refreshProviderSnapshot({}), {
      message: "daemon provider refresh was not acknowledged",
    });
    const id = requestId();
    receive({
      type: "refresh_providers_snapshot_response",
      payload: { requestId: id, acknowledged: false },
    });

    await rejected;
    assert.equal(isPending(id), false);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("removes a pending provider request and clears its deadline when send throws", async () => {
    const { connection, send, requestId, isPending } = setupProviderRead();
    const failure = new Error("send failed");
    send.mockImplementationOnce(() => {
      throw failure;
    });

    await assert.rejects(connection.getProviderSnapshot({}), (error) => error === failure);
    assert.equal(isPending(requestId()), false);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("rejects old provider requests and clears their deadlines when a socket is replaced", async () => {
    const { connection, registry, daemon, requestId, isPending } = setupProviderRead();
    const disconnected = { message: "daemon disconnected" };
    const snapshotRejected = assert.rejects(connection.getProviderSnapshot({}), disconnected);
    const snapshotId = requestId();
    const refreshRejected = assert.rejects(connection.refreshProviderSnapshot({}), disconnected);
    const refreshId = requestId();
    assert.equal(vi.getTimerCount(), 2);

    registry.accept(daemon, unopenedSocket());

    await Promise.all([snapshotRejected, refreshRejected]);
    assert.equal(isPending(snapshotId), false);
    assert.equal(isPending(refreshId), false);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("fails a request that loses its daemon as an upstream failure, not an internal one", async () => {
    const { connection, registry, daemon } = setupProviderRead();
    const rejected = assert.rejects(
      connection.getProviderSnapshot({}),
      (error) =>
        error instanceof DaemonDisconnectedError &&
        error.message === "daemon disconnected" &&
        classifyFailure(error) === "upstreamUnavailable",
    );

    registry.accept(daemon, unopenedSocket());

    await rejected;
  });

  it.each(["disconnect", "stop"] as const)("clears the provider deadline on %s", async (event) => {
    const { connection, registry, socket } = setupProviderRead();
    const rejected = assert.rejects(
      connection.getProviderSnapshot({}),
      (error) =>
        error instanceof DaemonDisconnectedError &&
        error.message === "daemon disconnected" &&
        classifyFailure(error) === "upstreamUnavailable",
    );
    if (event === "disconnect") socket.emit("close", 1000, Buffer.alloc(0));
    else await registry.stop();

    await rejected;
    assert.equal(vi.getTimerCount(), 0);
  });
});

describe("daemon socket protocol negotiation", () => {
  it.each([
    {
      offered: true,
      expectedProtocol: "1",
      expectsHello: true,
      expectsReady: false,
    },
    {
      offered: false,
      expectedProtocol: undefined,
      expectsHello: false,
      expectsReady: true,
    },
  ])(
    "negotiates the standard session only when offered=$offered",
    async ({ offered, expectedProtocol, expectsHello, expectsReady }) => {
      const secret = "daemon-secret";
      const now = new Date();
      const daemon: DaemonRecord = {
        id: randomUUID(),
        slug: "negotiation-daemon",
        machineId: randomUUID(),
        serverId: randomUUID(),
        daemonPublicKey: "public-key",
        credentialVerifier: createHash("sha256").update(secret).digest("base64url"),
        permissions: ["hub.execute"],
        registeredByApiKeyId: null,
        registeredByCliCredentialId: null,
        status: "active",
        presence: "offline",
        connectedAt: null,
        disconnectedAt: null,
        lastSeenAt: now,
        createdAt: now,
      };
      const registry = new ActiveDaemonRegistry({
        touchDaemon: async () => undefined,
        setDaemonPresence: async () => undefined,
      });
      const server = createServer();
      const handleUpgrade = createDaemonUpgradeHandler(
        { findDaemonById: async () => daemon },
        registry,
      );
      server.on("upgrade", (request, socket, head) => {
        void handleUpgrade(request, socket, head);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      const messages: string[] = [];
      let negotiatedProtocol: string | string[] | undefined;
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/daemons/socket`, {
        headers: {
          authorization: `Bearer ${secret}`,
          "x-paseo-daemon-id": daemon.id,
          ...(offered ? { "x-paseo-session-protocol": "1" } : {}),
        },
      });
      client.on("upgrade", (response) => {
        negotiatedProtocol = response.headers["x-paseo-session-protocol"];
      });
      client.on("message", (data: RawData) => {
        messages.push(rawDataToText(data));
      });
      const receivedHello = () =>
        messages.some((message) => HubDaemonHelloSchema.safeParse(JSON.parse(message)).success);
      try {
        await new Promise<void>((resolve, reject) => {
          client.once("open", resolve);
          client.once("error", reject);
        });
        if (expectsHello)
          await vi.waitFor(() => assert.equal(receivedHello(), true), { timeout: 1_000 });
        assert.equal(negotiatedProtocol, expectedProtocol);
        assert.equal(registry.connection(daemon.id) !== undefined, expectsReady);
      } finally {
        if (client.readyState !== WebSocket.CLOSED) {
          const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
          client.close();
          await closed;
        }
        await registry.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      assert.equal(receivedHello(), expectsHello);
    },
  );
});

describe("daemon socket generations", () => {
  it("does not expose a physical socket until standard session bootstrap completes", async () => {
    await daemon.replaceConnection(false);

    assert.equal(daemon.connected(), false);
    await daemon.completeServerInfo();

    assert.equal(daemon.connected(), true);
  });

  it("rejects a session whose effective permissions differ from enrollment", async () => {
    await daemon.replaceConnection(false);
    await daemon.completeServerInfo([]);

    await daemon.waitUntilCurrentClosed();
    assert.equal(daemon.connected(), false);
  });

  it("keeps a legacy daemon connected without sending the standard hello", async () => {
    await daemon.replaceConnection(false, "legacy");

    assert.equal(daemon.connected(), true);
  });

  let daemon: DaemonRegistryHarness;
  let stream: FailureLogStream;

  beforeEach(async () => {
    stream = new FailureLogStream();
    daemon = await DaemonRegistryHarness.start(createLogger(stream));
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it("rejects superseded requests before close and keeps the replacement usable", async () => {
    const oldCreate = await daemon.pendingCreate("old-create");

    const replacement = await daemon.replaceConnection();

    assert.equal(replacement.supersededClosed, false);
    await assert.rejects(oldCreate.promise, {
      name: DaemonResponseLostError.name,
      message: "daemon response was lost",
    });
    assert.deepEqual(await daemon.completeCreate("new-create", "agent-new"), {
      id: "agent-new",
      workspaceId: "workspace-agent-new",
      status: "idle",
    });
  });

  it("forwards only structured MCP grants with opaque provider options", async () => {
    const pending = await daemon.pendingCreate("contract-create");

    assert.deepEqual(
      z.record(z.string(), z.unknown()).parse(pending.request["config"])["providerOptions"],
      {
        permission: { edit: "ask", bash: "deny" },
      },
    );
    assert.deepEqual(
      z.record(z.string(), z.unknown()).parse(pending.request["config"])["toolPolicy"],
      {
        preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
      },
    );
  });

  it("delegates provider, model, mode, and structured option validation to the daemon", async () => {
    const pending = await daemon.pendingAgentValidation();

    assert.equal(pending.request["provider"], "definitely-not-installed");
    assert.equal(pending.request["model"], "imaginary-model");
    assert.equal(pending.request["modeId"], "imaginary-mode");
    assert.deepEqual(pending.request["providerOptions"], { nonsense: true });
    daemon.respondAgentValidation(pending);

    assert.deepEqual(await pending.promise, {
      valid: false,
      issues: [
        { path: ["provider"], message: "provider is unavailable" },
        {
          path: ["options", "nonsense"],
          message: "unrecognized provider option",
        },
      ],
    });
  });

  it("reads and refreshes provider capabilities through the Hub execution session", async () => {
    const refresh = await daemon.pendingProviderRefresh();
    assert.deepEqual(
      { cwd: refresh.request["cwd"], providers: refresh.request["providers"] },
      { cwd: "/workspace", providers: ["codex"] },
    );
    daemon.respondProviderRefresh(refresh);
    await refresh.promise;

    const snapshot = await daemon.pendingProviderSnapshot();
    daemon.respondProviderSnapshot(snapshot);

    assert.deepEqual((await snapshot.promise).entries, [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        models: [
          {
            provider: "codex",
            id: "gpt-5.4",
            label: "GPT-5.4",
            thinkingOptions: [{ id: "xhigh", label: "Extra high" }],
          },
        ],
        modes: [{ id: "full-access", label: "Full access" }],
      },
    ]);
  });

  it("waits for offline presence before shutdown completes", async () => {
    daemon.holdOfflinePresence();

    daemon.beginStop();
    await daemon.offlinePresenceBegins();

    assert.equal(await daemon.shutdownCompleted(), false);
    daemon.persistOfflinePresence();
    await daemon.shutdownCompletes();
  });

  it("logs an offline-presence storage rejection exactly once", async () => {
    const canary = "offline-presence-secret-7e12";
    daemon.failOfflinePresence(new Error(canary));
    await daemon.disconnectCurrent();
    await vi.waitFor(() => assert.equal(stream.failures().length, 1));
    await assert.rejects(daemon.stop(), { message: canary });

    assertOneFailure(stream, {
      operation: "daemon.presence.offline",
      component: "daemons",
      canary,
    });
  });

  it("logs a connected recovery rejection without blocking later handlers", async () => {
    const canary = "connected-recovery-secret-32f1";
    let laterHandlerRan = false;
    daemon.onConnected(() => Promise.reject(new Error(canary)));
    daemon.onConnected(() => {
      laterHandlerRan = true;
    });
    await daemon.replaceConnection();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(laterHandlerRan, true);
    assertOneFailure(stream, {
      operation: "daemon.connected.handler",
      component: "daemons",
      canary,
    });
  });

  it("closes malformed WebSocket JSON intentionally and logs no payload", async () => {
    const canary = "malformed-websocket-secret-a83f";
    daemon.sendRaw(`not-json-${canary}`);
    await daemon.waitUntilCurrentClosed();
    await new Promise((resolve) => setImmediate(resolve));

    assertOneFailure(stream, {
      operation: "daemon.websocket.message.parse",
      component: "daemons",
      failureKind: "validation",
      level: 40,
      canary,
    });
  });

  it("pairs ordinary control acknowledgements by request", async () => {
    const pending = await daemon.pendingControl("execution-1", "archive");

    daemon.respondControl(pending, { requestId: "request-stale" });
    assert.equal(await daemon.requestSettled(pending.promise), false);
    daemon.respondControl(pending);

    await pending.promise;
  });

  it("rejects execution-control acknowledgements from a superseded generation", async () => {
    const pending = await daemon.pendingControl("execution-1", "interrupt");

    await daemon.replaceConnection();

    await assert.rejects(pending.promise, DaemonResponseLostError);
  });

  it("survives an invalid WebSocket close code instead of crashing the process", async () => {
    // Real production crash: a peer sending a close frame with a code the
    // protocol forbids on the wire (1006 is reserved and must never be
    // sent) makes `ws`'s Receiver emit `error` on the server socket. With
    // no `error` listener, Node rethrows it as an uncaught exception and
    // kills the whole Hub process. If `accept()` regresses, this test
    // crashes the worker instead of merely failing an assertion.
    daemon.sendInvalidClose(1006);
    await daemon.waitUntilCurrentClosed();
    await new Promise((resolve) => setImmediate(resolve));

    assertOneFailure(stream, {
      operation: "daemon.socket.error",
      component: "daemons",
      failureKind: "network",
      canary: "invalid-close-code-1006-never-logged",
    });
  });
});

describe("daemon socket heartbeat", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function connectDaemon(options: {
    autoPong: boolean;
    sessionProtocol: "legacy" | "session-v1";
  }) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const now = new Date();
    const daemon: DaemonRecord = {
      id: randomUUID(),
      slug: "heartbeat-daemon",
      machineId: randomUUID(),
      serverId: randomUUID(),
      daemonPublicKey: "public-key",
      credentialVerifier: "verifier",
      permissions: ["hub.execute"],
      registeredByApiKeyId: null,
      registeredByCliCredentialId: null,
      status: "active",
      presence: "offline",
      connectedAt: null,
      disconnectedAt: null,
      lastSeenAt: now,
      createdAt: now,
    };
    const stream = new FailureLogStream();
    const presence: string[] = [];
    const registry = new ActiveDaemonRegistry(
      {
        touchDaemon: async () => undefined,
        setDaemonPresence: async (_id, value) => {
          presence.push(value);
        },
      },
      undefined,
      createLogger(stream),
    );
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(async () => {
      await registry.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert(address !== null && typeof address === "object");
    const accepted = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
      autoPong: options.autoPong,
    });
    cleanups.push(async () => {
      client.terminate();
    });
    const pings: number[] = [];
    client.on("ping", () => pings.push(pings.length));
    client.on("message", (data: RawData) => {
      if (!HubDaemonHelloSchema.safeParse(JSON.parse(rawDataToText(data))).success) return;
      client.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: { status: "server_info", serverId: "heartbeat", permissions: ["hub.execute"] },
          },
        }),
      );
    });
    const clientClosed = new Promise<number>((resolve) => {
      client.once("close", (code) => resolve(code));
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const socket = await accepted;
    // vi.waitFor advances fake timers on every poll, which would move the heartbeat clock.
    const ready = new Promise<void>((resolve) => registry.onConnected(() => resolve()));
    registry.accept(daemon, socket, options.sessionProtocol);
    await ready;
    return { registry, daemon, client, socket, pings, presence, stream, clientClosed };
  }

  async function heartbeatAnswered(socket: WebSocket): Promise<void> {
    const pong = once(socket, "pong");
    await vi.advanceTimersByTimeAsync(30_000);
    await pong;
  }

  function closeRecords(stream: FailureLogStream) {
    return stream.records().filter((record) => record["operation"] === "daemon.socket.closed");
  }

  it("keeps an idle daemon connected past the proxy idle window", async () => {
    const { registry, daemon, socket, pings, presence } = await connectDaemon({
      autoPong: true,
      sessionProtocol: "session-v1",
    });

    for (let interval = 0; interval < 10; interval += 1) await heartbeatAnswered(socket);

    assert.equal(pings.length, 10);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.notEqual(registry.connection(daemon.id), undefined);
    assert.deepEqual(presence, ["connected"]);
  });

  it("keeps a legacy daemon that sends no keepalive of its own connected", async () => {
    const { registry, daemon, client, socket, pings } = await connectDaemon({
      autoPong: true,
      sessionProtocol: "legacy",
    });
    let clientPings = 0;
    socket.on("ping", () => {
      clientPings += 1;
    });

    for (let interval = 0; interval < 10; interval += 1) await heartbeatAnswered(socket);

    assert.equal(clientPings, 0);
    assert.equal(pings.length, 10);
    assert.equal(client.readyState, WebSocket.OPEN);
    assert.notEqual(registry.connection(daemon.id), undefined);
  });

  it("terminates a daemon that stops answering pings after 90 seconds and logs the close", async () => {
    const { registry, daemon, client, socket, pings, presence, stream, clientClosed } =
      await connectDaemon({
        autoPong: false,
        sessionProtocol: "session-v1",
      });

    for (let interval = 0; interval < 2; interval += 1) {
      const ping = once(client, "ping");
      await vi.advanceTimersByTimeAsync(30_000);
      await ping;
    }
    await vi.advanceTimersByTimeAsync(29_999);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(pings.length, 2);
    assert.notEqual(registry.connection(daemon.id), undefined);

    await vi.advanceTimersByTimeAsync(1);
    assert.notEqual(socket.readyState, WebSocket.OPEN);
    assert.equal(await clientClosed, 1006);
    await vi.waitFor(() => assert.deepEqual(presence, ["connected", "offline"]));
    assert.equal(registry.connection(daemon.id), undefined);
    const [record, ...rest] = closeRecords(stream);
    assert.deepEqual(rest, []);
    assert.equal(record?.["level"], 40);
    assert.equal(record["msg"], "daemon socket closed after missed heartbeat");
    assert.equal(record["daemonId"], daemon.id);
    assert.equal(record["closeCode"], 1006);
    assert.equal(record["closeReason"], "");
    assert.equal(typeof record["connectedMs"], "number");
  });

  it("measures the 90 seconds from the latest pong", async () => {
    const { client, socket } = await connectDaemon({
      autoPong: false,
      sessionProtocol: "session-v1",
    });
    const ping = once(client, "ping");
    await vi.advanceTimersByTimeAsync(30_000);
    await ping;
    await vi.advanceTimersByTimeAsync(5_000);
    const pong = once(socket, "pong");
    client.pong();
    await pong;

    await vi.advanceTimersByTimeAsync(89_999);
    assert.equal(socket.readyState, WebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(1);
    assert.notEqual(socket.readyState, WebSocket.OPEN);
  });

  it("logs the close code of an ordinary disconnect without peer-supplied reason text", async () => {
    const { client, stream } = await connectDaemon({
      autoPong: true,
      sessionProtocol: "session-v1",
    });
    const canary = "close-reason-secret-41c7";

    client.close(4000, canary);
    await vi.waitFor(() => assert.equal(closeRecords(stream).length, 1));

    const [record] = closeRecords(stream);
    assert.equal(record?.["level"], 30);
    assert.equal(record["msg"], "daemon socket closed");
    assert.equal(record["closeCode"], 4000);
    assert.equal(record["closeReason"], "unrecognized");
    assert.equal(stream.text().includes(canary), false);
  });

  it("logs the reason Hub gave when it replaces a daemon socket", async () => {
    const { registry, daemon, socket, stream } = await connectDaemon({
      autoPong: true,
      sessionProtocol: "legacy",
    });

    registry.accept(daemon, unopenedReplacement(), "legacy");
    await once(socket, "close");

    const [record] = closeRecords(stream);
    assert.equal(record?.["closeCode"], 4001);
    assert.equal(record["closeReason"], "replaced");
  });

  function unopenedReplacement(): WebSocket {
    const replacement = z
      .instanceof(WebSocket)
      .parse(Reflect.construct(WebSocket, [null, undefined, { autoPong: true }]));
    vi.spyOn(replacement, "close").mockImplementation(() => {
      replacement.emit("close", 1001, Buffer.alloc(0));
    });
    return replacement;
  }
});
