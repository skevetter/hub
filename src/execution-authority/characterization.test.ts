import assert from "node:assert/strict";
import { it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import {
  createExecutionAuthority,
  type CreateExecutionAuthorityOptions,
  type ExecutionAuthorityClock,
  type ExecutionAuthorityMaterialization,
} from "./index.js";

const input = {
  executionId: "execution",
  projectId: "project",
  triggerContext: {},
  github: {
    connection: "github",
    repositories: ["owner/repo"],
    permissions: { contents: "read" },
    durationMs: 60_000,
  },
} satisfies ExecutionAuthorityMaterialization;

function fixture() {
  const database = createMemoryDatabase();
  const clock = new ManualClock();
  const mint = vi.fn(async (_request: unknown) => ({
    token: "test-token",
    expiresAt: 90_000,
    botUserId: 1,
    botLogin: "test-bot",
  }));
  const revoke = vi.fn(async (_token: string) => {});
  const logger = { error: vi.fn(), warn: vi.fn() };
  const options = {
    database,
    clock,
    logger,
    connectionsForProject: () => () => "unused",
    githubAuthority: { mint, revoke },
    isExecutionActive: async () => true,
  } satisfies CreateExecutionAuthorityOptions;
  return {
    authority: createExecutionAuthority(options),
    store: options.database.executionAuthority,
    options,
    mint,
    revoke,
    logger,
    clock,
  };
}

class ManualClock implements ExecutionAuthorityClock {
  private time = 0;
  readonly scheduled = new Map<() => Promise<void>, number>();

  now() {
    return this.time;
  }

  schedule(callback: () => Promise<void>, delayMs: number) {
    this.scheduled.set(callback, this.time + delayMs);
    return () => this.scheduled.delete(callback);
  }

  async advance(delayMs: number) {
    this.time += delayMs;
    for (const [callback, at] of Array.from(this.scheduled)) {
      if (at > this.time) continue;
      this.scheduled.delete(callback);
      await callback();
    }
  }
}

it("revokes and clears the watchdog if registration fails before a lease is durable", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { authority, store, revoke, clock } = fixture();
    const error = new Error("lease write failed");
    vi.spyOn(store, "saveLease").mockRejectedValueOnce(error);

    await assert.rejects(authority.materialize(input), (caught) => caught === error);

    assert.deepEqual(revoke.mock.calls, [["test-token"]]);
    assert.deepEqual(await store.leases(), []);
    assert.equal(clock.scheduled.size, 0);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(authority.resourceCounts().pendingMaterializations, 0);
  } finally {
    vi.useRealTimers();
  }
});

it("releases an owned lease when commit fails and the execution stays active", async () => {
  const { authority, store, revoke, clock } = fixture();
  const error = new Error("commit failed");
  vi.spyOn(store, "commit").mockRejectedValueOnce(error);

  await assert.rejects(authority.materialize(input), (caught) => caught === error);

  assert.equal(await store.read(input.executionId), undefined);
  assert.deepEqual(revoke.mock.calls, [["test-token"]]);
  assert.deepEqual(await store.leases(), []);
  assert.equal(clock.scheduled.size, 0);
});

it("preserves committed credentials when the authority stops during commit", async () => {
  const { authority, store, revoke, clock } = fixture();
  const commit = store.commit.bind(store);
  vi.spyOn(store, "commit").mockImplementationOnce(async (record) => {
    const committed = await commit(record);
    await authority.stop();
    return committed;
  });

  await assert.rejects(authority.materialize(input), { code: "execution_authority_stopped" });

  assert.equal((await store.read(input.executionId))?.env["GH_TOKEN"], "test-token");
  assert.equal((await store.leases(input.executionId)).length, 1);
  assert.deepEqual(revoke.mock.calls, []);
  await clock.advance(90_000);
  assert.equal(clock.scheduled.size, 0);
  assert.deepEqual(revoke.mock.calls, []);
});

it("does not resume a record whose credential is being revoked", async () => {
  const { authority, options, store, clock, mint } = fixture();
  await authority.materialize(input);
  await authority.stop();
  for (const lease of await store.leases(input.executionId)) {
    await store.saveLease({ ...lease, revoking: true });
  }
  const replacement = createExecutionAuthority(options);

  assert.equal(await replacement.canResume(input), false);
  await assert.rejects(replacement.materialize(input), {
    code: "execution_credentials_unavailable",
  });
  assert.equal(clock.scheduled.size, 0);
  assert.equal(mint.mock.calls.length, 1);
});

it("recovers a revoking lease with a future retry without issuing another upstream call", async () => {
  const { authority, store, options, clock, revoke } = fixture();
  await authority.materialize(input);
  await authority.stop();
  for (const lease of await store.leases(input.executionId)) {
    await store.saveLease({ ...lease, revoking: true, attempts: 1, nextAttemptAt: 3_000 });
  }
  const replacement = createExecutionAuthority(options);

  await replacement.recover();
  assert.deepEqual(revoke.mock.calls, []);
  assert.deepEqual([...clock.scheduled.values()], [3_000]);
  await clock.advance(3_000);
  assert.deepEqual(revoke.mock.calls, [["test-token"]]);
  assert.deepEqual(await store.leases(), []);
});

it("retries the scheduled wakeup one second after a database read failure", async () => {
  const { authority, store, clock, revoke, logger } = fixture();
  await authority.materialize(input);
  vi.spyOn(store, "leases").mockRejectedValueOnce(new Error("database unavailable"));

  await clock.advance(60_000);
  assert.deepEqual(revoke.mock.calls, []);
  assert.deepEqual([...clock.scheduled.values()], [61_000]);
  assert.equal(logger.error.mock.calls.length, 1);
  await clock.advance(1_000);
  assert.deepEqual(revoke.mock.calls, [["test-token"]]);
  assert.deepEqual(await store.leases(), []);
});

it("persists exponential retry times capped by the upstream expiry", async () => {
  const { authority, store, clock, revoke } = fixture();
  revoke.mockRejectedValue(new Error("upstream unavailable"));
  await authority.materialize(input);
  await clock.advance(86_000);

  assert.deepEqual(
    (await store.leases()).map(({ attempts, nextAttemptAt }) => [attempts, nextAttemptAt]),
    [[1, 87_000]],
  );
  await clock.advance(1_000);
  assert.deepEqual(
    (await store.leases()).map(({ attempts, nextAttemptAt }) => [attempts, nextAttemptAt]),
    [[2, 89_000]],
  );
  await clock.advance(2_000);
  assert.deepEqual(
    (await store.leases()).map(({ attempts, nextAttemptAt }) => [attempts, nextAttemptAt]),
    [[3, 90_000]],
  );
  await clock.advance(1_000);
  assert.deepEqual(await store.leases(), []);
  assert.equal(revoke.mock.calls.length, 3);
});

it.each([
  null,
  { provider: "github" },
  { provider: "github", target: null },
  { provider: "github", target: { repository: 123 } },
  { provider: "slack", target: { repository: "owner/repo" } },
])(
  "rejects a repository fallback for malformed or non-GitHub context %j",
  async (triggerContext) => {
    const { authority, mint } = fixture();
    const { connection, permissions, durationMs } = input.github;

    await assert.rejects(
      authority.materialize({
        ...input,
        triggerContext,
        github: { connection, permissions, durationMs },
      }),
      { code: "github_authority_scope_invalid" },
    );
    assert.deepEqual(mint.mock.calls, []);
  },
);
