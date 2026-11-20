import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { z } from "zod";
import { DaemonAgents } from "../daemons/agents/index.js";
import {
  createDaemonDispatchLifecycle,
  type ExecutionDeadlineClock,
} from "../daemons/lifecycle.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import { scanRunPayloads } from "./run-payload-retention.js";
import {
  createTimelinePostgresHarness,
  TIMELINE_ORGANIZATION,
} from "./test-utils/run-timeline-postgres.js";
import type { Database } from "./types.js";

const frameSchema = z.object({
  message: z.object({ requestId: z.string(), type: z.string(), agentId: z.string() }),
});

function daemonWire() {
  const frames: string[] = [];
  const first = Promise.withResolvers<void>();
  const daemon = {
    targetExists: true,
    unavailable: false,
    disconnectAfterRead: false,
    turn: "original",
    acknowledgement: "ack" as "ack" | "drop" | "hold",
    reply: () => {},
  };
  const adapter = new DaemonAgents((frame) => {
    const { message } = frameSchema.parse(JSON.parse(frame));
    const reply = (payload: Record<string, unknown>) => {
      adapter.receive({
        type: "session",
        message: { type: "response", payload: { ...payload, requestId: message.requestId } },
      });
    };
    if (message.type === "fetch_agent_request") {
      reply(
        daemon.unavailable
          ? { error: "temporarily unavailable" }
          : {
              agent: daemon.targetExists
                ? { id: message.agentId, workspaceId: "workspace", status: "running" }
                : null,
            },
      );
      if (daemon.disconnectAfterRead) adapter.close();
      return;
    }
    assert.equal(message.type, "cancel_agent_request");
    frames.push(daemon.turn);
    daemon.reply = () => reply({ accepted: true });
    first.resolve();
    if (daemon.acknowledgement === "drop") adapter.close();
    if (daemon.acknowledgement === "ack") daemon.reply();
  });
  adapter.receive({
    type: "session",
    message: {
      type: "server_info",
      payload: {
        features: { hubAgentRpc: true, agentRequestReceipts: true },
      },
    },
  });
  const connection: DaemonConnection = {
    agents: adapter,
    getProviderSnapshot: async () => {
      throw new Error("not used");
    },
    refreshProviderSnapshot: async () => {},
    validateAgentConfiguration: async () => ({ valid: true }),
  };
  return { adapter, daemon, connection, frames, first: first.promise };
}

function worker(
  database: Database,
  connection: () => DaemonConnection | undefined,
  deadlineClock?: ExecutionDeadlineClock,
) {
  return createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: connection,
    publicBaseUrl: "https://hub.test",
    completionTokenSecret: "test-secret",
    ...(deadlineClock === undefined ? {} : { test: { deadlineClock } }),
  });
}

describe("Stop interrupt delivery over the daemon wire", () => {
  let pg: Awaited<ReturnType<typeof createTimelinePostgresHarness>>;
  beforeAll(async () => {
    pg = await createTimelinePostgresHarness();
    await enrollTestDaemon(pg.database, TIMELINE_ORGANIZATION);
  }, 120_000);
  afterAll(async () => pg?.close(), 120_000);

  async function seed() {
    const run = await pg.createRun();
    const [step] = await pg.database.listWorkflowStepRunsForTriggerRun(run.id);
    assert.ok(step);
    const id = randomUUID();
    await pg.runtime.query(
      `insert into agent_executions
        (id, organization_id, project_id, configuration_revision_id, workflow_step_run_id, daemon_id, daemon_agent_id, status)
        values ($1,$2,$3,$4,$5,$6,'agent','running')`,
      [id, run.organizationId, run.projectId, run.configurationRevisionId, step.id, TEST_DAEMON_ID],
    );
    await pg.database.cancelTriggerRun(run.organizationId, run.id);
    await pg.runtime.query(
      "update trigger_runs set terminal_notification_delivered_at = now() where id=$1",
      [run.id],
    );
    const details = () => pg.database.readRunStopDetails(run.organizationId, run.id);
    const eligibility = async () =>
      (
        await scanRunPayloads(pg.runtime, null, new Date(Date.now() + 90 * 86_400_000), 100, false)
      ).find((candidate) => candidate.id === run.id)?.disposition;
    return { run, id, details, eligibility };
  }

  it("never resends to a newer daemon-side turn after a lost acknowledgement", async () => {
    const { id, details } = await seed();
    const first = daemonWire();
    first.daemon.acknowledgement = "drop";
    const newer = daemonWire();
    newer.daemon.turn = "newer";
    let connection = first.connection;
    const lifecycle = worker(pg.database, () => connection);
    try {
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      connection = newer.connection;
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(first.frames, ["original"]);
      assert.deepEqual(newer.frames, []);
      assert.equal((await details())?.cleanupState, "delivery_unconfirmed");
    } finally {
      await lifecycle.stop();
      await pg.database.completeHubAction(id, "interrupt");
    }
  });

  for (const restart of [false, true]) {
    it(
      restart
        ? "does not resend after a worker dies after sending"
        : "does not resend when the lease expires mid-send",
      async () => {
        const { id, details } = await seed();
        const first = daemonWire();
        first.daemon.acknowledgement = "hold";
        const next = restart ? daemonWire() : first;
        const other = await pg.connect();
        const original = worker(pg.database, () => first.connection);
        const successor = worker(other.database, () => next.connection);
        try {
          const sending = original.recoverPendingHubActions(TEST_DAEMON_ID);
          await first.first;
          await pg.runtime.query(
            `update agent_executions set hub_action_acknowledgements =
           jsonb_set(hub_action_acknowledgements, '{stop_interrupt_claim,until}',
             to_jsonb(clock_timestamp() - interval '1 second')) where id=$1`,
            [id],
          );
          await successor.recoverPendingHubActions(TEST_DAEMON_ID);
          assert.equal((await details())?.cleanupState, "delivery_unconfirmed");
          assert.deepEqual(first.frames, ["original"]);
          if (restart) {
            assert.deepEqual(next.frames, []);
            first.adapter.close();
          } else {
            first.daemon.reply();
          }
          await sending;
          assert.equal((await details())?.cleanupState, "delivery_unconfirmed");
        } finally {
          first.adapter.close();
          next.adapter.close();
          await original.stop();
          await successor.stop();
          await pg.database.completeHubAction(id, "interrupt");
        }
      },
    );
  }

  it("waits while offline and sends one frame after reconnect", async () => {
    const { id, details } = await seed();
    const wire = daemonWire();
    let connected = false;
    const lifecycle = worker(pg.database, () => (connected ? wire.connection : undefined));
    try {
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(wire.frames, []);
      assert.equal((await details())?.cleanupState, "waiting_for_daemon");
      connected = true;
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(wire.frames, ["original"]);
      assert.equal((await details())?.cleanupState, "confirmed");
    } finally {
      await lifecycle.stop();
      await pg.database.completeHubAction(id, "interrupt");
    }
  });

  it("can retry when the adapter disconnects after the read and before the cancel frame", async () => {
    const { id, details } = await seed();
    const disconnected = daemonWire();
    disconnected.daemon.disconnectAfterRead = true;
    const connected = daemonWire();
    let connection = disconnected.connection;
    const lifecycle = worker(pg.database, () => connection);
    try {
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(disconnected.frames, []);
      assert.equal((await details())?.cleanupState, "waiting_for_daemon");
      connection = connected.connection;
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(connected.frames, ["original"]);
      assert.equal((await details())?.cleanupState, "confirmed");
    } finally {
      await lifecycle.stop();
      await pg.database.completeHubAction(id, "interrupt");
    }
  });

  it("keeps transient reads pending and settles a definite missing agent", async () => {
    const { run, id, details, eligibility } = await seed();
    const wire = daemonWire();
    wire.daemon.unavailable = true;
    const lifecycle = worker(pg.database, () => wire.connection);
    try {
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(wire.frames, []);
      assert.equal((await details())?.cleanupState, "waiting_for_daemon");
      wire.daemon.unavailable = false;
      wire.daemon.targetExists = false;
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(wire.frames, []);
      assert.equal((await details())?.cleanupState, "target_gone");
      assert.equal(await eligibility(), "eligible");
      const cutoff = new Date(Date.now() + 90 * 86_400_000);
      const now = new Date(cutoff.getTime() + 1000);
      let expiry = await pg.database.expireRunPayloadChunk(run.id, cutoff, now);
      for (let chunk = 0; chunk < 4 && expiry === "expiring"; chunk++)
        expiry = await pg.database.expireRunPayloadChunk(run.id, cutoff, now);
      assert.equal(expiry, "expired");
      assert.equal((await details())?.cleanupState, "target_gone");
      assert.equal((await details())?.retryAttemptId, null);
    } finally {
      await lifecycle.stop();
      await pg.database.completeHubAction(id, "interrupt");
    }
  });

  it("expires an unreachable stop after 24 hours", async () => {
    const { id, details, eligibility } = await seed();
    let sweep: (() => Promise<void>) | undefined;
    const lifecycle = worker(pg.database, () => undefined, {
      now: () => 1,
      schedule: (callback) => {
        sweep = callback;
        return () => {
          sweep = undefined;
        };
      },
    });
    try {
      await pg.runtime.query(
        `update agent_executions set completed_at = clock_timestamp() - interval '25 hours',
          hub_action_acknowledgements = jsonb_set(hub_action_acknowledgements,
            '{stop_interrupt,requestedAt}', to_jsonb(clock_timestamp() - interval '25 hours'))
          where id=$1`,
        [id],
      );
      lifecycle.startStopInterruptRecovery();
      assert.ok(sweep);
      await sweep();
      assert.equal((await details())?.cleanupState, "delivery_unconfirmed");
      assert.equal(await eligibility(), "eligible");
    } finally {
      await lifecycle.stop();
      await pg.database.completeHubAction(id, "interrupt");
    }
  });

  it("accepts one new explicit Stop after an unconfirmed delivery", async () => {
    const { run, id, details } = await seed();
    const first = daemonWire();
    first.daemon.acknowledgement = "drop";
    const next = daemonWire();
    let connection = first.connection;
    const lifecycle = worker(pg.database, () => connection);
    try {
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      const retry = (await details())?.retryAttemptId;
      assert.ok(retry);
      const [a, b] = await Promise.all([
        pg.database.cancelTriggerRun(run.organizationId, run.id, undefined, 0, retry),
        pg.database.cancelTriggerRun(run.organizationId, run.id, undefined, 0, retry),
      ]);
      assert.deepEqual([...(a?.executionIds ?? []), ...(b?.executionIds ?? [])], [id]);
      connection = next.connection;
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.deepEqual(first.frames, ["original"]);
      assert.deepEqual(next.frames, ["original"]);
      assert.equal((await details())?.cleanupState, "confirmed");
    } finally {
      await lifecycle.stop();
      await pg.database.completeHubAction(id, "interrupt");
    }
  });

  it("settles at most one bounded batch of expired Stop actions per pass", async () => {
    const { run } = await seed();
    const lifecycle = worker(pg.database, () => undefined);
    try {
      await pg.runtime.query(
        `insert into agent_executions
          (id, organization_id, project_id, configuration_revision_id, daemon_id, status,
           completed_at, result, hub_action)
          select gen_random_uuid(), $1, $2, $3, $4, 'failed',
                 clock_timestamp() - interval '25 hours', '{"status":"canceled"}', 'interrupt'
          from generate_series(1, 101)`,
        [run.organizationId, run.projectId, run.configurationRevisionId, TEST_DAEMON_ID],
      );
      const pending = () => pg.database.findPendingHubActions(TEST_DAEMON_ID);
      assert.equal((await pending()).length, 102);
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.equal((await pending()).length, 2);
      await lifecycle.recoverPendingHubActions(TEST_DAEMON_ID);
      assert.equal((await pending()).length, 1);
      await pg.runtime.query(
        "update agent_executions set hub_action_completed_at = now() where daemon_id = $1 and hub_action_completed_at is null",
        [TEST_DAEMON_ID],
      );
    } finally {
      await lifecycle.stop();
    }
  });

  it("settles canceled work on daemon revocation and releases retention", async () => {
    const { details, eligibility } = await seed();
    await pg.database.revokeDaemon(TEST_DAEMON_ID);
    assert.equal((await details())?.cleanupState, "target_gone");
    assert.equal(await eligibility(), "eligible");
  });
});
