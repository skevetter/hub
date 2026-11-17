import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { it } from "vitest";
import { createPublicApi } from "../public-api/index.js";
import type { PublicOperations } from "../public-operations/index.js";
import { beginHttpShutdown, createFetchServer } from "./node-server.js";

it("rejects webhook POST after HTTP shutdown begins before authentication or operations", async () => {
  let authCalls = 0;
  let operationCalls = 0;
  const unexpected = (): Promise<never> => {
    operationCalls += 1;
    return Promise.reject(new Error("operation admitted during shutdown"));
  };
  const operations: PublicOperations = {
    listTriggers: unexpected,
    validateTrigger: unexpected,
    installTrigger: unexpected,
    listProjects: unexpected,
    listConfigurationResources: unexpected,
    listSetupResources: unexpected,
    validateConfiguration: unexpected,
    installConfiguration: unexpected,
    dispatchManualRun: unexpected,
    receiveWebhook: unexpected,
    issueEnrollmentToken: unexpected,
  };
  const api = createPublicApi(
    {
      status: "enabled",
      authenticator: {
        reauthorize: async () => false,
        authorize: async () => {
          authCalls += 1;
          return { status: "unauthorized" };
        },
      },
    },
    operations,
  );
  const server = createFetchServer((incoming) => api.handle(incoming));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const shutdown = beginHttpShutdown(server);
    const { promise, resolve, reject } = Promise.withResolvers<{
      status: number | undefined;
      retryAfter: string | undefined;
    }>();
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/api/v1/hooks/build",
        headers: { "content-type": "application/json", authorization: "Bearer never-read" },
        agent: false,
      },
      (incoming) => {
        incoming.on("error", reject);
        incoming.resume();
        incoming.on("end", () =>
          resolve({ status: incoming.statusCode, retryAfter: incoming.headers["retry-after"] }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end('{"message":"never-dispatched"}');
    const response = await promise;
    assert.equal(response.status, 503);
    assert.equal(response.retryAfter, "1");
    assert.equal(authCalls, 0);
    assert.equal(operationCalls, 0);
    assert.equal(shutdown.activeRequests, 0);
    await shutdown.drained;
  } finally {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});
