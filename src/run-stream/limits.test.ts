import assert from "node:assert/strict";
import { ProblemSchema } from "../public-api/contracts.js";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { OperationAuthenticator } from "../auth/operation-auth.js";
import {
  createStreamHarness,
  access,
  StreamReader,
  streamRequest,
  type StreamHarness,
} from "./test-utils.js";

let harness: StreamHarness;
beforeEach(async () => {
  harness = await createStreamHarness("memory");
});
afterEach(async () => {
  try {
    await harness?.close();
    if (vi.isFakeTimers()) assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

const credentials: OperationAuthenticator = {
  authorize: async (request) => ({
    status: "authorized",
    access: {
      ...access,
      kind: request.headers.get("authorization")?.includes("cli") ? "cliCredential" : "apiKey",
      credentialId: request.headers.get("authorization") ?? "key",
    },
  }),
  reauthorize: async () => true,
};

describe("stream admission and timers", () => {
  it.each([
    ["credential", { streamMaxPerKey: 1 }, ["same", "same"]],
    ["organization", { streamMaxPerKey: 10, streamMaxPerOrg: 1 }, ["first", "second"]],
    [
      "process",
      { streamMaxPerKey: 10, streamMaxPerOrg: 10, streamMaxTotal: 1 },
      ["first", "second"],
    ],
  ] as const)(
    "enforces the %s limit and reclaims admission after cancel",
    async (_kind, settings, keys) => {
      const run = await harness.createRun();
      const service = harness.stream(settings, credentials);
      const first = await service.handle(streamRequest(run.id, keys[0]), run.id);
      assert.equal(first.status, 200);
      const second = await service.handle(streamRequest(run.id, keys[1]), run.id);
      assert.equal(second.status, 429);
      assert.equal(second.headers.get("retry-after"), "30");
      assert.equal(ProblemSchema.parse(await second.json()).code, "too_many_streams");
      assert.equal(service.activeStreamCount(), 1);
      await first.body!.cancel();
      assert.equal(service.activeStreamCount(), 0);
      assert.equal(service.notifierCount(), 0);
      const next = await service.handle(streamRequest(run.id, keys[1]), run.id);
      assert.equal(next.status, 200);
      await next.body!.cancel();
      assert.equal(service.activeStreamCount(), 0);
    },
  );

  it("atomically admits concurrent requests and shares one reference-counted notifier", async () => {
    const run = await harness.createRun();
    let subscriptions = 0;
    const subscribe = harness.bus.subscribe.bind(harness.bus);
    vi.spyOn(harness.bus, "subscribe").mockImplementation((...args) => {
      subscriptions += 1;
      const unsubscribe = subscribe(...args);
      return () => {
        subscriptions -= 1;
        unsubscribe();
      };
    });
    const service = harness.stream({ streamMaxPerKey: 5 });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => service.handle(streamRequest(run.id), run.id)),
    );
    const admitted = responses.filter((response) => response.status === 200);
    assert.equal(admitted.length, 5);
    assert.equal(responses.filter((response) => response.status === 429).length, 45);
    assert.equal(service.activeStreamCount(), 5);
    assert.equal(service.notifierCount(), 1);
    assert.equal(subscriptions, 1);
    await admitted[0]!.body!.cancel();
    assert.equal(service.notifierCount(), 1);
    await Promise.all(admitted.slice(1).map((response) => response.body!.cancel()));
    assert.equal(service.activeStreamCount(), 0);
    assert.equal(service.notifierCount(), 0);
    assert.equal(subscriptions, 0);
  });

  it.each(["-1", "1.5", "1e2", "NaN", "", " 1", "1 2", "9007199254740992", "1\n2", "1,2"])(
    "rejects invalid query and header cursor %j",
    async (cursor) => {
      const run = await harness.createRun();
      const service = harness.stream();
      for (const request of [
        streamRequest(run.id, harness.key, { query: `?after=${encodeURIComponent(cursor)}` }),
        ...(cursor.includes("\n") || cursor.trim() !== cursor
          ? []
          : [streamRequest(run.id, harness.key, { headers: { "last-event-id": cursor } })]),
      ]) {
        const response = await service.handle(request, run.id);
        assert.equal(response.status, 400);
        assert.equal(ProblemSchema.parse(await response.json()).code, "invalid_request");
        assert.equal(service.activeStreamCount(), 0);
        assert.equal(service.notifierCount(), 0);
      }
    },
  );

  it("lets an explicit valid query override an invalid reconnect header", async () => {
    const run = await harness.createRun();
    const service = harness.stream();
    const response = await service.handle(
      streamRequest(run.id, harness.key, {
        query: "?after=0",
        headers: { "last-event-id": "invalid" },
      }),
      run.id,
    );
    assert.equal(response.status, 200);
    await response.body!.cancel();
  });

  it("emits heartbeat comments and reconnects at maximum age without assigning control ids", async () => {
    vi.useFakeTimers();
    const run = await harness.createRun();
    const service = harness.stream({ streamHeartbeatSeconds: 5, streamMaxSeconds: 60 });
    const reader = new StreamReader(await service.handle(streamRequest(run.id), run.id));
    await reader.event("status");
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(await reader.frame(), ": ping");
    await vi.advanceTimersByTimeAsync(55_000);
    const reconnect = await reader.event("reconnect");
    assert.deepEqual(reconnect.data, { reconnectMs: 5000 });
    assert.equal(reconnect.frame.startsWith("id:"), false);
    await reader.all();
    assert.equal(service.activeStreamCount(), 0);
    assert.equal(service.notifierCount(), 0);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("cancels an aborted request during an outstanding store read without holding admission", async () => {
    const run = await harness.createRun();
    const service = harness.stream();
    const controller = new AbortController();
    const response = await service.handle(
      streamRequest(run.id, harness.key, { signal: controller.signal }),
      run.id,
    );
    const original = harness.database.findTriggerRunForOrganization.bind(harness.database);
    const gate = Promise.withResolvers<void>();
    vi.spyOn(harness.database, "findTriggerRunForOrganization").mockImplementation(
      async (...args) => {
        await gate.promise;
        return original(...args);
      },
    );
    const reader = new StreamReader(response);
    await reader.event("status");
    controller.abort();
    await reader.all();
    assert.equal(service.activeStreamCount(), 0);
    assert.equal(service.notifierCount(), 0);
    gate.resolve();
    await setImmediate();
  });

  it("fails closed on a reauthorization error and releases all clocks", async () => {
    vi.useFakeTimers();
    const run = await harness.createRun();
    const service = harness.stream(
      {},
      {
        ...credentials,
        reauthorize: async () => {
          throw new Error("synthetic-private-value");
        },
      },
    );
    const reader = new StreamReader(await service.handle(streamRequest(run.id), run.id));
    await reader.event("status");
    await vi.advanceTimersByTimeAsync(60_000);
    assert.deepEqual((await reader.event("error")).data, { code: "unauthorized" });
    assert.equal((await reader.all()).includes("synthetic-private-value"), false);
    assert.equal(vi.getTimerCount(), 0);
  });

  it("returns a disabled-route 404 without authorizing or reading the run", async () => {
    const authorize = vi.spyOn(credentials, "authorize");
    const read = vi.spyOn(harness.database, "findTriggerRunForOrganization");
    const service = harness.stream({ runStreamEnabled: false }, credentials);
    const response = await service.handle(streamRequest("invalid"), "invalid");
    assert.equal(response.status, 404);
    assert.equal(ProblemSchema.parse(await response.json()).code, "not_found");
    assert.equal(authorize.mock.calls.length, 0);
    assert.equal(read.mock.calls.length, 0);
  });

  it("returns a problem without exposing infrastructure errors or leaving admission behind", async () => {
    const run = await harness.createRun();
    vi.spyOn(harness.database, "readRunTimelineState").mockRejectedValue(
      new Error("synthetic-private-value"),
    );
    const service = harness.stream();
    const response = await service.handle(streamRequest(run.id), run.id);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(ProblemSchema.parse(JSON.parse(text)).code, "infrastructure_unavailable");
    assert.equal(text.includes("synthetic-private-value"), false);
    assert.equal(service.activeStreamCount(), 0);
    assert.equal(service.notifierCount(), 0);
  });
});
