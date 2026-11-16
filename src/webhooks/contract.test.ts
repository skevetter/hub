import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";
import { z } from "zod";
import { createFetchServer } from "../http/node-server.js";
import { webhookCurl, webhookUrl } from "./contract.js";

const execute = promisify(execFile);

describe("webhook copy examples", () => {
  it("uses the configured origin and encodes the trigger as one path segment", () => {
    assert.equal(
      webhookUrl("https://configured.example.test/prefix", "build-finished"),
      "https://configured.example.test/api/v1/hooks/build-finished",
    );
    assert.equal(
      webhookUrl("https://configured.example.test", "one/two"),
      "https://configured.example.test/api/v1/hooks/one%2Ftwo",
    );
  });

  it("sends shell metacharacters as unchanged JSON and keeps the key out of the copied command", async () => {
    const data = { message: "It's $(printf altered); `printf changed`", status: "failed" };
    const server = createFetchServer(async (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer fake-copy-test-key");
      assert.equal(request.headers.get("idempotency-key"), "example-delivery");
      assert.deepEqual(await request.json(), data);
      return Response.json({ received: true });
    });
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    server.off("error", listening.reject);
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    try {
      const command = webhookCurl(`http://127.0.0.1:${address.port}`, "build-finished", data);
      assert.ok(command.includes("$HUB_KEY"));
      assert.equal(command.includes("fake-copy-test-key"), false);
      const { stdout } = await execute("/bin/sh", ["-c", command], {
        env: { ...process.env, HUB_KEY: "fake-copy-test-key" },
        timeout: 10_000,
      });
      assert.equal(
        z.object({ received: z.literal(true) }).parse(JSON.parse(stdout)).received,
        true,
      );
    } finally {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error === undefined ? closed.resolve() : closed.reject(error)));
      await closed.promise;
    }
  });
});
