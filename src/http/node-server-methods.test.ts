import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { ProblemSchema } from "../public-api/contracts.js";
import { readRunProgressSettings } from "../run-progress/settings.js";
import { RunStream } from "../run-stream/index.js";
import { beginHttpShutdown, createFetchServer } from "./node-server.js";

interface HttpReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const runId = "00000000-0000-4000-8000-000000000123";
const path = `/api/v1/runs/${runId}/events`;
let server: Server;
let port: number;
const authorize = vi.fn(async () => ({ status: "unauthorized" as const }));
let service: RunStream;
const route = vi.fn((incoming: Request) => service.handle(incoming, runId));

beforeEach(async () => {
  service = new RunStream({
    database: null,
    auth: null,
    bus: undefined,
    reconciler: undefined,
    credentials: { authorize, reauthorize: async () => false },
    settings: readRunProgressSettings({
      PASEO_HUB_RUN_TIMELINE: "true",
      PASEO_HUB_RUN_STREAM: "true",
    }),
  });
  server = createFetchServer(route, { logger: { warn: () => undefined, error: () => undefined } });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
});
afterEach(async () => {
  try {
    await service.beginShutdown();
    assert.equal(service.activeStreamCount(), 0);
    assert.equal(service.notifierCount(), 0);
    assert.equal(beginHttpShutdown(server).activeRequests, 0);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    await closed.promise;
    vi.clearAllMocks();
  }
});

async function send(method: string, requestId: string): Promise<HttpReply> {
  const completed = Promise.withResolvers<HttpReply>();
  const client = request(
    {
      host: "127.0.0.1",
      port,
      path,
      method,
      agent: false,
      headers: { accept: "application/json", "x-request-id": requestId, connection: "close" },
    },
    (incoming) => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk: string) => {
        body += chunk;
      });
      incoming.once("error", completed.reject);
      incoming.once("end", () =>
        completed.resolve({ status: incoming.statusCode!, headers: incoming.headers, body }),
      );
    },
  );
  client.once("error", completed.reject);
  client.end();
  try {
    return await completed.promise;
  } finally {
    client.destroy();
  }
}

describe("Fetch transport method boundary", () => {
  it("rejects raw TRACE before route or authentication with a correlated generic problem", async () => {
    const response = await send("TRACE", "raw-trace");
    const problem = ProblemSchema.parse(JSON.parse(response.body));
    assert.equal(response.status, 405);
    assert.equal(response.headers["content-type"], "application/problem+json");
    assert.equal(response.headers["allow"], "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    assert.equal(problem.code, "method_not_allowed");
    assert.equal(problem.requestId, "raw-trace");
    assert.equal(response.headers["x-request-id"], problem.requestId);
    assert.equal(route.mock.calls.length, 0);
    assert.equal(authorize.mock.calls.length, 0);
  });

  it("replaces invalid TRACE request identifiers consistently", async () => {
    const response = await send("TRACE", "invalid id!");
    const problem = ProblemSchema.parse(JSON.parse(response.body));
    assert.equal(response.status, 405);
    assert.match(problem.requestId, /^[0-9a-f-]{36}$/u);
    assert.equal(response.headers["x-request-id"], problem.requestId);
    assert.equal(route.mock.calls.length, 0);
    assert.equal(authorize.mock.calls.length, 0);
  });

  it("passes PROPFIND through Fetch to the route-specific method contract", async () => {
    const response = await send("PROPFIND", "custom-method");
    const problem = ProblemSchema.parse(JSON.parse(response.body));
    assert.equal(response.status, 405);
    assert.equal(response.headers["allow"], "GET");
    assert.equal(problem.code, "method_not_allowed");
    assert.equal(problem.requestId, "custom-method");
    assert.equal(route.mock.calls.length, 1);
    assert.equal(route.mock.calls[0]![0].method, "PROPFIND");
    assert.equal(authorize.mock.calls.length, 0);
  });

  it("preserves Node's unhandled CONNECT socket closure without entering routes", async () => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    const closed = once(socket, "close");
    try {
      socket.write("CONNECT fixture.example:443 HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await closed;
      assert.equal(received, "");
      assert.equal(route.mock.calls.length, 0);
      assert.equal(authorize.mock.calls.length, 0);
    } finally {
      socket.destroy();
    }
  });
});
