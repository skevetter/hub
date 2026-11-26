import assert from "node:assert/strict";
import { ProblemSchema } from "../public-api/contracts.js";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import type { RunStream } from "./index.js";
import {
  createStreamHarness,
  ORGANIZATION,
  StreamReader,
  streamRequest,
  type StreamHarness,
} from "./test-utils.js";

for (const backend of ["memory", "embedded", "pooled"] as const) {
  describe(`run event delivery on ${backend}`, () => {
    let harness: StreamHarness;
    const services: RunStream[] = [];
    beforeAll(async () => {
      harness = await createStreamHarness(backend);
    }, 120_000);
    afterAll(async () => {
      await harness?.close();
    }, 120_000);
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      for (const service of services.splice(0)) {
        await service.beginShutdown();
        assert.equal(service.activeStreamCount(), 0);
        assert.equal(service.notifierCount(), 0);
      }
    });
    const stream = () => {
      const service = harness.stream();
      services.push(service);
      return service;
    };

    it("frames stored rows, reconciles a terminal run and ends only after the persisted seal", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const service = stream();
      const response = await service.handle(streamRequest(run.id, harness.key), run.id);
      assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
      assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
      assert.equal(response.headers.get("x-accel-buffering"), "no");
      for (const header of [
        "content-length",
        "connection",
        "access-control-allow-origin",
        "access-control-allow-credentials",
      ])
        assert.equal(response.headers.has(header), false);
      const reader = new StreamReader(response);
      assert.equal(await reader.frame(), "retry: 5000");
      assert.equal(await reader.frame(), ": stream open");
      const status = await reader.event("status");
      assert.equal(status.frame.startsWith("id:"), false);
      assert.equal(status.data["origin"], "captured");
      const text = await reader.all();
      const state = await harness.database.readRunTimelineState(ORGANIZATION, run.id);
      assert.ok(state?.sealedSeq);
      const stored = await harness.database.listRunTimelineEvents(ORGANIZATION, run.id, {
        afterSeq: 0,
        limit: 100,
      });
      for (const row of stored)
        assert.ok(
          text.includes(
            `id: ${row.seq}\nevent: ${row.kind}\ndata: ${JSON.stringify({ seq: row.seq, kind: row.kind, at: row.at, stepId: row.stepId, data: row.data })}\n\n`,
          ),
        );
      assert.ok(text.indexOf(`id: ${state.sealedSeq}\n`) < text.indexOf("event: end\n"));
      assert.ok(text.includes(`"sealedSeq":${state.sealedSeq}`));
      assert.equal(service.activeStreamCount(), 0);
      assert.equal(service.notifierCount(), 0);
    });

    it("recovers a failed terminal append before sending end", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const append = harness.database.appendRunTimelineEvent.bind(harness.database);
      let failed = false;
      vi.spyOn(harness.database, "appendRunTimelineEvent").mockImplementation(async (input) => {
        if (input.kind === "run_finished" && !failed) {
          failed = true;
          throw new Error("Synthetic append failure");
        }
        return append(input);
      });
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key), run.id),
      );
      const end = await reader.event("end");
      assert.equal(failed, true);
      assert.ok(end.data["sealedSeq"]);
      assert.ok(reader.text.indexOf("event: run_finished\n") < reader.text.indexOf("event: end\n"));
      await reader.all();
      assert.equal(service.activeStreamCount(), 0);
    });

    it("keeps a terminal stream open while sealing fails and wakes it after recovery", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const append = harness.database.appendRunTimelineEvent.bind(harness.database);
      let blocked = true;
      vi.spyOn(harness.database, "appendRunTimelineEvent").mockImplementation((input) => {
        if (input.kind === "run_finished" && blocked)
          return Promise.reject(new Error("Synthetic seal outage"));
        return append(input);
      });
      const waiting = Promise.withResolvers<void>();
      const list = harness.database.listRunTimelineEvents.bind(harness.database);
      vi.spyOn(harness.database, "listRunTimelineEvents").mockImplementation(async (...args) => {
        const rows = await list(...args);
        if (args[1] === run.id && args[2].limit === 100 && rows.length === 0) waiting.resolve();
        return rows;
      });
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key), run.id),
      );
      assert.equal((await reader.event("status")).data["sealedSeq"], null);
      let ended = false;
      const ending = reader.event("end").then((event) => {
        ended = true;
        return event;
      });
      await waiting.promise;
      await setImmediate();
      assert.equal(ended, false);
      assert.equal(service.activeStreamCount(), 1);
      assert.equal(
        (await harness.database.readRunTimelineState(ORGANIZATION, run.id))?.sealedSeq,
        null,
      );
      blocked = false;
      harness.bus.publish(run.id, 1);
      assert.ok((await ending).data["sealedSeq"]);
      await reader.all();
      assert.ok(reader.text.indexOf("event: run_finished\n") < reader.text.indexOf("event: end\n"));
      assert.equal(service.activeStreamCount(), 0);
    });

    it("stores and reports derived provenance without inventing tool events", async () => {
      const run = await harness.createRun();
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key), run.id),
      );
      assert.equal((await reader.event("status")).data["origin"], "derived");
      const text = await reader.all();
      assert.ok(text.includes("event: run_finished\n"));
      assert.equal(text.includes("event: tool_"), false);
    });

    if (backend !== "memory") {
      it("reports the first retained sequence and replays from it for an older cursor", async () => {
        const run = await harness.createRun();
        for (let index = 0; index < 3; index++) await harness.append(run.id);
        await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
        await harness.reconciler.reconcile(ORGANIZATION, run.id);
        await harness.runtime!.query(
          "delete from run_timeline_events where trigger_run_id = $1 and seq < 3",
          [run.id],
        );
        const reader = new StreamReader(
          await stream().handle(streamRequest(run.id, harness.key, { query: "?after=0" }), run.id),
        );
        assert.equal((await reader.event("status")).data["firstSeq"], 3);
        const text = await reader.all();
        assert.equal(Number(/^id: ([0-9]+)$/mu.exec(text)?.[1]), 3);
        assert.ok(text.includes("event: end\n"));
      });
    }

    it.each([
      ["", { "last-event-id": "1" }, 2],
      ["?after=2", {}, 3],
      ["?after=1", { "last-event-id": "2" }, 2],
      ["?after=0", {}, 1],
    ] as const)("replays the selected cursor %s %j", async (query, headers, first) => {
      const run = await harness.createRun();
      await harness.append(run.id);
      await harness.append(run.id);
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key, { query, headers }), run.id),
      );
      const text = await reader.all();
      assert.equal(Number(/^id: ([0-9]+)$/mu.exec(text)?.[1]), first);
      const ids = [...text.matchAll(/^id: ([0-9]+)$/gmu)].map((match) => Number(match[1]));
      assert.deepEqual(ids, [...new Set(ids)]);
      assert.ok(text.includes("event: end\n"));
    });

    it("waits beyond the latest cursor and resumes only after it", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key, { query: "?after=3" }), run.id),
      );
      await reader.event("status");
      for (let index = 0; index < 3; index++) await harness.append(run.id);
      harness.bus.publish(run.id, 4);
      const row = await reader.event("turn_started");
      assert.ok(row.frame.startsWith("id: 4\n"));
      await reader.cancel();
      assert.equal(service.activeStreamCount(), 0);
      assert.equal(service.notifierCount(), 0);
    });

    it("delivers silent writes through polling, then reconciles a run that finishes while open", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key), run.id),
      );
      await reader.event("turn_started");
      await harness.append(run.id, "turn_ended");
      const row = await reader.event("turn_ended");
      assert.ok(row.frame.startsWith("id: 2\n"));
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const text = await reader.all();
      assert.ok(text.includes("event: run_finished\n"));
      assert.ok(text.includes("event: end\n"));
      assert.equal(service.activeStreamCount(), 0);
    });

    it("does not lose or duplicate a wake between replay and waiting", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      const list = harness.database.listRunTimelineEvents.bind(harness.database);
      let injected = false;
      vi.spyOn(harness.database, "listRunTimelineEvents").mockImplementation(
        async (organizationId, id, page) => {
          const rows = await list(organizationId, id, page);
          if (id === run.id && page.limit === 100 && !injected) {
            injected = true;
            await harness.append(run.id, "turn_ended");
            harness.bus.publish(run.id, 2);
          }
          return rows;
        },
      );
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key), run.id),
      );
      await reader.event("turn_ended");
      assert.deepEqual(
        [...reader.text.matchAll(/^id: ([0-9]+)$/gmu)].map((match) => Number(match[1])),
        [1, 2],
      );
      await reader.cancel();
      assert.equal(service.notifierCount(), 0);
    });

    it("replays multiple pages while writes race the initial connection", async () => {
      const run = await harness.createRun();
      const service = stream();
      const response = service.handle(streamRequest(run.id, harness.key), run.id);
      const writer = (async () => {
        for (let index = 0; index < 205; index++) {
          const seq = await harness.append(run.id);
          harness.bus.publish(run.id, seq);
        }
        const seq = await harness.append(run.id, "turn_ended");
        harness.bus.publish(run.id, seq);
      })();
      const reader = new StreamReader(await response);
      await reader.event("turn_ended");
      await writer;
      const ids = [...reader.text.matchAll(/^id: ([0-9]+)$/gmu)].map((match) => Number(match[1]));
      assert.deepEqual(
        ids,
        Array.from({ length: 206 }, (_, index) => index + 1),
      );
      await reader.cancel();
    });

    it("rejects an unswept timeline outside the retention window without reconstructing it", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const reconcile = vi.spyOn(harness.reconciler, "reconcileBeforeTerminal");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31 * 86400000);
      const service = stream();
      const response = await service.handle(streamRequest(run.id, harness.key), run.id);
      assert.equal(response.status, 410);
      assert.equal(ProblemSchema.parse(await response.json()).code, "timeline_expired");
      assert.equal(reconcile.mock.calls.length, 0);
      assert.equal(
        (await harness.database.readRunTimelineState(ORGANIZATION, run.id))?.expiredAt,
        null,
      );
    });

    it("returns run_not_found for a rejected invocation with no timeline", async () => {
      const source = await harness.createRun();
      const rejected = await harness.database.createRejectedTriggerRun({
        organizationId: ORGANIZATION,
        projectId: source.projectId,
        configurationRevisionId: source.configurationRevisionId,
        providerEventReceiptId: source.providerEventReceiptId,
        configuredTriggerName: "rejected-stream",
        prompt: "",
        inputs: {},
        triggerContext: {},
        outputContext: {},
        rejection: { code: "missing_required", inputName: "fixture" },
      });
      const response = await stream().handle(
        streamRequest(rejected.run.id, harness.key),
        rejected.run.id,
      );
      assert.equal(response.status, 404);
      assert.equal(ProblemSchema.parse(await response.json()).code, "run_not_found");
    });

    it("refuses expired and tombstoned timelines before reconciling even with longer retention", async () => {
      const run = await harness.createRun();
      await harness.append(run.id);
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      await harness.database.expireRunTimelines(new Date(Date.now() + 86400000), 500);
      const reconcile = vi.spyOn(harness.reconciler, "reconcileBeforeTerminal");
      const service = harness.stream({ retentionDays: 365 });
      services.push(service);
      const response = await service.handle(streamRequest(run.id, harness.key), run.id);
      assert.equal(response.status, 410);
      assert.equal(ProblemSchema.parse(await response.json()).code, "timeline_expired");
      assert.equal(reconcile.mock.calls.length, 0);
      assert.deepEqual(
        await harness.database.listRunTimelineEvents(ORGANIZATION, run.id, {
          afterSeq: 0,
          limit: 100,
        }),
        [],
      );
    });

    it("bounds unread replay pages and releases a canceled subscriber", async () => {
      const run = await harness.createRun();
      for (let index = 0; index < 400; index++) await harness.append(run.id);
      const list = vi.spyOn(harness.database, "listRunTimelineEvents");
      const service = stream();
      const response = await service.handle(streamRequest(run.id, harness.key), run.id);
      for (let index = 0; index < 20; index++) await setImmediate();
      const pages = list.mock.calls.filter(([, id, page]) => id === run.id && page.limit === 100);
      assert.ok(pages.length > 0 && pages.length < 4, `Unread replay read ${pages.length} pages`);
      assert.ok(list.mock.calls.every(([, , page]) => page.limit <= 100));
      await response.body!.cancel();
      assert.equal(service.activeStreamCount(), 0);
      assert.equal(service.notifierCount(), 0);
    });

    it("streams capture-projected fields without exposing known credentials or raw agent payload", async () => {
      const run = await harness.createRun();
      const step = (await harness.database.listWorkflowStepRunsForTriggerRun(run.id))[0]!;
      const execution = await harness.database.insertAgentExecution({
        organizationId: ORGANIZATION,
        projectId: run.projectId,
        machineId: null,
        configurationRevisionId: run.configurationRevisionId,
        workflowStepRunId: step.id,
        triggerContext: {},
        outputContext: {},
      });
      await harness.database.linkWorkflowStepRunExecution(step.id, execution.id);
      harness.timeline.begin(execution.id);
      harness.timeline.observeAgentEvent(
        execution.id,
        {
          type: "turn_failed",
          provider: "claude",
          error: "PASSWORD=synthetic-known-private-value",
        },
        new Date(),
      );
      harness.timeline.observeAgentEvent(
        execution.id,
        {
          type: "timeline",
          provider: "claude",
          item: {
            type: "tool_call",
            name: "Bash",
            status: "completed",
            callId: "synthetic-call",
            input: "raw-private-payload",
            text: "raw-private-payload",
          },
        },
        new Date(),
      );
      await harness.timeline.flush();
      harness.timeline.release(execution.id);
      await harness.database.failWorkflowRun(run.id, "failed", "agent_execution_failed");
      const service = stream();
      const reader = new StreamReader(
        await service.handle(streamRequest(run.id, harness.key), run.id),
      );
      const text = await reader.all();
      assert.equal(text.includes("synthetic-known-private-value"), false);
      assert.ok(text.includes("[redacted]"));
      assert.equal(text.includes('"organizationId"'), false);
      assert.equal(text.includes('"triggerRunId"'), false);
      assert.equal(text.includes("raw-private-payload"), false);
    });
  });
}
