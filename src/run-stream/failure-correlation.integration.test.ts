import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { createApplicationRuntime } from "../application-runtime.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { beginHttpShutdown, createFetchServer } from "../http/node-server.js";
import { createLogger } from "../logger.js";
import { ProblemSchema } from "../public-api/contracts.js";
import type { ApplicationRuntime } from "../server/runtime.js";
import { FailureLogStream } from "../test-utils/failure-logs.js";
import { createStreamHarness, settings, type StreamHarness } from "./test-utils.js";

let harness: StreamHarness;
let application: ApplicationRuntime;
let server: Server;
let baseUrl: string;
let sink: FailureLogStream;

beforeAll(async () => {
  harness = await createStreamHarness("embedded");
  application = await createApplicationRuntime({
    database: harness.database,
    auth: harness.auth,
    entitlements: createUnlimitedEntitlementsService(),
    billing: null,
    runProgress: settings,
    close: async () => undefined,
  });
}, 120_000);
afterEach(async () => {
  vi.restoreAllMocks();
  if (server?.listening) {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    server.closeAllConnections();
    await closed.promise;
  }
  assert.equal(application.runStream.activeStreamCount(), 0);
  assert.equal(application.runStream.notifierCount(), 0);
});
afterAll(async () => {
  await application?.stop();
  await harness?.close();
}, 120_000);

describe("stream storage failure correlation", () => {
  it.each(["storage-probe", "invalid id!"])(
    "shares one request id in body, header and failure record for %j",
    async (requestId) => {
      const run = await harness.createRun();
      sink = new FailureLogStream();
      server = createFetchServer((request) => application.runStream.handle(request, run.id), {
        logger: createLogger(sink),
      });
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      baseUrl = `http://127.0.0.1:${address.port}`;
      vi.spyOn(harness.database, "readRunTimelineState").mockImplementation(async () => {
        throw new Error("synthetic storage rejection");
      });
      const response = await fetch(`${baseUrl}/api/v1/runs/${run.id}/events`, {
        headers: { authorization: `Bearer ${harness.key}`, "x-request-id": requestId },
      });
      const problem = ProblemSchema.parse(await response.json());
      await setImmediate();
      assert.equal(response.status, 503);
      assert.equal(problem.code, "infrastructure_unavailable");
      assert.equal(response.headers.get("x-request-id"), problem.requestId);
      if (requestId === "storage-probe") assert.equal(problem.requestId, requestId);
      else assert.match(problem.requestId, /^[0-9a-f-]{36}$/u);
      const records = sink.records();
      assert.equal(records.length, 1);
      assert.equal(records[0]!["operation"], "run.stream.handle");
      assert.equal(records[0]!["requestId"], problem.requestId);
      assert.equal(beginHttpShutdown(server).activeRequests, 0);
      assert.equal(application.hub.resourceCounts().runStreams, 0);
      assert.equal(application.hub.resourceCounts().streamNotifiers, 0);
    },
  );
});
