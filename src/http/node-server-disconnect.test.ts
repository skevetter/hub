import assert from "node:assert/strict";
import { request, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, it, vi } from "vitest";
import { beginHttpShutdown, createFetchServer } from "./node-server.js";
import { createServerShutdown } from "../server-shutdown.js";

const logger = {
  info: vi.fn<(...args: unknown[]) => void>(),
  warn: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("disconnected response admission", () => {
  it("releases a backpressured disconnect before shutdown without reaching grace", async () => {
    const fixture = await StreamingServer.start();
    try {
      await fixture.disconnect("backpressure");
      await fixture.assertCleanShutdown();
    } finally {
      await fixture.close();
    }
  });

  it("releases a client abort during a pending read even when cancellation never finishes", async () => {
    const fixture = await StreamingServer.start();
    try {
      await fixture.disconnect("reading");
      await fixture.assertCleanShutdown();
    } finally {
      await fixture.close();
    }
  });

  it("releases a response error while backpressured and removes its wait listeners", async () => {
    const fixture = await StreamingServer.start();
    try {
      await fixture.disconnect("error");
      await fixture.assertCleanShutdown();
      assert.equal(logger.error.mock.calls.length, 1);
    } finally {
      await fixture.close();
    }
  });

  it("does not accumulate admitted responses across fifty disconnected clients", async () => {
    const fixture = await StreamingServer.start();
    try {
      for (let index = 0; index < 50; index++) {
        await fixture.disconnect("backpressure");
      }
      await fixture.assertCleanShutdown();
    } finally {
      await fixture.close();
    }
  });

  it("releases a late handler result without awaiting its unfinished body cancellation", async () => {
    const fixture = await StreamingServer.start();
    try {
      await fixture.disconnect("late-handler");
      await fixture.assertCleanShutdown();
    } finally {
      await fixture.close();
    }
  });
});

type DisconnectMode = "backpressure" | "reading" | "error" | "late-handler";

class StreamingServer {
  private next:
    | {
        mode: DisconnectMode;
        body: Response;
        release: Promise<void>;
        started: PromiseWithResolvers<ServerResponse>;
        blocked: PromiseWithResolvers<void>;
      }
    | undefined;
  private readonly server = createFetchServer(
    async () => {
      const next = this.next;
      if (next === undefined) throw new Error("Response was not prepared");
      if (next.mode === "late-handler") await next.release;
      return next.body;
    },
    { logger },
  );

  private port = 0;

  private constructor() {}

  static async start(): Promise<StreamingServer> {
    const fixture = new StreamingServer();
    fixture.server.on("request", (_incoming, outgoing) => fixture.observeResponse(outgoing));
    const listening = once(fixture.server, "listening");
    fixture.server.listen(0, "127.0.0.1");
    await listening;
    const address = fixture.server.address();
    assert.ok(address !== null && typeof address !== "string");
    fixture.port = address.port;
    return fixture;
  }

  private observeResponse(outgoing: ServerResponse): void {
    const next = this.next;
    assert.ok(next !== undefined);
    next.started.resolve(outgoing);
    if (next.mode === "backpressure" || next.mode === "error") {
      vi.spyOn(outgoing, "write").mockImplementation(() => {
        next.blocked.resolve();
        return false;
      });
    }
  }

  async disconnect(mode: DisconnectMode): Promise<void> {
    const canceled = Promise.withResolvers<void>();
    const never = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streaming"));
      },
      cancel() {
        canceled.resolve();
        return never.promise;
      },
    });
    const next = {
      mode,
      body: new Response(body),
      release: release.promise,
      started: Promise.withResolvers<ServerResponse>(),
      blocked: Promise.withResolvers<void>(),
    };
    this.next = next;
    const received = Promise.withResolvers<void>();
    const client = request({ host: "127.0.0.1", port: this.port }, (incoming) => {
      incoming.on("data", received.resolve);
      incoming.on("error", ignoreError);
    });
    client.on("error", ignoreError);
    client.end();
    const outgoing = await next.started.promise;
    const closed = Promise.withResolvers<void>();
    outgoing.once("close", closed.resolve);
    try {
      if (mode === "reading") await received.promise;
      else if (mode !== "late-handler") await next.blocked.promise;
      if (mode === "error") outgoing.emit("error", new Error("Response stream failed"));
      else client.destroy();
      await closed.promise;
      release.resolve();
      await canceled.promise;
      await setImmediate();
      assert.equal(outgoing.listenerCount("drain"), 0);
      assert.equal(outgoing.listenerCount("error"), 0);
      assert.equal(outgoing.listenerCount("close"), 0);
    } finally {
      release.resolve();
      never.resolve();
      client.destroy();
      this.next = undefined;
    }
  }

  async assertCleanShutdown(): Promise<void> {
    const drain = beginHttpShutdown(this.server);
    assert.equal(drain.activeRequests, 0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const exit = vi.fn();
    const stop = createServerShutdown(this.server, async () => {}, {
      graceMs: 1000,
      hardExitMs: 1500,
      logger,
      exit,
    });
    assert.equal(await stop(), true);
    assert.equal(drain.activeRequests, 0);
    assert.deepEqual(exit.mock.calls, [[0]]);
    assert.equal(logger.warn.mock.calls.length, 0);
    assert.equal(vi.getTimerCount(), 0);
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    const closed = Promise.withResolvers<void>();
    this.server.close(() => closed.resolve());
    this.server.closeAllConnections();
    await closed.promise;
  }
}

function ignoreError(): void {}
