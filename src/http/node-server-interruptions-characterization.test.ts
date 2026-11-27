import { once } from "node:events";
import { request, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginHttpShutdown, createFetchServer } from "./node-server.js";
import { registerResponseLifecycle } from "./response-lifecycle.js";

type Interruption = "close" | "error" | "drain" | "stall" | "unbounded";

function restoreTimers(): void {
  vi.clearAllTimers();
  vi.useRealTimers();
}

afterEach(restoreTimers);

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function openClient(port: number) {
  const client = request({ host: "127.0.0.1", port, agent: false }, (incoming) => {
    incoming.on("error", () => undefined);
    incoming.resume();
  });
  client.on("error", () => undefined);
  client.end();
  return client;
}

function responseClosed(outgoing: ServerResponse): Promise<void> {
  return new Promise((resolve) => outgoing.once("close", resolve));
}

function fixtureResponse(actions: string[], keepReading: boolean, lifecycle: boolean) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first chunk"));
      if (!keepReading) controller.close();
    },
    cancel() {
      actions.push("cancel");
    },
  });
  const response = new Response(body);
  if (!lifecycle) return { response, body };
  return {
    response: registerResponseLifecycle(response, {
      onFinish: () => {
        actions.push("finish");
      },
      onAbort: () => {
        actions.push("abort");
      },
    }),
    body,
  };
}

function forwardingFixture(mode: Interruption) {
  const actions: string[] = [];
  const errors: string[] = [];
  const blocked = Promise.withResolvers<ServerResponse>();
  const { response, body } = fixtureResponse(
    actions,
    mode !== "drain" && mode !== "unbounded",
    mode !== "unbounded",
  );
  const server = createFetchServer(() => response, {
    logger: {
      warn: () => undefined,
      error: () => {
        errors.push("logged");
      },
    },
  });
  server.once("request", (_incoming, outgoing) => {
    const write = outgoing.write.bind(outgoing);
    outgoing.write = (chunk: unknown) => {
      write(chunk);
      blocked.resolve(outgoing);
      return mode === "close";
    };
  });
  return { server, body, actions, errors, blocked: blocked.promise };
}

function snapshot(outgoing: ServerResponse, fixture: ReturnType<typeof forwardingFixture>) {
  return {
    actions: fixture.actions,
    errors: fixture.errors,
    destroyed: outgoing.destroyed,
    finished: outgoing.writableFinished,
    locked: fixture.body.locked,
    listeners: ["drain", "error", "close"].map((event) => outgoing.listenerCount(event)),
    active: beginHttpShutdown(fixture.server).activeRequests,
  };
}

function expected(mode: Interruption) {
  const finishes = mode === "drain" || mode === "unbounded";
  const actions = {
    close: ["abort", "cancel"],
    error: ["abort", "cancel"],
    drain: ["finish"],
    stall: ["cancel", "abort"],
    unbounded: [],
  };
  return {
    actions: actions[mode],
    errors: mode === "error" ? ["logged"] : [],
    destroyed: true,
    finished: finishes,
    locked: false,
    listeners: [0, 0, 0],
    active: 0,
  };
}

function scheduleInterruption(
  mode: Interruption,
  outgoing: ServerResponse,
  abortClient: () => void,
) {
  if (mode === "close") abortClient();
  else if (mode === "error") outgoing.emit("error", new Error("fixture write failure"));
  else if (mode === "stall") vi.advanceTimersByTime(1);
  else outgoing.emit("drain");
}

function checkStallDeadline(mode: Interruption, outgoing: ServerResponse) {
  if (mode === "stall" || mode === "unbounded") {
    vi.advanceTimersByTime(29_999);
    expect(outgoing.destroyed).toBe(false);
  }
  if (mode === "unbounded") {
    vi.advanceTimersByTime(1);
    expect(outgoing.destroyed).toBe(false);
    expect(outgoing.listenerCount("drain")).toBe(1);
  }
}

async function characterizeForwarding(mode: Interruption) {
  const fixture = forwardingFixture(mode);
  const port = await listen(fixture.server);
  const client = openClient(port);
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outgoing = await fixture.blocked;
    const closed = responseClosed(outgoing);
    expect(vi.getTimerCount()).toBe(mode === "close" || mode === "unbounded" ? 0 : 1);
    checkStallDeadline(mode, outgoing);
    scheduleInterruption(mode, outgoing, () => client.destroy());
    await closed;
    await beginHttpShutdown(fixture.server).drained;
    expect(snapshot(outgoing, fixture)).toEqual(expected(mode));
  } finally {
    restoreTimers();
    client.destroy();
    await stop(fixture.server);
  }
}

describe("interrupted and backpressured HTTP responses", () => {
  for (const mode of ["close", "error", "drain", "stall", "unbounded"] as const) {
    it(`settles a forwarding response after ${mode}`, async () => characterizeForwarding(mode));
  }

  it("aborts and cancels a response returned after its client has disconnected", async () => {
    const actions: string[] = [];
    const { response, body } = fixtureResponse(actions, true, true);
    const pending = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<ServerResponse>();
    const server = createFetchServer(() => pending.promise);
    server.once("request", (_incoming, outgoing) => started.resolve(outgoing));
    const client = openClient(await listen(server));
    try {
      const outgoing = await started.promise;
      const closed = responseClosed(outgoing);
      client.destroy();
      await closed;
      expect(actions).toEqual([]);
      pending.resolve(response);
      await beginHttpShutdown(server).drained;
      expect(actions).toEqual(["abort", "cancel"]);
      expect(outgoing.writableFinished).toBe(false);
      expect(body.locked).toBe(false);
    } finally {
      pending.resolve(response);
      client.destroy();
      await stop(server);
    }
  });
});
