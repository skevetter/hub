import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  createServerShutdown,
  installShutdownSignals,
  readShutdownBudgets,
} from "./server-shutdown.js";
import { createFetchServer } from "./http/node-server.js";
import { createLogger } from "./logger.js";
import { assertOneFailure, FailureLogStream } from "./test-utils/failure-logs.js";

const logger = {
  info: vi.fn<(...args: unknown[]) => void>(),
  warn: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
};
const budgets = { graceMs: 1_000, hardExitMs: 1_500 };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("production shutdown", () => {
  it("finishes SIGTERM with a connected websocket before the grace deadline", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    const accepted = (webSocket: WebSocket) => webSockets.emit("connection", webSocket);
    server.on("upgrade", (incoming, socket, head) => {
      webSockets.handleUpgrade(incoming, socket, head, accepted);
    });
    const exit = vi.fn();
    const stopRuntime = vi.fn(async () => {
      for (const socket of webSockets.clients) socket.terminate();
    });
    const shutdown = createServerShutdown(server, stopRuntime, { ...budgets, logger, exit });
    const signals = new EventEmitter();
    const finished = Promise.withResolvers<void>();
    const removeSignals = installShutdownSignals(signals, shutdown, finished.resolve);
    const port = await listen(server);
    const connected = once(webSockets, "connection");
    const client = connect(port, "127.0.0.1");
    client.on("data", () => {});
    const closed = once(client, "close");
    try {
      await once(client, "connect");
      client.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      );
      await connected;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      signals.emit("SIGTERM");
      assert.equal(stopRuntime.mock.calls.length, 1);
      await finished.promise;
      assert.deepEqual(exit.mock.calls, [[0]]);
      assert.equal(logger.warn.mock.calls.length, 0);
      await closed;
    } finally {
      removeSignals();
      client.destroy();
      for (const socket of webSockets.clients) socket.terminate();
      server.closeAllConnections();
      server.close();
      webSockets.close();
    }
  });

  it("cuts an unfinished HTTP stream at the grace deadline", async () => {
    const canceled = Promise.withResolvers<void>();
    const server = createFetchServer(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streaming"));
            },
            cancel() {
              canceled.resolve();
            },
          }),
        ),
    );
    const exit = vi.fn();
    const shutdown = createServerShutdown(server, async () => {}, { ...budgets, logger, exit });
    const port = await listen(server);
    const response = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const client = request({ host: "127.0.0.1", port }, (incoming) => {
      incoming.on("data", response.resolve);
      incoming.on("error", ignoreError);
      incoming.on("close", closed.resolve);
    });
    client.on("error", () => {});
    client.end();
    try {
      await response.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stopped = shutdown();
      await vi.advanceTimersByTimeAsync(budgets.graceMs - 1);
      assert.equal(exit.mock.calls.length, 0);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(await stopped, false);
      await closed.promise;
      await canceled.promise;
      assert.deepEqual(exit.mock.calls, [[1]]);
      assert.deepEqual(logRecord(logger.warn.mock.calls[0]?.[0])["pendingStages"], ["http.close"]);
    } finally {
      client.destroy();
      server.closeAllConnections();
      server.close();
    }
  });

  it("destroys upgraded sockets whose runtime never stops", async () => {
    const server = createServer();
    const upgraded = Promise.withResolvers<void>();
    server.on("upgrade", (_request, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      upgraded.resolve();
    });
    const runtime = Promise.withResolvers<void>();
    const exit = vi.fn();
    const shutdown = createServerShutdown(server, () => runtime.promise, {
      ...budgets,
      logger,
      exit,
    });
    const port = await listen(server);
    const client = connect(port, "127.0.0.1");
    client.on("data", () => {});
    const closed = once(client, "close");
    await once(client, "connect");
    client.write(
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    await upgraded.promise;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopped = shutdown();
    try {
      await vi.advanceTimersByTimeAsync(budgets.graceMs);
      await closed;
      assert.equal(exit.mock.calls.length, 0);
      await vi.advanceTimersByTimeAsync(budgets.hardExitMs - budgets.graceMs);
      assert.deepEqual(exit.mock.calls, [[1]]);
      assert.deepEqual(logRecord(logger.error.mock.calls[0]?.[0])["pendingStages"], [
        "runtime.stop",
      ]);
    } finally {
      runtime.resolve();
      await stopped;
      client.destroy();
      server.close();
    }
  });

  it("ignores repeated SIGTERM and SIGINT during one shutdown", async () => {
    const signals = new EventEmitter();
    const result = Promise.withResolvers<boolean>();
    const stop = vi.fn(() => result.promise);
    const finished = Promise.withResolvers<void>();
    const remove = installShutdownSignals(signals, stop, finished.resolve);
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    assert.equal(stop.mock.calls.length, 1);
    result.resolve(true);
    await finished.promise;
    remove();
  });

  it("exits zero for quick shutdown and logs both stages", async () => {
    const server = createServer();
    const exit = vi.fn();
    const stop = createServerShutdown(server, async () => {}, { ...budgets, logger, exit });
    await listen(server);
    assert.equal(await stop(), true);
    assert.equal(await stop(), true);
    assert.deepEqual(exit.mock.calls, [[0]]);
    const records = logger.info.mock.calls.map(([record]) => logRecord(record));
    for (const stage of ["http.close", "runtime.stop"]) {
      assert.deepEqual(
        records.filter((record) => record["stage"] === stage).map((record) => record["phase"]),
        ["start", "end"],
      );
    }
  });

  it("reports a runtime stop failure once and exits nonzero", async () => {
    const server = createServer();
    const stream = new FailureLogStream();
    const failureLogger = createLogger(stream);
    failureLogger.level = "warn";
    const exit = vi.fn();
    const canary = "shutdown-secret-817c";
    const stop = createServerShutdown(
      server,
      async () => {
        throw new Error(canary);
      },
      {
        ...budgets,
        logger: failureLogger,
        exit,
      },
    );
    await listen(server);
    assert.equal(await stop(), false);
    assert.deepEqual(exit.mock.calls, [[1]]);
    assertOneFailure(stream, { operation: "server.shutdown", component: "server", canary });
  });
});

describe("shutdown budgets", () => {
  it("validates bounded budgets and their ordering", () => {
    assert.deepEqual(readShutdownBudgets({}), { graceMs: 10_000, hardExitMs: 15_000 });
    for (const grace of ["999", "40001", "1.5", "invalid"]) {
      assert.throws(() => readShutdownBudgets({ PASEO_HUB_SHUTDOWN_GRACE_MS: grace }));
    }
    for (const hardExit of ["1000", "45000", "1500.1", "invalid"]) {
      assert.throws(() => readShutdownBudgets({ PASEO_HUB_SHUTDOWN_HARD_EXIT_MS: hardExit }));
    }
    assert.throws(() => readShutdownBudgets({ PASEO_HUB_SHUTDOWN_GRACE_MS: "15000" }));
    assert.deepEqual(
      readShutdownBudgets({
        PASEO_HUB_SHUTDOWN_GRACE_MS: "40000",
        PASEO_HUB_SHUTDOWN_HARD_EXIT_MS: "44000",
      }),
      { graceMs: 40_000, hardExitMs: 44_000 },
    );
  });
});

async function listen(server: Server): Promise<number> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

function ignoreError(): void {}

function logRecord(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}
