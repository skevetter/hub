import { describe, expect, it } from "vitest";
import { RunStream } from "./index.js";
import {
  createStreamHarness,
  ORGANIZATION,
  settings,
  StreamReader,
  streamRequest,
} from "./test-utils.js";

describe("run stream requests and event delivery", () => {
  it("keeps credential and browser refusals distinct and validates cursor precedence", async () => {
    const harness = await createStreamHarness("memory");
    try {
      const run = await harness.createRun();
      const stream = harness.stream();
      const url = `http://localhost/api/v1/runs/${run.id}/events`;
      const denied = [
        [new Request(url, { method: "POST" }), 405],
        [new Request(url), 401],
        [new Request(`${url}?organization=absent`, { headers: { cookie: "session=member" } }), 404],
        [streamRequest(run.id, "", { headers: { cookie: "session=member" } }), 401],
        [
          streamRequest(run.id, harness.key, {
            query: "?after=",
            headers: { "last-event-id": "0" },
          }),
          400,
        ],
        [
          streamRequest(run.id, harness.key, { headers: { "last-event-id": "9007199254740992" } }),
          400,
        ],
      ] as const;
      for (const [request, status] of denied) {
        expect((await stream.handle(request, run.id)).status).toBe(status);
      }
      const scoped = harness.stream(
        {},
        {
          authorize: async () => ({ status: "forbidden" }),
          reauthorize: async () => false,
        },
      );
      expect((await scoped.handle(streamRequest(run.id), run.id)).status).toBe(403);
      const allowed = await stream.handle(
        new Request(`${url}?organization=stream`, {
          headers: { cookie: "session=member", "last-event-id": "0" },
        }),
        run.id,
      );
      expect(allowed.status).toBe(200);
      await allowed.body?.cancel();
    } finally {
      await harness.close();
    }
  });

  it("shares a notifier, enforces stream counts and releases them on cancel and shutdown", async () => {
    const harness = await createStreamHarness("memory");
    const closed: unknown[] = [];
    const stream = new RunStream({
      database: harness.database,
      auth: harness.auth,
      credentials: harness.credentials,
      bus: harness.bus,
      reconciler: harness.reconciler,
      settings: { ...settings, streamMaxPerKey: 2 },
      logger: { info: (entry: unknown) => closed.push(entry) },
    });
    try {
      const run = await harness.createRun();
      const open = () => stream.handle(streamRequest(run.id), run.id);
      const first = new StreamReader(await open());
      const second = new StreamReader(await open());
      expect(stream.activeStreamCount()).toBe(2);
      expect(stream.notifierCount()).toBe(1);
      const rejected = await open();
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBe("30");
      await first.cancel();
      expect(stream.notifierCount()).toBe(1);
      await stream.beginShutdown();
      expect(await second.all()).toContain('event: shutdown\ndata: {"reconnectMs":5000}');
      expect(stream.activeStreamCount()).toBe(0);
      expect(stream.notifierCount()).toBe(0);
      expect(closed).toMatchObject([
        { reason: "abort", eventsSent: 0 },
        { reason: "shutdown", eventsSent: 0 },
      ]);
      expect((await open()).headers.get("retry-after")).toBe("5");
    } finally {
      await stream.beginShutdown();
      await harness.close();
    }
  });

  it("delivers prefetched rows in sequence and finishes after the terminal seal", async () => {
    const harness = await createStreamHarness("memory");
    try {
      const run = await harness.createRun();
      await harness.append(run.id);
      await harness.append(run.id, "turn_ended");
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const stream = harness.stream();
      const reader = new StreamReader(await stream.handle(streamRequest(run.id), run.id));
      const text = await reader.all();
      const state = await harness.database.readRunTimelineState(ORGANIZATION, run.id);
      expect(text).toContain("id: 1\nevent: turn_started");
      expect(text).toContain("id: 2\nevent: turn_ended");
      expect(text).toContain(`id: ${state?.sealedSeq}\nevent: run_finished`);
      expect(text).toContain(
        `event: end\ndata: {"status":"failed","lastSeq":${state?.eventCount},"sealedSeq":${state?.sealedSeq}`,
      );
      expect(stream.activeStreamCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("checks the run again before emitting prefetched content", async () => {
    const harness = await createStreamHarness("memory");
    try {
      const run = await harness.createRun();
      await harness.append(run.id);
      const stream = harness.stream();
      const reader = new StreamReader(await stream.handle(streamRequest(run.id), run.id));
      await reader.event("status");
      harness.database.findTriggerRunForOrganization = async () => undefined;
      const text = await reader.all();
      expect(text).toContain('event: error\ndata: {"code":"run_not_found"}');
      expect(text).not.toContain("event: turn_started");
      expect(stream.notifierCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
