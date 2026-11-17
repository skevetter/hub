import assert from "node:assert/strict";
import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { beginHttpShutdown, createFetchServer } from "../http/node-server.js";
import { takeResponseLifecycle } from "../http/response-lifecycle.js";
import type { ApplicationRuntime } from "../server/runtime.js";
import { createStreamHarness, settings, streamRequest, type StreamHarness } from "./test-utils.js";
import {
  loadCompiledStreamRuntime,
  type CompiledStreamRuntime,
} from "./test-utils/compiled-runtime.js";

const logger = { warn: vi.fn(), error: vi.fn() };

describe("compiled response lifecycle ownership", () => {
  let compiled: CompiledStreamRuntime;
  let harness: StreamHarness;
  let application: ApplicationRuntime;
  beforeAll(async () => {
    compiled = await loadCompiledStreamRuntime();
    harness = await createStreamHarness("embedded");
    application = await compiled.createApplicationRuntime({
      database: harness.database,
      auth: harness.auth,
      entitlements: createUnlimitedEntitlementsService(),
      billing: null,
      runProgress: settings,
      close: async () => undefined,
    });
  }, 120_000);
  afterEach(() => {
    vi.useRealTimers();
    assert.equal(application.runStream.activeStreamCount(), 0);
    assert.equal(application.runStream.notifierCount(), 0);
    vi.clearAllMocks();
  });
  afterAll(async () => {
    try {
      await application?.stop();
      await harness?.close();
    } finally {
      await compiled?.remove();
    }
  }, 120_000);

  it("transfers a compiled-owned run response lifecycle to the outer adapter exactly once", async () => {
    const run = await harness.createRun();
    const response = await application.runStream.handle(streamRequest(run.id, harness.key), run.id);
    assert.equal(response.status, 200);
    try {
      assert.equal(application.runStream.activeStreamCount(), 1);
      const lifecycle = takeResponseLifecycle(response);
      assert.ok(lifecycle?.onAbort);
      assert.equal(takeResponseLifecycle(response), undefined);
      await lifecycle.onAbort();
      assert.equal(application.runStream.activeStreamCount(), 0);
      assert.equal(application.runStream.notifierCount(), 0);
    } finally {
      await response.body!.cancel();
    }
  });

  it("destroys a compiled-registered real stalled socket at thirty seconds", async () => {
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
        return compiled.registerResponseLifecycle(new Response(body), {
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
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const socket = connect(address.port, "127.0.0.1");
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
      assert.equal(outgoing.destroyed, true);
      await closed;
      await canceled.promise;
      await setImmediate();
      assert.equal(active, 0);
      assert.equal(aborts, 1);
      assert.equal(beginHttpShutdown(server).activeRequests, 0);
      assert.equal(outgoing.listenerCount("drain"), 0);
      assert.equal(outgoing.listenerCount("close"), 0);
      assert.equal(outgoing.listenerCount("error"), 0);
    } finally {
      socket.destroy();
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      server.closeAllConnections();
      await done.promise;
      await closed;
    }
  });
});
