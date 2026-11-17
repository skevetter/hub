import assert from "node:assert/strict";
import { ProblemSchema } from "../public-api/contracts.js";
import { once } from "node:events";
import { type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, it, vi } from "vitest";
import { beginHttpShutdown, createFetchServer } from "../http/node-server.js";
import { registerResponseLifecycle } from "../http/response-lifecycle.js";
import { createServerShutdown } from "../server-shutdown.js";
import { createStreamHarness, StreamReader, streamRequest } from "./test-utils.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function listen(server: Server) {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server) {
  if (!server.listening) return;
  const done = Promise.withResolvers<void>();
  server.close(() => done.resolve());
  server.closeAllConnections();
  await done.promise;
}

describe("run stream transport shutdown", () => {
  it("delivers shutdown and EOF to fifty open clients before HTTP close in under five seconds", async () => {
    const harness = await createStreamHarness("memory");
    const run = await harness.createRun();
    const service = harness.stream({ streamMaxPerKey: 100, streamMaxPerOrg: 100 });
    const server = createFetchServer((request) => service.handle(request, run.id), { logger });
    const port = await listen(server);
    const exit = vi.fn();
    const stop = createServerShutdown(
      server,
      async () => {
        assert.equal(service.activeStreamCount(), 0);
        assert.equal(service.notifierCount(), 0);
      },
      {
        graceMs: 10_000,
        hardExitMs: 15_000,
        beginShutdown: () => service.beginShutdown(),
        logger,
        exit,
      },
    );
    try {
      const readers = await Promise.all(
        Array.from({ length: 50 }, async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${run.id}/events`, {
            headers: { authorization: `Bearer ${harness.key}` },
          });
          assert.equal(response.headers.get("connection"), null);
          assert.equal(response.headers.get("content-length"), null);
          assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
          assert.equal(response.headers.get("x-accel-buffering"), "no");
          const reader = new StreamReader(response);
          await reader.event("status");
          return reader;
        }),
      );
      assert.equal(service.activeStreamCount(), 50);
      assert.equal(service.notifierCount(), 1);
      const completed = Promise.all(readers.map((reader) => reader.all()));
      const started = performance.now();
      assert.equal(await stop(), true);
      const output = await completed;
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 5000, `Shutdown took ${elapsedMs} ms`);
      for (const text of output)
        assert.ok(text.includes('event: shutdown\ndata: {"reconnectMs":5000}\n\n'));
      assert.deepEqual(exit.mock.calls, [[0]]);
      assert.equal(beginHttpShutdown(server).activeRequests, 0);
      assert.equal(service.activeStreamCount(), 0);
      assert.equal(service.notifierCount(), 0);
      const rejected = await service.handle(streamRequest(run.id), run.id);
      assert.equal(rejected.status, 503);
      assert.equal(rejected.headers.get("retry-after"), "5");
      assert.equal(ProblemSchema.parse(await rejected.json()).code, "shutting_down");
      process.stdout.write(
        `${JSON.stringify({ scenario: "fifty-stream-stop", clients: output.length, elapsedMs })}\n`,
      );
    } finally {
      await service.beginShutdown();
      await close(server);
      await harness.close();
    }
  });

  it("destroys a real backpressured socket at thirty seconds and cancels its managed reader", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const canceled = Promise.withResolvers<void>();
    const started = Promise.withResolvers<ServerResponse>();
    let active = 0;
    let aborts = 0;
    let chunks = 0;
    const chunk = new Uint8Array(64 * 1024);
    const server = createFetchServer(
      () => {
        active += 1;
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              chunks += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              canceled.resolve();
            },
          },
          { highWaterMark: 0 },
        );
        return registerResponseLifecycle(new Response(body), {
          onFinish: () => {
            active -= 1;
          },
          onAbort: () => {
            active -= 1;
            aborts += 1;
          },
        });
      },
      { logger },
    );
    server.once("request", (_request, outgoing) => started.resolve(outgoing));
    const port = await listen(server);
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => undefined);
    socket.pause();
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    const outgoing = await started.promise;
    const closed = once(outgoing, "close");
    try {
      let stable = false;
      for (let index = 0; index < 200; index++) {
        const before = outgoing.socket?.bytesWritten;
        await delay(10);
        if (
          outgoing.writableNeedDrain &&
          outgoing.listenerCount("drain") > 0 &&
          outgoing.socket?.bytesWritten === before
        ) {
          stable = true;
          break;
        }
      }
      assert.equal(stable, true, "Real socket did not reach stalled drain");
      assert.equal(active, 1);
      const sent = chunks;
      await vi.advanceTimersByTimeAsync(29_999);
      assert.equal(outgoing.destroyed, false);
      assert.equal(chunks, sent);
      await vi.advanceTimersByTimeAsync(1);
      await closed;
      await canceled.promise;
      await setImmediate();
      assert.equal(outgoing.destroyed, true);
      assert.equal(active, 0);
      assert.equal(aborts, 1);
      assert.equal(beginHttpShutdown(server).activeRequests, 0);
      assert.equal(outgoing.listenerCount("drain"), 0);
      assert.equal(outgoing.listenerCount("close"), 0);
      assert.equal(outgoing.listenerCount("error"), 0);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      socket.destroy();
      await close(server);
    }
  });

  it("releases real stream counters, notifier timers and the reader on client disconnect", async () => {
    const harness = await createStreamHarness("memory");
    const run = await harness.createRun();
    const service = harness.stream();
    const server = createFetchServer((request) => service.handle(request, run.id), { logger });
    const outgoing = Promise.withResolvers<ServerResponse>();
    server.once("request", (_request, response) => outgoing.resolve(response));
    const port = await listen(server);
    const abort = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${run.id}/events`, {
        headers: { authorization: `Bearer ${harness.key}` },
        signal: abort.signal,
      });
      const reader = new StreamReader(response);
      await reader.event("status");
      const serverResponse = await outgoing.promise;
      const closed = once(serverResponse, "close");
      abort.abort();
      await closed;
      await setImmediate();
      assert.equal(service.activeStreamCount(), 0);
      assert.equal(service.notifierCount(), 0);
      assert.equal(beginHttpShutdown(server).activeRequests, 0);
      assert.equal(serverResponse.listenerCount("drain"), 0);
      assert.equal(serverResponse.listenerCount("close"), 0);
      assert.equal(serverResponse.listenerCount("error"), 0);
    } finally {
      abort.abort();
      await close(server);
      await harness.close();
    }
  });
});
