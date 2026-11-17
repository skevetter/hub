import assert from "node:assert/strict";
import { once } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { createFetchServer } from "../http/node-server.js";
import { ProblemSchema } from "../public-api/contracts.js";
import type { ApplicationRuntime } from "../server/runtime.js";
import { createStreamHarness, settings, StreamReader, type StreamHarness } from "./test-utils.js";
import {
  loadCompiledStreamRuntime,
  type CompiledStreamRuntime,
} from "./test-utils/compiled-runtime.js";

const nonGetMethods = ["HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND"] as const;

for (const enabled of [true, false]) {
  describe(`compiled stream methods with streaming ${enabled ? "enabled" : "disabled"}`, () => {
    let compiled: CompiledStreamRuntime;
    let harness: StreamHarness;
    let application: ApplicationRuntime;
    let server: Server;
    let url: string;
    const closingResponses = new Set<Promise<void>>();
    const clients = new Set<AbortController>();
    function send(method: string, requestId: string): Promise<Response> {
      const controller = new AbortController();
      clients.add(controller);
      return fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${harness.key}`,
          accept: "application/json",
          "x-request-id": requestId,
        },
      });
    }
    function trackResponse(_request: IncomingMessage, outgoing: ServerResponse): void {
      const closed = Promise.withResolvers<void>();
      closingResponses.add(closed.promise);
      outgoing.once("close", () => {
        closingResponses.delete(closed.promise);
        closed.resolve();
      });
    }
    beforeAll(async () => {
      compiled = await loadCompiledStreamRuntime();
      harness = await createStreamHarness("embedded");
      application = await compiled.build.startApplication(() =>
        compiled.createApplicationRuntime({
          database: harness.database,
          auth: harness.auth,
          entitlements: createUnlimitedEntitlementsService(),
          billing: null,
          runProgress: { ...settings, runStreamEnabled: enabled },
          close: async () => undefined,
        }),
      );
      const run = await harness.createRun();
      server = createFetchServer((request) => compiled.build.default.fetch(request), {
        logger: { warn: () => undefined, error: () => undefined },
      });
      server.on("request", trackResponse);
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      url = `http://127.0.0.1:${address.port}/api/v1/runs/${run.id}/events`;
    }, 120_000);
    afterEach(async () => {
      for (const controller of clients) controller.abort();
      clients.clear();
      await Promise.all(closingResponses);
      await setImmediate();
      assert.equal(application.runStream.activeStreamCount(), 0);
      assert.equal(application.runStream.notifierCount(), 0);
    });
    afterAll(async () => {
      try {
        await compiled?.build.beginShutdown();
        if (server?.listening) {
          const closed = Promise.withResolvers<void>();
          server.close(() => closed.resolve());
          server.closeAllConnections();
          await closed.promise;
        }
        await compiled?.build.stopProductionRuntime();
        await harness?.close();
      } finally {
        await compiled?.remove();
      }
    }, 120_000);

    it.each(nonGetMethods)(
      "rejects %s with a correlated API problem without admission",
      async (method) => {
        const requestId = `stream-method-${method.toLowerCase()}`;
        const response = await send(method, requestId);
        assert.equal(response.status, enabled ? 405 : 404);
        assert.equal(response.headers.get("allow"), enabled ? "GET" : null);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
        assert.equal(response.headers.get("x-request-id"), requestId);
        assert.equal(response.headers.has("access-control-allow-origin"), false);
        if (method === "HEAD") assert.equal(response.body, null);
        else {
          const body = ProblemSchema.parse(await response.json());
          assert.equal(body.code, enabled ? "method_not_allowed" : "not_found");
          assert.equal(body.requestId, requestId);
        }
        assert.equal(application.runStream.activeStreamCount(), 0);
        assert.equal(application.runStream.notifierCount(), 0);
      },
    );

    if (enabled) {
      it("keeps admission free after five sequential HEAD requests and accepts the following GET", async () => {
        for (let index = 0; index < 5; index++) {
          const response = await send("HEAD", `head-${index}`);
          assert.equal(response.status, 405);
          assert.equal(response.headers.get("allow"), "GET");
          assert.equal(response.body, null);
          assert.equal(application.runStream.activeStreamCount(), 0);
          assert.equal(application.runStream.notifierCount(), 0);
        }
        const response = await send("GET", "following-get");
        const reader = new StreamReader(response);
        await reader.event("status");
        assert.equal(application.runStream.activeStreamCount(), 1);
        await reader.cancel();
      });
    } else {
      it("keeps GET disabled with the same not_found problem", async () => {
        const response = await send("GET", "disabled-get");
        assert.equal(response.status, 404);
        assert.equal(ProblemSchema.parse(await response.json()).code, "not_found");
      });
    }
  });
}
