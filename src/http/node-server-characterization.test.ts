import { once } from "node:events";
import { request as send, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createFetchServer } from "./node-server.js";
import { registerResponseLifecycle } from "./response-lifecycle.js";

interface Case {
  size: number;
  lifecycle: boolean;
  events: boolean;
  status: number;
}

async function serve(server: Server, sendRequest: (port: number) => Promise<void>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    await sendRequest(address.port);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

function request(port: number, method: string, payload?: string) {
  return new Promise<{
    status: number | undefined;
    statusText: string | undefined;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const client = send(
      { host: "127.0.0.1", port, path: "/api/characterization", method, agent: false },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: response.headers,
            body,
          }),
        );
        response.once("error", reject);
      },
    );
    client.once("error", reject);
    client.end(payload);
  });
}

async function makeResponse(incoming: Request, options: Case, actions: string[]) {
  const requestBody = await incoming.text();
  actions.push(`${incoming.method}:${requestBody}`);
  const text = "x".repeat(options.size);
  const headers = new Headers({
    "content-type": options.events ? "text/event-stream" : "text/plain",
    "x-request-id": "characterization-id",
  });
  headers.append("set-cookie", "one=1");
  headers.append("set-cookie", "two=2");
  const response = new Response(options.status === 204 ? null : text, {
    status: options.status,
    statusText: "Fixture",
    headers,
  });
  if (!options.lifecycle) return response;
  return registerResponseLifecycle(response, {
    onFinish() {
      actions.push("finish");
    },
    onAbort() {
      actions.push("abort");
    },
  });
}

function transportCase(options: Case) {
  it(`writes ${options.size} bytes with status ${options.status}, lifecycle ${options.lifecycle}, SSE ${options.events}`, async () => {
    const actions: string[] = [];
    const warnings: string[] = [];
    const server = createFetchServer((incoming) => makeResponse(incoming, options, actions), {
      logger: {
        warn: () => {
          warnings.push("warn");
        },
        error: () => {
          warnings.push("error");
        },
      },
    });
    await serve(server, async (port) => {
      const { status, statusText, body, headers } = await request(port, "POST", "fixture");
      expect({
        status,
        statusText,
        body,
        media: headers["content-type"],
        cookies: headers["set-cookie"],
        reference: headers["x-request-id"],
      }).toEqual({
        status: options.status,
        statusText: "Fixture",
        body: options.status === 204 ? "" : "x".repeat(options.size),
        media: options.events ? "text/event-stream" : "text/plain",
        cookies: ["one=1", "two=2"],
        reference: "characterization-id",
      });
      expect(actions).toEqual(options.lifecycle ? ["POST:fixture", "finish"] : ["POST:fixture"]);
      expect(warnings).toEqual(options.status === 429 ? ["error"] : []);
    });
  });
}

describe("Node HTTP forwarding", () => {
  for (const status of [200, 204, 429]) {
    for (const [lifecycle, events] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      for (const size of [0, 1, 4096, 65536]) transportCase({ size, lifecycle, events, status });
    }
  }

  it("returns a referenced JSON response when the handler rejects", async () => {
    const logs: unknown[] = [];
    const server = createFetchServer(
      () => {
        throw new Error("synthetic handler error");
      },
      {
        logger: {
          warn: () => undefined,
          error: () => {
            logs.push("error");
          },
        },
      },
    );
    await serve(server, async (port) => {
      const response = await request(port, "GET");
      const reference = response.headers["x-request-id"];
      expect({
        status: response.status,
        contentType: response.headers["content-type"],
        body: response.body.replace(String(reference), "<reference>"),
        hasReference: typeof reference === "string" && reference.length > 0,
        logged: logs.length,
      }).toEqual({
        status: 500,
        contentType: "application/json; charset=utf-8",
        body: '{"error":"internal_error","message":"Hub couldn\'t complete this API request.","requestId":"<reference>"}',
        hasReference: true,
        logged: 1,
      });
    });
  });
});
