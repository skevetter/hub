import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { it } from "vitest";
import { ProblemSchema } from "../public-api/contracts.js";
import { webhookFixture } from "../public-api/test-utils/webhook-fixture.js";
import { beginHttpShutdown, createFetchServer } from "./node-server.js";

it("flushes oversized webhook problems before closing intake and preserves healthy keepalive and shutdown", async () => {
  const hub = await webhookFixture({ maxBytes: 1024 });
  const server = createFetchServer((incoming) => hub.application.publicApi.handle(incoming));
  const received: IncomingMessage[] = [];
  server.on("request", (incoming) => received.push(incoming));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const trigger = await hub.save();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = new URL(`http://127.0.0.1:${address.port}/api/v1/hooks/${trigger.name}`);
    const headers = {
      authorization: `Bearer ${hub.key.secret}`,
      "content-type": "text/plain",
    };
    for (const declaredLength of [true, false]) {
      const exchange = send(url, {
        headers: {
          ...headers,
          ...(declaredLength ? { "content-length": "1025" } : {}),
        },
        ...(declaredLength ? {} : { openChunked: true }),
        body: "x".repeat(1025),
        agent,
      });
      const result = await exchange.response;
      assert.equal(result.status, 413);
      assert.equal(result.headers["content-type"], "application/problem+json");
      assert.equal(ProblemSchema.parse(JSON.parse(result.body)).code, "payload_too_large");
      assert.equal(result.headers.connection, "close");
      if (!declaredLength) assert.equal(exchange.outgoing.writableEnded, false);
      await exchange.closed;
      assert.deepEqual(exchange.errors, []);
      const incoming = received.at(-1);
      assert.ok(incoming);
      assert.equal(incoming.listenerCount("readable"), 0);
      assert.ok(incoming.readableLength <= incoming.readableHighWaterMark);
    }

    const first = await send(url, { headers, body: "healthy first", agent }).response;
    const second = await send(url, { headers, body: "healthy second", agent }).response;
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(first.socket, second.socket);
    assert.equal(second.headers.connection, "keep-alive");
    agent.destroy();
    await setImmediate();
    const shutdown = beginHttpShutdown(server);
    assert.equal(shutdown.activeRequests, 0);
    await shutdown.drained;
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error === undefined ? closed.resolve() : closed.reject(error)));
    await closed.promise;
  } finally {
    agent.destroy();
    server.closeAllConnections();
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
    await hub.close();
  }
}, 120_000);

function send(
  url: URL,
  options: {
    headers: Record<string, string>;
    body: string;
    agent: Agent;
    openChunked?: boolean;
  },
) {
  const response = Promise.withResolvers<{
    status: number | undefined;
    headers: IncomingMessage["headers"];
    body: string;
    socket: Socket;
  }>();
  const closed = Promise.withResolvers<void>();
  const errors: Error[] = [];
  let socket: Socket;
  const outgoing = request(
    url,
    { method: "POST", headers: options.headers, agent: options.agent },
    (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", response.reject);
      incoming.once("end", () => {
        response.resolve({
          status: incoming.statusCode,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          socket,
        });
      });
    },
  );
  outgoing.once("socket", (assigned) => {
    socket = assigned;
    assigned.once("close", () => closed.resolve());
  });
  outgoing.once("error", (error) => {
    errors.push(error);
    response.reject(error);
  });
  if (options.openChunked === true) {
    outgoing.write(options.body.slice(0, 700));
    outgoing.write(options.body.slice(700));
  } else {
    outgoing.end(options.body);
  }
  return { outgoing, response: response.promise, closed: closed.promise, errors };
}
