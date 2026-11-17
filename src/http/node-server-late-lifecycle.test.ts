import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { describe, it, vi } from "vitest";
import { beginHttpShutdown, createFetchServer } from "./node-server.js";
import { registerResponseLifecycle, takeResponseLifecycle } from "./response-lifecycle.js";

describe("late registered response ownership", () => {
  it.each(["complete", "pending", "throw"] as const)(
    "aborts exactly once and cancels the body after disconnect with %s cleanup",
    async (mode) => {
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const returned = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      const outgoingReady = Promise.withResolvers<ServerResponse>();
      const logger = { warn: vi.fn(), error: vi.fn() };
      let response: Response | undefined;
      let aborts = 0;
      let finishes = 0;
      let cancellations = 0;
      const server = createFetchServer(
        async () => {
          started.resolve();
          await gate.promise;
          response = registerResponseLifecycle(
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancellations += 1;
                },
              }),
            ),
            {
              onFinish: () => {
                finishes += 1;
              },
              onAbort: () => {
                aborts += 1;
                if (mode === "throw") throw new Error("synthetic late cleanup failure");
                return mode === "pending" ? cleanup.promise : undefined;
              },
            },
          );
          returned.resolve();
          return response;
        },
        { logger },
      );
      server.once("request", (_incoming, outgoing) => outgoingReady.resolve(outgoing));
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const client = request({ host: "127.0.0.1", port: address.port, agent: false });
      client.on("error", () => undefined);
      client.end();
      try {
        await started.promise;
        const outgoing = await outgoingReady.promise;
        const closed = once(outgoing, "close");
        client.destroy();
        await closed;
        assert.equal(aborts, 0);
        gate.resolve();
        await returned.promise;
        await setImmediate();
        assert.ok(response);
        assert.equal(aborts, 1);
        assert.equal(finishes, 0);
        assert.equal(cancellations, 1);
        assert.equal(takeResponseLifecycle(response), undefined);
        assert.equal(beginHttpShutdown(server).activeRequests, 0);
        outgoing.emit("close");
        await setImmediate();
        assert.equal(aborts, 1);
        assert.equal(finishes, 0);
        assert.equal(cancellations, 1);
        assert.equal(logger.error.mock.calls.length, mode === "throw" ? 1 : 0);
      } finally {
        gate.resolve();
        cleanup.resolve();
        client.destroy();
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        server.closeAllConnections();
        await closed.promise;
        if (response?.body !== null && response?.body !== undefined) await response.body.cancel();
      }
    },
  );
});
