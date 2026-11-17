import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as wait } from "node:timers/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, describe, it, vi } from "vitest";
import { createDaemonDispatchLifecycle } from "../daemons/lifecycle.js";
import { createUnlimitedEntitlementsService } from "../entitlements/test-utils.js";
import {
  createActiveProjectConfiguration,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import type { TriggerProvider } from "../triggers/index.js";
import { createDurableWorkflowHandler } from "../workflows/engine.js";
import { createTimelinePostgresHarness } from "../db/test-utils/run-timeline-postgres.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import type { AcceptedTriggerRunRecord, Database } from "../db/types.js";
import { RunTimelineBus } from "../run-timeline/bus.js";
import type { RunTimelineEvent } from "../run-timeline/store.js";
import { ProgressReporter } from "./index.js";
import { CredentialBackoff } from "./backoff.js";
import { MessageWriter } from "./writer.js";
import type { ProgressCall, ProgressClock, ProgressProvider, StoredRef } from "./types.js";

const ORGANIZATION = "org-progress";
const REFERENCE = {
  credential: { kind: "linear-organization", linearOrganizationId: "fake" },
  commentId: "comment",
} satisfies StoredRef;

class FakeClock implements ProgressClock {
  private readonly epoch = Date.now();
  private elapsed = 0;
  private readonly timers = new Map<() => void, number>();

  constructor(
    private readonly drain = async () => {
      for (let turn = 0; turn < 4; turn += 1) await nextTurn();
    },
  ) {}

  now = () => this.epoch + this.elapsed;
  monotonic = () => this.elapsed;
  date = () => new Date(this.now());

  timer(callback: () => void, ms: number): () => void {
    this.timers.set(callback, this.elapsed + ms);
    return () => {
      this.timers.delete(callback);
    };
  }

  async advanceTo(target: number): Promise<void> {
    assert.ok(target >= this.elapsed);
    while (true) {
      await this.drain();
      const next = [...this.timers].sort((left, right) => left[1] - right[1])[0];
      if (next !== undefined && next[1] <= target) {
        this.elapsed = next[1];
        this.timers.delete(next[0]);
        next[0]();
      } else if (this.elapsed === target) {
        return;
      } else {
        this.elapsed = target;
      }
    }
  }
}

class FakeProvider implements ProgressProvider {
  readonly name = "linear";
  readonly maxBodyChars = 4000;
  readonly requests: { action: "create" | "edit"; body: string; time: number; ref: StoredRef }[] =
    [];
  readonly visible = new Map<string, string>();
  destination: ProgressProvider["destination"] = () => REFERENCE;
  authorize: ProgressProvider["authorize"] = async () => "ok";
  secrets: ProgressProvider["secrets"] = async () => [];
  onWrite: (
    request: FakeProvider["requests"][number],
    land: () => ProgressCall,
    signal: AbortSignal,
  ) => ProgressCall | Promise<ProgressCall> = (_request, land) => land();

  constructor(private readonly clock: FakeClock) {}

  create = (ref: StoredRef, body: string, signal: AbortSignal) =>
    this.send("create", ref, body, signal);
  edit = (ref: StoredRef, body: string, signal: AbortSignal) =>
    this.send("edit", ref, body, signal);

  private async send(
    action: "create" | "edit",
    ref: StoredRef,
    body: string,
    signal: AbortSignal,
  ): Promise<ProgressCall> {
    const request = { action, body, time: this.clock.monotonic(), ref };
    this.requests.push(request);
    return this.onWrite(
      request,
      () => {
        const id = ref["commentId"];
        assert.ok(typeof id === "string");
        this.visible.set(id, body);
        return { status: "ok", ref };
      },
      signal,
    );
  }
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
  vi.restoreAllMocks();
});

async function embedded() {
  const root = await mkdtemp(join(tmpdir(), "hub-progress-test-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(join(root, "database"));
  cleanup.push(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.migrate();
  await runtime.query(
    "insert into organization (id, name, slug) values ($1, 'Progress', 'progress')",
    [ORGANIZATION],
  );
  return createDatabase(runtime, locks);
}

async function createRun(database: Database, clock: FakeClock) {
  const project = await database.createProject({
    organizationId: ORGANIZATION,
    name: "Progress",
    slug: randomUUID(),
    createdByUserId: null,
  });
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: { environments: [], triggers: [] },
    contentHash: "progress",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id, []);
  const receipt = await database.persistManualEvent({
    organizationId: ORGANIZATION,
    projectId: project.id,
    deliveryId: randomUUID(),
    source: "manual.run",
    payload: {},
    receivedAt: clock.date(),
  });
  assert.equal(receipt.status, "accepted");
  return (
    await database.createAcceptedTriggerRun({
      organizationId: ORGANIZATION,
      projectId: project.id,
      configurationRevisionId: revision.id,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: "fake",
      prompt: "",
      inputs: {},
      triggerContext: {},
      outputContext: {},
      stepIds: [],
      createdAt: clock.date(),
      deadlineAt: new Date(clock.now() + 3600_000),
    })
  ).run;
}

function fixture(database?: Database, drain?: () => Promise<void>) {
  const clock = new FakeClock(drain);
  database ??= createMemoryDatabase({ organizationIds: [ORGANIZATION], now: clock.date });
  const store = database;
  const bus = new RunTimelineBus();
  const provider = new FakeProvider(clock);
  const failures: string[] = [];
  const start = (maxEdits = 120, localBus = bus, localStore = store) => {
    const reporter = new ProgressReporter({
      database: localStore,
      bus: localBus,
      providers: [provider],
      clock,
      random: () => 0.5,
      settings: { minEditSeconds: 20, maxEdits, retentionDays: 30 },
      reportFailure: (code) => failures.push(code),
    });
    cleanup.push(() => reporter.stop());
    reporter.start();
    return reporter;
  };

  async function event(
    run: AcceptedTriggerRunRecord,
    kind: RunTimelineEvent["kind"] = "run_started",
    index = 0,
  ) {
    const result = await store.appendRunTimelineEvent({
      organizationId: ORGANIZATION,
      triggerRunId: run.id,
      kind,
      at: clock.date(),
      origin: "captured",
      data:
        kind === "tool_finished"
          ? { callId: String(index), category: "command", status: "completed" }
          : {},
      maxEvents: 500,
    });
    assert.ok(result !== undefined && "seq" in result);
    bus.publish(run.id, result.seq);
  }

  async function seed({
    started = true,
    state = "pending",
  }: {
    started?: boolean;
    state?: "pending" | "creating" | "active" | "finished";
  } = {}) {
    const run = await createRun(store, clock);
    const scope = { triggerRunId: run.id, organizationId: ORGANIZATION };
    const read = () => store.findRunProgressMessage(ORGANIZATION, run.id);
    const acquire = (owner: string) =>
      store.acquireRunProgressLease({ ...scope, now: clock.date(), owner });
    const update = (
      owner: string,
      version: number,
      patch: Parameters<Database["updateRunProgressMessage"]>[0]["patch"],
      releaseLease = true,
    ) =>
      store.updateRunProgressMessage({
        ...scope,
        now: clock.date(),
        owner,
        version,
        patch,
        releaseLease,
      });
    const compensate = (notBefore?: Date) =>
      store.requestCompensation(ORGANIZATION, run.id, notBefore);
    const finish = async () => {
      await store.succeedTriggerRun(run.id);
      bus.publish(run.id, 1000);
    };
    assert.ok(
      await store.insertRunProgressMessageIfAbsent({
        ...scope,
        provider: "linear",
        now: clock.date(),
      }),
    );
    if (started) await event(run);
    if (state !== "pending") {
      const lease = await acquire("seed");
      assert.ok(lease);
      assert.ok(
        await update(
          "seed",
          lease.version,
          { state, externalRef: REFERENCE },
          state !== "creating",
        ),
      );
    }
    return { run, read, acquire, update, compensate, finish };
  }
  return { clock, bus, store, provider, failures, start, event, seed };
}

describe("run progress reporter", () => {
  it("coalesces 50 events, skips an identical body, caps regular edits and bypasses pacing for final", async () => {
    const f = fixture();
    const run = await f.seed();
    f.start(1);
    await f.clock.advanceTo(0);
    assert.deepEqual(
      f.provider.requests.map(({ action }) => action),
      ["create"],
    );
    await f.clock.advanceTo(1000);
    for (let index = 0; index < 50; index += 1) await f.event(run.run, "tool_finished", index);
    await f.clock.advanceTo(19_999);
    assert.equal(f.provider.requests.length, 1);
    await f.clock.advanceTo(20_000);
    assert.equal(f.provider.requests.length, 2);
    assert.match(f.provider.requests[1]!.body, /50 commands/u);
    f.bus.publish(run.run.id, 51);
    await f.clock.advanceTo(40_000);
    assert.equal(f.provider.requests.length, 2);
    await run.finish();
    await f.clock.advanceTo(40_000);
    assert.match(f.provider.requests[2]!.body, /Succeeded/u);
    await f.clock.advanceTo(160_000);
    assert.deepEqual(
      f.provider.requests.map(({ time }) => time),
      [0, 20_000, 40_000, 160_000],
    );
    assert.equal(f.provider.requests[2]!.body, f.provider.requests[3]!.body);
    assert.deepEqual(f.failures, []);
  });

  it("skips an identical body below the edit cap", async () => {
    const f = fixture();
    const run = await f.seed();
    f.start();
    await f.clock.advanceTo(0);
    f.bus.publish(run.run.id, 1);
    await f.clock.advanceTo(20_000);
    assert.deepEqual(
      f.provider.requests.map(({ action }) => action),
      ["create"],
    );
    assert.equal((await run.read())?.editCount, 0);
  });

  it("creates once with final content when a run ends before it starts", async () => {
    const f = fixture();
    const run = await f.seed({ started: false });
    await run.finish();
    f.start();
    await f.clock.advanceTo(180_000);
    assert.deepEqual(
      f.provider.requests.map(({ action }) => action),
      ["create"],
    );
    assert.match(f.provider.requests[0]!.body, /Succeeded/u);
    assert.equal((await run.read())?.state, "finished");
  });

  it("creates once across two reporters and serializes a running edit before their final edit", async () => {
    const f = fixture();
    const run = await f.seed();
    f.start();
    f.start();
    await f.clock.advanceTo(0);
    assert.deepEqual(
      f.provider.requests.map(({ action }) => action),
      ["create"],
    );
    const blocked = Promise.withResolvers<void>();
    f.provider.onWrite = async (request, land) => {
      if (request.action === "edit" && request.body.includes("Running")) await blocked.promise;
      return land();
    };
    await f.clock.advanceTo(2_000);
    await f.event(run.run, "tool_finished", 1);
    await f.clock.advanceTo(20_000);
    assert.equal(f.provider.requests.length, 2);
    await run.finish();
    await f.clock.advanceTo(24_000);
    assert.equal(f.provider.requests.length, 2);
    blocked.resolve();
    await f.clock.advanceTo(25_000);
    assert.equal(f.provider.requests.length, 3);
    assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
  });

  it("waits two seconds after the last regular timeout and sends an extra final edit", async () => {
    const f = fixture();
    const run = await f.seed();
    f.start();
    await f.clock.advanceTo(0);
    f.provider.onWrite = (request, land) =>
      request.action === "edit" && request.body.includes("Running")
        ? new Promise(() => {})
        : land();
    await f.event(run.run, "tool_finished", 1);
    await f.clock.advanceTo(20_000);
    await run.finish();
    await f.clock.advanceTo(31_999);
    assert.deepEqual(
      f.provider.requests.map(({ time }) => time),
      [0, 20_000],
    );
    await f.clock.advanceTo(34_000);
    assert.deepEqual(
      f.provider.requests.map(({ time }) => time),
      [0, 20_000, 32_000, 34_000],
    );
    assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
    await f.clock.advanceTo(152_000);
    assert.equal(f.provider.requests.at(-1)?.time, 152_000);
  });

  it("resolves an expired creating lease without restart and stops retrying an uncertain create", async () => {
    const f = fixture();
    f.start();
    const expired = await f.seed({ state: "creating" });
    const uncertain = await f.seed();
    f.provider.onWrite = () => new Promise(() => {});
    await f.clock.advanceTo(10_000);
    assert.equal((await uncertain.read())?.state, "abandoned");
    assert.equal((await expired.read())?.state, "creating");
    await f.clock.advanceTo(180_000);
    assert.equal((await expired.read())?.state, "abandoned");
    assert.deepEqual(
      f.provider.requests.map(({ action }) => action),
      ["create"],
    );
  });

  it("retries only a create explicitly rejected before creation", async () => {
    const f = fixture();
    const run = await f.seed();
    f.provider.onWrite = (_request, land) =>
      f.provider.requests.length === 1
        ? { status: "retry", notCreated: true, afterMs: 55_000 }
        : land();
    f.start();
    await f.clock.advanceTo(54_999);
    assert.equal((await run.read())?.state, "pending");
    assert.deepEqual(
      f.provider.requests.map(({ time }) => time),
      [0],
    );
    await f.clock.advanceTo(55_000);
    assert.deepEqual(
      f.provider.requests.map(({ time }) => time),
      [0, 55_000],
    );
    assert.equal((await run.read())?.state, "active");
  });

  it.each([
    ["absent destination", "unavailable", "no_destination"],
    ["locked thread", "unavailable", "locked_thread"],
    ["public repository", "refused", "public_repository"],
    ["credential rejected", "unavailable", "credential_rejected"],
    ["deleted message", "gone", "gone"],
  ] as const)("stops after %s without recreating", async (reason, state, code) => {
    const f = fixture();
    const run = await f.seed();
    if (reason === "absent destination") f.provider.destination = () => undefined;
    if (reason === "locked thread" || reason === "credential rejected")
      f.provider.authorize = async () => ({ unavailable: code });
    if (reason === "public repository") f.provider.authorize = async () => ({ refused: code });
    f.start();
    await f.clock.advanceTo(0);
    if (reason === "deleted message") {
      f.provider.onWrite = () => ({ status: "gone" });
      await f.event(run.run, "tool_finished");
      await f.clock.advanceTo(20_000);
    }
    await run.finish();
    await f.clock.advanceTo(180_000);
    assert.equal((await run.read())?.state, state);
    assert.equal((await run.read())?.failure, code);
    assert.equal(f.provider.requests.length, reason === "deleted message" ? 2 : 0);
    assert.deepEqual(f.failures, [code]);
  });

  it("keeps shutdown synchronous with an in-flight provider and stops all later sends", async () => {
    const f = fixture();
    const run = await f.seed();
    let signal: AbortSignal | undefined;
    f.provider.onWrite = (_request, _land, abort) => {
      signal = abort;
      return new Promise(() => {});
    };
    const reporter = f.start();
    await f.clock.advanceTo(0);
    assert.equal(signal?.aborted, false);
    reporter.stop();
    assert.equal(signal?.aborted, true);
    await run.finish();
    await f.clock.advanceTo(300_000);
    assert.equal(f.provider.requests.length, 1);
  });
});

function pausedSend(f: ReturnType<typeof fixture>) {
  const resume = Promise.withResolvers<void>();
  const send = f.provider.onWrite;
  f.provider.onWrite = async (request, land, signal) => {
    if (request.body !== "stale") return send(request, land, signal);
    await resume.promise;
    return land();
  };
  const pending = f.provider.edit(REFERENCE, "stale", new AbortController().signal);
  return async () => {
    resume.resolve();
    await pending;
  };
}

describe("progress repair across writers", () => {
  it.each(["memory", "embedded Postgres"] as const)(
    "preserves the exact newer-generation interleaving in %s",
    async (backend) => {
      const f = fixture(backend === "memory" ? undefined : await embedded());
      const run = await f.seed({ state: "active" });
      const old = await run.acquire("old");
      assert.ok(old);
      const staleLands = pausedSend(f);
      await f.clock.advanceTo(60_000);
      await run.finish();
      const final = await run.acquire("final");
      assert.ok(final);
      assert.ok(await run.update("final", final.version, { state: "finished" }));
      assert.equal(await run.compensate(), 1);

      const casStarted = Promise.withResolvers<void>();
      const finishCas = Promise.withResolvers<void>();
      const update = f.store.updateRunProgressMessage.bind(f.store);
      const original = vi
        .spyOn(f.store, "updateRunProgressMessage")
        .mockImplementation(async (input) => {
          if (input.owner !== "old" && input.patch.lastRenderedHash !== undefined) {
            casStarted.resolve();
            await finishCas.promise;
          }
          return update(input);
        });

      const compensator = f.start();
      await f.clock.advanceTo(60_000);
      await casStarted.promise;
      assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
      assert.equal((await run.read())?.compensationRequestedGen, 1);
      await staleLands();
      assert.equal(f.provider.visible.get("comment"), "stale");
      assert.equal(await run.update("old", old.version, {}), undefined);
      assert.equal(await run.compensate(), 2);
      finishCas.resolve();
      await f.clock.advanceTo(60_000);
      const row = await run.read();
      assert.equal(row?.compensationRequestedGen, 2);
      assert.equal(row?.compensationDoneGen, 1);
      assert.equal(f.provider.visible.get("comment"), "stale");

      compensator.stop();
      original.mockRestore();
      f.start();
      await f.clock.advanceTo(60_000);
      assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
      assert.equal((await run.read())?.compensationDoneGen, 2);

      await f.store.completeCompensation(ORGANIZATION, run.run.id, 1);
      assert.equal((await run.read())?.compensationDoneGen, 2);
      const generations = await Promise.all([run.compensate(), run.compensate()]);
      assert.deepEqual(
        generations.toSorted((first, second) => first! - second!),
        [3, 4],
      );
      assert.equal((await run.read())?.compensationRequestedGen, 4);
    },
  );

  it("uses a failed compare-and-set to repair a stale landing within 55 seconds", async () => {
    const f = fixture();
    const run = await f.seed({ state: "active" });
    const originalUpdate = f.store.updateRunProgressMessage.bind(f.store);
    const oldCommit = Promise.withResolvers<void>();
    const staleSend = Promise.withResolvers<void>();
    let staleLands: (() => ProgressCall) | undefined;
    let oldOwner: string | undefined;
    let compareAndSetFailed = false;
    f.provider.onWrite = (request, land) => {
      if (!request.body.includes("Running")) return land();
      staleLands = land;
      return staleSend.promise.then(() => ({ status: "ok" }));
    };
    vi.spyOn(f.store, "updateRunProgressMessage").mockImplementation(async (input) => {
      if (input.owner === oldOwner && input.patch.repeatFinal === true) {
        await oldCommit.promise;
        const result = await originalUpdate(input);
        compareAndSetFailed = result === undefined;
        return result;
      }
      return originalUpdate(input);
    });
    f.start();
    await f.clock.advanceTo(0);
    await f.event(run.run, "tool_finished", 1);
    await f.clock.advanceTo(0);
    oldOwner = (await run.read())?.leaseOwner ?? undefined;
    assert.ok(oldOwner);
    assert.ok(staleLands);
    await f.clock.advanceTo(60_000);
    await run.finish();
    f.start(120, new RunTimelineBus());
    await f.clock.advanceTo(62_000);
    assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
    await f.clock.advanceTo(63_000);
    staleLands();
    staleSend.resolve();
    oldCommit.resolve();
    await f.clock.advanceTo(63_000);
    assert.equal(compareAndSetFailed, true);
    assert.match(f.provider.visible.get("comment") ?? "", /Running/u);
    const generation = (await run.read())!.compensationRequestedGen;
    assert.ok(generation >= 2);
    await f.clock.advanceTo(118_000);
    assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
    assert.equal((await run.read())?.compensationDoneGen, generation);
  });

  it("repairs an expired edit lease within 115 seconds from the landing", async () => {
    const f = fixture();
    const run = await f.seed({ state: "active" });
    assert.ok(await run.acquire("crashed"));
    f.provider.visible.set("comment", "stale");
    await f.event(run.run, "tool_finished", 1);
    const delay = (ms: number) => new Promise<void>((resolve) => f.clock.timer(resolve, ms));
    f.provider.authorize = async () => {
      await delay(9_000);
      return "ok";
    };
    f.provider.secrets = async () => {
      await delay(9_000);
      return [];
    };
    f.provider.onWrite = async (_request, land) => {
      await delay(6_900);
      return land();
    };
    await f.clock.advanceTo(59_999);
    f.start();
    await f.clock.advanceTo(114_898);
    assert.equal(f.provider.visible.get("comment"), "stale");
    await f.clock.advanceTo(114_899);
    assert.match(f.provider.visible.get("comment") ?? "", /1 command/u);
    assert.equal((await run.read())?.compensationDoneGen, 1);
    assert.equal((await run.read())?.leaseOwner, null);
  });

  it.each(["settle", "rate limited", "after settle"] as const)(
    "exercises the 63-second stall trace with %s",
    async (mode) => {
      const f = fixture();
      const run = await f.seed({ state: "active" });
      assert.ok(await run.acquire("crashed"));
      const staleLands = pausedSend(f);
      f.start();
      await f.clock.advanceTo(60_000);
      assert.equal((await run.read())?.compensationDoneGen, 1);
      await f.clock.advanceTo(62_000);
      await run.finish();
      await f.clock.advanceTo(62_000);
      assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
      assert.equal((await run.read())?.compensationRequestedGen, 2);

      if (mode === "after settle") {
        await f.clock.advanceTo(183_000);
        assert.equal(f.provider.requests.at(-1)?.time, 182_000);
        await staleLands();
        await f.clock.advanceTo(1_000_000);
        assert.equal(f.provider.visible.get("comment"), "stale");
        return;
      }

      if (mode === "rate limited") {
        f.provider.onWrite = (request, land) =>
          request.time === 182_000
            ? { status: "retry", afterMs: 1_000_000, notCreated: false }
            : land();
      }
      await f.clock.advanceTo(63_000);
      await staleLands();
      const repairTime = mode === "rate limited" ? 1_082_000 : 182_000;
      await f.clock.advanceTo(repairTime - 1);
      assert.equal(f.provider.visible.get("comment"), "stale");
      assert.equal((await run.read())?.leaseOwner, null);
      await f.clock.advanceTo(repairTime);
      assert.equal(f.provider.requests.at(-1)?.time, repairTime);
      assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
      assert.equal((await run.read())?.settleAt, null);
    },
  );

  it("does not send after a replacement writer took ownership between authorization and recheck", async () => {
    const f = fixture();
    const run = await f.seed({ state: "active" });
    const rereading = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let block = false;
    const read = f.store.findRunProgressMessage.bind(f.store);
    vi.spyOn(f.store, "findRunProgressMessage").mockImplementation(async (...args) => {
      if (block) {
        block = false;
        rereading.resolve();
        await resume.promise;
      }
      return read(...args);
    });
    f.provider.secrets = async () => {
      block = true;
      return [];
    };
    f.start();
    await f.clock.advanceTo(0);
    await f.event(run.run, "tool_finished", 1);
    await f.clock.advanceTo(0);
    await rereading.promise;
    await f.clock.advanceTo(25_000);
    assert.equal(f.provider.requests.length, 0);
    f.provider.secrets = async () => [];
    await run.finish();
    f.start();
    await f.clock.advanceTo(60_000);
    resume.resolve();
    await f.clock.advanceTo(65_000);
    assert.ok(f.provider.requests.length >= 1);
    assert.ok(f.provider.requests.every(({ body }) => body.includes("Succeeded")));
  });
});

describe("reporter lifecycle integration", () => {
  it.each(["throws", "rejects", "hangs", "500"] as const)(
    "keeps the engine result, a single terminal notification and reactions when the provider %s",
    async (failure) => {
      const f = fixture();
      const { project, revision } = await createActiveProjectConfiguration(
        f.store,
        {
          environments: [
            { name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/workspace" },
          ],
          triggers: [
            {
              name: "progress",
              on: "linear.issue_assigned",
              max_runtime: "1h",
              filters: { from_users: ["trusted-author"] },
              progress_message: true,
              steps: [
                {
                  id: "skip",
                  environment: "runner",
                  max_runtime: "10m",
                  idle_timeout: "1m",
                  if: "${{ false }}",
                  agent: { provider: "codex" },
                  prompt: [{ text: "work" }],
                },
              ],
            },
          ],
        },
        { organizationId: ORGANIZATION },
      );
      const receipt = await f.store.persistManualEvent({
        organizationId: ORGANIZATION,
        projectId: project.id,
        deliveryId: randomUUID(),
        source: "linear.issue",
        payload: {},
        receivedAt: f.clock.date(),
      });
      assert.equal(receipt.status, "accepted");
      const readReceipt = f.store.findProviderEventReceiptById.bind(f.store);
      vi.spyOn(f.store, "findProviderEventReceiptById").mockImplementation(async (id) => {
        const stored = await readReceipt(id);
        return stored === undefined ? undefined : { ...stored, provider: "linear" };
      });
      const reactions: string[] = [];
      const triggerProvider: TriggerProvider = {
        name: "linear",
        eventNames: ["linear.issue"],
        match: async () => [
          {
            triggerName: "progress",
            triggerContext: { provider: "linear" },
            outputContext: {},
            conversation: null,
            configurationRevisionId: revision.id,
            hubConfig: revision.normalizedConfiguration,
            invocation: { status: "accepted", inputs: {}, prompt: "run" },
          },
        ],
        onDispatchAccepted: async () => {
          reactions.push("eyes");
          return { reaction: "eyes" };
        },
        onAgentExecutionCompleted: async (_trigger, _output, result, reactionState) => {
          assert.equal(result.status, "succeeded");
          assert.deepEqual(reactionState, { reaction: "eyes" });
          reactions.push("thumbs_up");
          return { reaction: "thumbs_up" };
        },
      };
      let notificationCount = 0;
      const lifecycle = createDaemonDispatchLifecycle({
        database: f.store,
        providers: [triggerProvider],
        connectionForDaemon: () => undefined,
      });
      const reporter = f.start();
      const { handler, engine } = createDurableWorkflowHandler({
        database: f.store,
        providers: [triggerProvider],
        now: f.clock.date,
        entitlements: createUnlimitedEntitlementsService(),
        onProgressRequested: (run) => reporter.request(run),
        onWorkflowRunAccepted: (run) => lifecycle.notifyWorkflowRunAccepted(run),
        onWorkflowRunTerminal: (run) => {
          notificationCount += 1;
          return lifecycle.notifyWorkflowRunTerminal(run);
        },
      });
      cleanup.push(async () => {
        await engine.stop();
        await lifecycle.stop();
      });
      f.provider.onWrite = () => {
        const error = new Error("provider-secret-QZX9");
        if (failure === "throws") throw error;
        if (failure === "rejects") return Promise.reject(error);
        if (failure === "hangs") return new Promise(() => {});
        return { status: "retry", afterMs: 0, notCreated: false, transient: true };
      };
      await handler(receipt.event);
      await handler(receipt.event);
      const runs = await f.store.findTriggerRunsByProviderEventReceiptId(
        receipt.event.providerEventReceiptId,
      );
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.outcome, "accepted");
      await f.event(run);
      await f.clock.advanceTo(0);
      assert.equal(f.provider.requests.length, 1);
      await engine.processAvailable();
      await f.clock.advanceTo(10_000);
      await engine.processAvailable();
      await f.clock.advanceTo(120_000);
      const terminal = await f.store.findTriggerRunForOrganization(ORGANIZATION, run.id);
      assert.equal(terminal?.outcome, "accepted");
      assert.equal(terminal.status, "succeeded");
      assert.ok(terminal.terminalNotificationDeliveredAt);
      assert.equal(notificationCount, 1);
      assert.deepEqual(reactions, ["eyes", "thumbs_up"]);
      assert.deepEqual(terminal.reactionState, { reaction: "thumbs_up" });
      assert.deepEqual(
        f.provider.requests.map(({ action }) => action),
        ["create"],
      );
      assert.equal(
        (await f.store.findRunProgressMessage(ORGANIZATION, run.id))?.state,
        "abandoned",
      );
      assert.ok(f.failures.every((code) => !code.includes("provider-secret")));
    },
  );

  it("backs off both runs using one credential and lets another credential proceed", async () => {
    const f = fixture();
    const first = await f.seed();
    const second = await f.seed({ started: false });
    const third = await f.seed({ started: false });
    f.provider.destination = (run) => ({
      credential: {
        kind: "linear-organization",
        linearOrganizationId: run.id === third.run.id ? "B" : "A",
      },
      commentId: run.id,
    });
    f.provider.onWrite = (_request, land) =>
      f.provider.requests.length === 1
        ? { status: "retry", afterMs: 65_000, notCreated: true }
        : land();
    f.start();
    await f.clock.advanceTo(0);
    assert.equal(f.provider.requests[0]?.ref["commentId"], first.run.id);
    await f.clock.advanceTo(1_000);
    await f.event(second.run);
    await f.event(third.run);
    await f.clock.advanceTo(1_000);
    assert.deepEqual(
      f.provider.requests.map(({ ref }) => ref["commentId"]),
      [first.run.id, third.run.id],
    );
    await f.clock.advanceTo(64_999);
    assert.equal(f.provider.requests.length, 2);
    await f.clock.advanceTo(66_000);
    assert.deepEqual(
      new Set(f.provider.requests.slice(2).map(({ ref }) => ref["commentId"])),
      new Set([first.run.id, second.run.id]),
    );
  });

  it("marks all acting rows on a rejected credential once and leaves other credentials usable", async () => {
    const f = fixture();
    const first = await f.seed();
    const second = await f.seed({ started: false });
    const third = await f.seed({ started: false });
    f.provider.destination = (run) => ({
      credential: {
        kind: "linear-organization",
        linearOrganizationId: run.id === third.run.id ? "B" : "A",
      },
      commentId: run.id,
    });
    f.provider.onWrite = (request, land) =>
      request.ref["commentId"] === first.run.id
        ? { status: "unavailable", code: "credential_rejected" }
        : land();
    f.start();
    await f.clock.advanceTo(0);
    await f.event(second.run);
    await f.event(third.run);
    await f.clock.advanceTo(0);
    assert.equal((await first.read())?.failure, "credential_rejected");
    assert.equal((await second.read())?.failure, "credential_rejected");
    assert.equal((await third.read())?.state, "active");
    assert.deepEqual(f.failures, ["credential_rejected"]);
  });

  it("restarts a durable final retry chain when the run finished while Hub was down", async () => {
    const f = fixture();
    const run = await f.seed({ state: "active" });
    await run.finish();
    f.provider.onWrite = (_request, land) =>
      f.provider.requests.length <= 5 ? { status: "retry", afterMs: 0, notCreated: false } : land();
    const reporter = f.start();
    await f.clock.advanceTo(65_000);
    assert.deepEqual(
      f.provider.requests.map(({ time }) => time),
      [0, 5_000, 20_000, 65_000],
    );
    assert.equal((await run.read())?.finalFailures, 4);
    reporter.stop();
    await f.clock.advanceTo(185_000);
    f.start();
    await f.clock.advanceTo(484_999);
    assert.equal(f.provider.requests.length, 5);
    assert.equal((await run.read())?.finalFailures, 5);
    await f.clock.advanceTo(485_000);
    assert.deepEqual(
      f.provider.requests.map(({ time }) => time),
      [0, 5_000, 20_000, 65_000, 185_000, 485_000],
    );
    assert.equal((await run.read())?.state, "finished");
  });
});

describe("progress scheduling", () => {
  it("serializes independent reporters through two pooled Postgres connections", async () => {
    const postgres = await createTimelinePostgresHarness();
    cleanup.push(() => postgres.close());
    const [first, second] = await Promise.all([postgres.connect(), postgres.connect()]);
    assert.notEqual(first.pid, second.pid);
    await postgres.runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Progress', 'progress')",
      [ORGANIZATION],
    );
    const f = fixture(first.database, () => wait(25));
    const run = await f.seed();
    const otherBus = new RunTimelineBus();
    f.start();
    f.start(120, otherBus, second.database);
    await f.clock.advanceTo(0);
    assert.deepEqual(
      f.provider.requests.map(({ action }) => action),
      ["create"],
    );
    const blocked = Promise.withResolvers<void>();
    f.provider.onWrite = async (request, land) => {
      if (request.body.includes("Running")) await blocked.promise;
      return land();
    };
    await f.clock.advanceTo(2_000);
    await f.event(run.run, "tool_finished", 1);
    await f.clock.advanceTo(20_000);
    assert.equal(f.provider.requests.length, 2);
    await run.finish();
    otherBus.publish(run.run.id, 1000);
    await f.clock.advanceTo(24_000);
    assert.equal(f.provider.requests.length, 2);
    blocked.resolve();
    await f.clock.advanceTo(25_000);
    assert.equal(f.provider.requests.length, 3);
    assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
    assert.equal((await run.read())?.state, "finished");
  });

  it("receives timeline events when every per-run stream subscription is in use", async () => {
    const f = fixture();
    const run = await f.seed();
    const constrainedBus = new RunTimelineBus({ maxSubscriptions: 1 });
    const release = constrainedBus.subscribe("stream", () => {});
    cleanup.push(release);
    f.start(120, constrainedBus);
    await f.clock.advanceTo(0);
    await f.event(run.run, "tool_finished", 1);
    constrainedBus.publish(run.run.id, 2);
    await f.clock.advanceTo(20_000);
    assert.deepEqual(
      f.provider.requests.map(({ action }) => action),
      ["create", "edit"],
    );
  });

  it("switches to one-minute pacing for a run older than fifteen minutes", async () => {
    const f = fixture();
    const run = await f.seed();
    f.start();
    await f.clock.advanceTo(920_000);
    await f.event(run.run, "tool_finished", 1);
    await f.clock.advanceTo(920_000);
    assert.equal(f.provider.requests.length, 2);
    await f.event(run.run, "tool_finished", 2);
    await f.clock.advanceTo(979_999);
    assert.equal(f.provider.requests.length, 2);
    await f.clock.advanceTo(980_000);
    assert.equal(f.provider.requests.length, 3);
  });

  it("stops regular edits after eight consecutive failures and still delivers the final edit", async () => {
    const f = fixture();
    const run = await f.seed();
    f.start();
    await f.clock.advanceTo(0);
    f.provider.onWrite = (request, land) =>
      request.body.includes("Running")
        ? { status: "retry", notCreated: false, afterMs: 0 }
        : land();
    await f.event(run.run, "tool_finished", 1);
    await f.clock.advanceTo(40_000);
    assert.equal(f.provider.requests.length, 9);
    assert.equal((await run.read())?.failedEdits, 8);
    await f.event(run.run, "tool_finished", 2);
    await f.clock.advanceTo(60_000);
    assert.equal(f.provider.requests.length, 9);
    await run.finish();
    await f.clock.advanceTo(60_000);
    assert.equal(f.provider.requests.length, 10);
    assert.match(f.provider.visible.get("comment") ?? "", /Succeeded/u);
  });

  it("abandons a final edit that remains unavailable for six hours", async () => {
    const f = fixture();
    const run = await f.seed({ state: "active" });
    await run.finish();
    f.provider.onWrite = () => ({ status: "retry", notCreated: false, afterMs: 900_000 });
    f.start();
    await f.clock.advanceTo(6 * 60 * 60_000 - 1);
    assert.equal((await run.read())?.state, "active");
    await f.clock.advanceTo(6 * 60 * 60_000);
    assert.equal((await run.read())?.state, "abandoned");
    assert.equal((await run.read())?.failure, "final_retry_expired");
  });
});

it("serializes finalization against a separate Hub process and recovers its expired lease", async () => {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  cleanup.push(async () => {
    await container.stop();
  });
  const connection = container.getConnectionUri();
  const postgres = await createPostgresTestRuntime(connection);
  cleanup.push(() => postgres.runtime.close());
  await postgres.runtime.query(
    "insert into organization (id, name, slug) values ($1, 'Progress', 'progress')",
    [ORGANIZATION],
  );
  const f = fixture(postgres.database);

  for (const exit of ["complete", "crash"] as const) {
    const run = await f.seed({ state: "active" });
    const scope = { triggerRunId: run.run.id, organizationId: ORGANIZATION };
    const child = startExternalWriter(connection, scope, f.clock.now());
    cleanup.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    });
    const message: unknown[] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Writer exited before sending");
      }),
    ]);
    const [body] = message;
    assert.ok(typeof body === "string");
    assert.match(body, /Paseo run: Running/u);
    const old = await run.read();
    assert.ok(old?.leaseOwner);
    const firstRequest = f.provider.requests.length;

    await run.finish();
    const replacement = new MessageWriter({
      database: f.store,
      clock: f.clock,
      settings: { minEditSeconds: 20, maxEdits: 120, retentionDays: 30 },
      signal: new AbortController().signal,
      backoff: new CredentialBackoff(),
      report: () => {},
    });
    const blocked = await replacement.write(scope, f.provider);
    assert.equal(blocked.wakeAt, f.clock.now() + 5_000);
    assert.equal(f.provider.requests.length, firstRequest);
    assert.equal((await run.read())?.leaseOwner, old.leaseOwner);

    const exited = once(child, "exit");
    if (exit === "complete") child.send("land");
    else child.kill("SIGKILL");
    assert.deepEqual(await exited, exit === "complete" ? [0, null] : [null, "SIGKILL"]);

    if (exit === "crash") {
      await f.clock.advanceTo(59_999);
      assert.equal((await replacement.write(scope, f.provider)).row?.leaseOwner, old.leaseOwner);
      await f.clock.advanceTo(60_000);
    }
    await replacement.write(scope, f.provider);
    assert.equal(f.provider.requests.length, firstRequest + 1);
    assert.match(f.provider.requests.at(-1)?.body ?? "", /Paseo run: Succeeded/u);
    assert.equal((await run.read())?.state, "finished");
    if (exit === "crash") assert.equal((await run.read())?.compensationRequestedGen, 2);
  }
}, 45_000);

function startExternalWriter(
  connection: string,
  scope: { triggerRunId: string; organizationId: string },
  now: number,
) {
  const source = `
    import { once } from "node:events";
    import { createDatabase } from "./src/db/pg.ts";
    import { postgresDatabaseRuntime } from "./src/db/runtime/index.ts";
    import { CredentialBackoff } from "./src/run-progress/backoff.ts";
    import { progressClock } from "./src/run-progress/types.ts";
    import { MessageWriter } from "./src/run-progress/writer.ts";

    const { runtime, locks } = await postgresDatabaseRuntime(process.env.PASEO_REPORTER_TEST_DATABASE, { max: 1 });
    try {
      const writer = new MessageWriter({
        database: createDatabase(runtime, locks),
        clock: { ...progressClock, now: () => ${JSON.stringify(now)} },
        settings: { minEditSeconds: 20, maxEdits: 120, retentionDays: 30 },
        signal: new AbortController().signal,
        backoff: new CredentialBackoff(),
        report: () => {},
      });
      const result = await writer.write(${JSON.stringify(scope)}, {
        name: "linear",
        maxBodyChars: 4000,
        authorize: async () => "ok",
        secrets: async () => [],
        edit: async (_ref, body) => {
          const landing = once(process, "message");
          process.send(body);
          await landing;
          return { status: "ok" };
        },
      });
      if (result.row?.editCount !== 1) process.exitCode = 2;
    } finally {
      await runtime.close();
      process.disconnect();
    }
  `;
  return spawn(process.execPath, ["--import", "tsx", "--eval", source], {
    env: { ...process.env, PASEO_REPORTER_TEST_DATABASE: connection },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

it("keeps the lease recoverable if recording a write and its repair request both fail", async () => {
  const f = fixture();
  const run = await f.seed({ state: "active" });
  const update = f.store.updateRunProgressMessage.bind(f.store);
  let failOnce = true;
  vi.spyOn(f.store, "updateRunProgressMessage").mockImplementation(async (input) => {
    if (failOnce && input.patch.lastRenderedHash !== undefined) {
      failOnce = false;
      throw new Error("database unavailable");
    }
    return update(input);
  });
  vi.spyOn(f.store, "requestCompensation").mockRejectedValueOnce(new Error("database unavailable"));
  f.start();
  await f.clock.advanceTo(0);
  await f.event(run.run, "tool_finished", 1);
  await f.clock.advanceTo(0);
  assert.equal(f.provider.requests.length, 1);
  const old = await run.read();
  assert.ok(old?.leaseOwner);
  assert.deepEqual(f.failures, ["outcome_record_failed"]);
  await f.clock.advanceTo(60_000);
  assert.equal(f.provider.requests.length, 2);
  assert.equal((await run.read())?.compensationDoneGen, 1);
});
