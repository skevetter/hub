import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { createApplicationRuntime } from "../application-runtime.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import { createFetchServer } from "../http/node-server.js";
import { loadBuiltStartServer, type BuiltStartServer } from "../server/build.js";
import type { ApplicationRuntime } from "../server/runtime.js";
import { createStreamHarness, settings, StreamReader, type StreamHarness } from "./test-utils.js";

async function runClient(command: string, args: string[], environment: Record<string, string>) {
  const child = spawn(command, args, {
    env: { PATH: process.env["PATH"], ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  const completion = Promise.withResolvers<number | null>();
  child.once("error", completion.reject);
  child.once("exit", completion.resolve);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    assert.equal(await completion.promise, 0, stderr);
    return stdout;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

describe("built run event route and documented clients", () => {
  let harness: StreamHarness;
  let build: BuiltStartServer;
  let application: ApplicationRuntime;
  let server: Server;
  let baseUrl: string;
  let beforeRequest: ((request: Request) => Promise<void>) | undefined;
  let truncateRunId: string | undefined;
  let cut = false;
  const closingResponses = new Set<Promise<void>>();
  function trackResponse(_request: IncomingMessage, outgoing: ServerResponse): void {
    const closed = Promise.withResolvers<void>();
    closingResponses.add(closed.promise);
    outgoing.once("close", () => {
      closingResponses.delete(closed.promise);
      closed.resolve();
    });
  }
  beforeAll(async () => {
    harness = await createStreamHarness("embedded");
    build = await loadBuiltStartServer();
    application = await build.startApplication(() =>
      createApplicationRuntime({
        database: harness.database,
        auth: harness.auth,
        entitlements: createUnlimitedEntitlementsService(),
        billing: null,
        runProgress: settings,
        close: async () => undefined,
      }),
    );
    server = createFetchServer(async (request) => {
      await beforeRequest?.(request);
      const response = await build.default.fetch(request);
      if (
        !cut &&
        truncateRunId !== undefined &&
        request.url.includes(truncateRunId) &&
        response.body !== null
      ) {
        cut = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                return;
              }
              controller.enqueue(chunk.value);
              if (/^id: [0-9]+$/mu.test(decoder.decode(chunk.value))) {
                await reader.cancel();
                controller.close();
              }
            },
            cancel: () => reader.cancel(),
          }),
          { headers: response.headers },
        );
      }
      return response;
    });
    server.on("request", trackResponse);
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);
  afterEach(async () => {
    beforeRequest = undefined;
    truncateRunId = undefined;
    cut = false;
    await Promise.all(closingResponses);
    await setImmediate();
    assert.equal(application.hub.resourceCounts().runStreams, 0);
    assert.equal(application.hub.resourceCounts().streamNotifiers, 0);
  });
  afterAll(async () => {
    if (build) await build.beginShutdown();
    if (server?.listening) {
      const done = Promise.withResolvers<void>();
      server.close(() => done.resolve());
      server.closeAllConnections();
      await done.promise;
    }
    await build?.stopProductionRuntime();
    await harness?.close();
  }, 120_000);

  it("serves the file route through the compiled router with actual runtime resource counts", async () => {
    const run = await harness.createRun();
    const abort = new AbortController();
    try {
      const response = await fetch(`${baseUrl}/api/v1/runs/${run.id}/events`, {
        headers: { authorization: `Bearer ${harness.key}` },
        signal: abort.signal,
      });
      const reader = new StreamReader(response);
      await reader.event("status");
      assert.equal(application.hub.resourceCounts().runStreams, 1);
      assert.equal(application.hub.resourceCounts().streamNotifiers, 1);
      await reader.cancel();
      abort.abort();
      await setImmediate();
    } finally {
      abort.abort();
    }
  });

  it("runs the documented curl command against a reconciled and sealed stored timeline", async () => {
    const run = await harness.createRun();
    await harness.append(run.id);
    await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
    const docs = await readFile(new URL("../../docs/public-api.md", import.meta.url), "utf8");
    const section = docs.split("## Run event streams")[1]!.split("## Workflow MCP tools")[0]!;
    const command = /```sh\n([\s\S]*?)\n```/u.exec(section)![1]!;
    const output = await runClient("bash", ["-c", command], {
      HUB_URL: baseUrl,
      RUN_ID: run.id,
      HUB_KEY: harness.key,
    });
    assert.ok(output.startsWith("retry: 5000\n\n: stream open\n\n"));
    assert.ok(output.includes("event: run_finished\n"));
    assert.ok(output.includes("event: end\n"));
  });

  it("runs the documented Node client and resumes with Last-Event-ID after a truncated connection", async () => {
    const run = await harness.createRun();
    await harness.append(run.id);
    truncateRunId = run.id;
    const cursors: (string | null)[] = [];
    beforeRequest = async (request) => {
      if (!request.url.includes(run.id)) return;
      cursors.push(request.headers.get("last-event-id"));
      if (cursors.length === 2) {
        await harness.append(run.id, "turn_ended");
        await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      }
    };
    const docs = await readFile(new URL("../../docs/public-api.md", import.meta.url), "utf8");
    const section = docs.split("## Run event streams")[1]!.split("## Workflow MCP tools")[0]!;
    const program = /```js\n([\s\S]*?)\n```/u.exec(section)![1]!;
    const output = await runClient(process.execPath, ["--input-type=module", "-e", program], {
      HUB_URL: baseUrl,
      RUN_ID: run.id,
      HUB_KEY: harness.key,
    });
    assert.deepEqual(cursors, [null, "1"]);
    const ids = [...output.matchAll(/^id: ([0-9]+)$/gmu)].map((match) => Number(match[1]));
    assert.deepEqual(ids, [...new Set(ids)]);
    assert.ok(output.includes("event: end\n"));
    assert.ok(output.includes("event: turn_ended\n"));
  });
});
