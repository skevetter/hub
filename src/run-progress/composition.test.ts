import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createApplicationRuntime } from "../application-runtime.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import type { ProviderRegistration } from "../providers/registration.js";
import { TimelineRetention } from "../run-timeline/retention.js";
import type { ApplicationRuntime } from "../server/runtime.js";
import { readRunProgressSettings } from "./settings.js";

describe("run progress composition", () => {
  it("passes retention days to the running sweeper even with the timeline off", async () => {
    vi.useFakeTimers();
    const database = createMemoryDatabase();
    const expire = vi.spyOn(database, "expireRunTimelines").mockResolvedValue(0);
    const earliest = Date.now() - 7 * 24 * 60 * 60_000;
    let runtime: ApplicationRuntime | undefined;
    try {
      runtime = await createApplicationRuntime({
        database,
        auth: null,
        entitlements: createUnlimitedEntitlementsService(),
        billing: null,
        runProgress: readRunProgressSettings({ PASEO_HUB_TIMELINE_RETENTION_DAYS: "7" }),
        close: async () => undefined,
      });
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(expire.mock.calls.length, 1);
      const [cutoff, batch] = expire.mock.calls[0]!;
      assert.ok(cutoff.getTime() >= earliest);
      assert.ok(cutoff.getTime() <= Date.now() - 7 * 24 * 60 * 60_000);
      assert.equal(batch, 500);
    } finally {
      await runtime?.stop();
      expire.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not write timeline or message rows for a run completed under default settings", async () => {
    const database = createMemoryDatabase();
    const runtime = await createApplicationRuntime({
      database,
      auth: null,
      entitlements: createUnlimitedEntitlementsService(),
      billing: null,
      close: async () => undefined,
    });
    try {
      const { run } = await database.createAcceptedTriggerRun({
        organizationId: "org",
        projectId: "project",
        configurationRevisionId: "revision",
        providerEventReceiptId: "receipt",
        configuredTriggerName: "manual",
        prompt: "run",
        inputs: {},
        triggerContext: {},
        outputContext: {},
        deadlineAt: new Date(Date.now() + 60_000),
        stepIds: [],
      });
      const finished = await database.succeedTriggerRun(run.id);
      assert.equal(finished?.run.status, "succeeded");
      assert.equal(finished?.transitioned, true);
      assert.deepEqual(
        await database.listRunTimelineEvents(run.organizationId, run.id, {
          afterSeq: 0,
          limit: 100,
        }),
        [],
      );
      assert.equal(await database.readRunTimelineState(run.organizationId, run.id), undefined);
      assert.equal(await database.findRunProgressMessage(run.organizationId, run.id), undefined);
    } finally {
      await runtime.stop();
    }
  });

  for (const explicitSettings of [false, true]) {
    it(`always starts retention with capture disabled and ${explicitSettings ? "explicit" : "default"} settings`, async () => {
      const events: string[] = [];
      const start = vi.spyOn(TimelineRetention.prototype, "start").mockImplementation(() => {
        events.push("retention:start");
      });
      const { promise, resolve } = Promise.withResolvers<void>();
      const stop = vi.spyOn(TimelineRetention.prototype, "stop").mockImplementation(async () => {
        events.push("retention:stop");
        await promise;
        events.push("retention:stopped");
      });
      let runtime: ApplicationRuntime | undefined;
      try {
        runtime = await createApplicationRuntime({
          database: createMemoryDatabase(),
          auth: null,
          entitlements: createUnlimitedEntitlementsService(),
          billing: null,
          registrations: [registration(events)],
          ...(explicitSettings ? { runProgress: readRunProgressSettings({}) } : {}),
          close: async () => {
            events.push("database:close");
          },
        });
        assert.equal(start.mock.calls.length, 1);
        assert.equal(stop.mock.calls.length, 0);
        assert.deepEqual(events, ["retention:start", "source:start"]);
        const stopping = runtime.stop();
        await vi.waitFor(() => assert.ok(events.includes("retention:stop")));
        assert.deepEqual(events, [
          "retention:start",
          "source:start",
          "source:stop",
          "retention:stop",
        ]);
        resolve();
        await stopping;
        await runtime.stop();
        assert.equal(stop.mock.calls.length, 1);
        assert.deepEqual(events.slice(-2), ["retention:stopped", "database:close"]);
      } finally {
        resolve();
        await runtime?.stop();
        start.mockRestore();
        stop.mockRestore();
      }
    });
  }

  it("stops retention before database ownership closes after startup fails", async () => {
    const events: string[] = [];
    const start = vi.spyOn(TimelineRetention.prototype, "start").mockImplementation(() => {
      events.push("retention:start");
    });
    const stop = vi.spyOn(TimelineRetention.prototype, "stop").mockImplementation(async () => {
      events.push("retention:stop");
    });
    try {
      await assert.rejects(
        () =>
          createApplicationRuntime({
            database: createMemoryDatabase(),
            auth: null,
            entitlements: createUnlimitedEntitlementsService(),
            billing: null,
            registrations: [registration(events), registration(events)],
            close: async () => {
              events.push("database:close");
            },
          }),
        /provider connection registrations must have unique names/u,
      );
      assert.deepEqual(events, ["retention:start", "retention:stop", "database:close"]);
    } finally {
      start.mockRestore();
      stop.mockRestore();
    }
  });

  it("does not need a retention store for a database-unavailable runtime", async () => {
    const start = vi
      .spyOn(TimelineRetention.prototype, "start")
      .mockImplementation(() => undefined);
    let runtime: ApplicationRuntime | undefined;
    try {
      runtime = await createApplicationRuntime({
        database: null,
        auth: null,
        entitlements: null,
        billing: null,
        close: async () => undefined,
      });
      assert.equal(start.mock.calls.length, 0);
    } finally {
      await runtime?.stop();
      start.mockRestore();
    }
  });
});

function registration(events: string[]): ProviderRegistration {
  return {
    connection: { name: "fake", status: () => ({ status: "connected" }), actions: {} },
    triggerProviders: [],
    sources: [
      {
        start: async () => {
          events.push("source:start");
        },
        stop: async () => {
          events.push("source:stop");
        },
      },
    ],
    outputs: [],
    requests: [],
  };
}
