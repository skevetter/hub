import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase } from "../db/pg.js";
import { scanRunPayloads } from "../db/run-payload-retention.js";
import { embeddedDatabaseRuntime, type QueryHandle, type QueryRow } from "../db/runtime/index.js";
import { createTimelinePostgresHarness } from "../db/test-utils/run-timeline-postgres.js";
import { createPostgresTestRuntime } from "../db/test-utils/runtime.js";
import type { AgentExecutionRecord, Database } from "../db/types.js";
import { activityRunDetailView } from "../projects/activity-run-view.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import { RunPayloadRetention } from "./index.js";

const NOW = new Date("2026-11-18T00:00:00Z");
const CUTOFF = new Date("2026-10-19T00:00:00Z");
const OLD = "2026-10-18T23:59:59.999Z";
const ORG = "expiry";
const PROJECT = "00000000-0000-4000-8000-100000000001";
const REVISION = "00000000-0000-4000-8000-200000000001";
const RECEIPT = "00000000-0000-4000-8000-300000000001";
const STEP = "00000000-0000-4000-8000-500000000001";
const AGENT_STEP = "00000000-0000-4000-8000-500000000002";
const EXECUTION = "00000000-0000-4000-8000-600000000001";
const LEGACY_EXECUTION = "00000000-0000-4000-8000-600000000002";
const SESSION = "00000000-0000-4000-8000-700000000001";
const COMPLETED_ATTEMPT = "completed-attempt";
const runId = (index: number) =>
  `00000000-0000-4000-8000-4000000000${String(index).padStart(2, "0")}`;
const marker = /raw-sentinel-/u;

async function seed(runtime: QueryHandle) {
  for (const sql of [
    `insert into organization (id, name, slug) values ('${ORG}', 'Expiry', 'expiry')`,
    `insert into projects (id, organization_id, name, slug)
      values ('${PROJECT}', '${ORG}', 'Expiry', 'expiry')`,
    `insert into project_configuration_revisions
      (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
      values ('${REVISION}', '${PROJECT}', '${ORG}', 1, 'manual', '{}', '{}', 'expiry')`,
    `insert into provider_event_receipts (id, organization_id, provider, delivery_id, source, payload)
      values ('${RECEIPT}', '${ORG}', 'manual', 'delivery', 'webhook.received',
        '{"actor":"raw-sentinel-actor","message":"raw-sentinel-receipt"}')`,
    `insert into trigger_runs (id, organization_id, project_id, configuration_revision_id,
      provider_event_receipt_id, configured_trigger_name, status, completed_at, prompt, deadline_at,
      inputs, values, trigger_context, output_context, conversation, failure_reason)
      select id::uuid, '${ORG}', '${PROJECT}', '${REVISION}', '${RECEIPT}', name,
        status, completed_at::timestamptz, 'raw-sentinel-prompt', '2026-11-20T00:00:00Z',
        '{"input":"raw-sentinel-input"}', '{"value":"raw-sentinel-value"}',
        '{"inner":{"body":"raw-sentinel-trigger"}}', '{"inner":{"body":"raw-sentinel-output-context"}}',
        '{"key":"raw-sentinel-conversation","label":"raw-sentinel-title"}', 'raw-sentinel-failure'
      from (values
        ('${runId(1)}', 'workflow-eligible', 'failed', '${OLD}'),
        ('${runId(2)}', 'workflow-live', 'running', null),
        ('${runId(3)}', 'workflow-boundary', 'succeeded', '${CUTOFF.toISOString()}'),
        ('${runId(4)}', 'workflow-anomaly', 'failed', null),
        ('${runId(5)}', 'workflow-cleanup', 'failed', '${OLD}'),
        ('${runId(6)}', 'workflow-wakeup', 'succeeded', '${OLD}'),
        ('${runId(7)}', 'workflow-notification', 'failed', '${OLD}'),
        ('${runId(8)}', 'workflow-reporter', 'failed', '${OLD}'),
        ('${runId(9)}', 'workflow-child', 'failed', '${OLD}'),
        ('${runId(10)}', 'workflow-pending-dispatch', 'succeeded', '${OLD}'),
        ('${runId(11)}', 'workflow-recent', 'succeeded', '${NOW.toISOString()}')
      ) as samples(id, name, status, completed_at)`,
    `insert into trigger_runs (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
       configured_trigger_name, outcome, status, completed_at, prompt, rejection)
      values ('${runId(12)}', '${ORG}', '${PROJECT}', '${REVISION}', '${RECEIPT}', 'workflow-rejected',
        'rejected', 'rejected', '${OLD}', 'raw-sentinel-rejection-prompt',
        '{"code":"invalid_choice","inputName":"raw-sentinel-input-name","value":"raw-sentinel-choice-value","choices":["raw-sentinel-choice"]}')`,
    `insert into provider_event_receipts (id, organization_id, provider, delivery_id, source, payload, accepted_routes)
      values ('00000000-0000-4000-8000-300000000002', '${ORG}', 'github', 'fan-out', 'github.push',
        '{"text":"raw-sentinel-fan-out"}',
        '[{"projectId":"${PROJECT}","configurationRevisionId":"${REVISION}","connectionId":null,"resourceId":null},
          {"projectId":"00000000-0000-4000-8000-100000000002","configurationRevisionId":"00000000-0000-4000-8000-200000000002","connectionId":null,"resourceId":null}]')`,
    `insert into trigger_runs (id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
       configured_trigger_name, status, completed_at, prompt, deadline_at)
      values ('${runId(13)}', '${ORG}', '${PROJECT}', '${REVISION}', '00000000-0000-4000-8000-300000000002',
        'workflow-fan-out', 'failed', '${OLD}', 'raw-sentinel-prompt', '${NOW.toISOString()}'),
        ('${runId(14)}', '${ORG}', '${PROJECT}', '${REVISION}', '${RECEIPT}',
        'workflow-live-execution', 'succeeded', '${OLD}', 'raw-sentinel-prompt', '${NOW.toISOString()}')`,
    `insert into agent_executions (organization_id, project_id, configuration_revision_id, status, launch_intent, result)
      values ('${ORG}', '${PROJECT}', '${REVISION}', 'running',
      '{"kind":"launch_machine","triggerRunId":"${runId(14)}"}', '{"text":"raw-sentinel-live-result"}')`,
    `insert into workflow_step_runs (id, trigger_run_id, step_id, ordinal, status, started_at, completed_at,
        output, failure_reason, dispatch_intent)
      values
        ('${STEP}', '${runId(1)}', 'script', 0, 'failed', '${OLD}', '${OLD}',
          '{"exit_code":7,"output_tail":"raw-sentinel-tail","truncated":true}', 'raw-sentinel-script-error', null),
        ('${AGENT_STEP}', '${runId(1)}', 'agent', 1, 'succeeded', '${OLD}', '${OLD}',
          '{"output":"raw-sentinel-agent-output"}', 'raw-sentinel-agent-error',
          '{"agent":{"provider":"codex","model":"gpt-5"},"env":{"private":"raw-sentinel-env"},"prompt":"raw-sentinel-dispatch","outputContext":{"body":"raw-sentinel-nested-dispatch"}}'),
        (gen_random_uuid(), '${runId(5)}', 'cleanup', 0, 'failed', '${OLD}', '${OLD}',
          '{"exit_code":1,"output_tail":"raw-sentinel-cleanup","truncated":false,"cleanup":{"daemon_id":"pending","name":"stop","cwd":"/tmp"}}', null, null),
        (gen_random_uuid(), '${runId(9)}', 'child', 0, 'running', '${OLD}', null,
          '{"output":"raw-sentinel-child"}', null, null),
        (gen_random_uuid(), '${runId(10)}', 'pending', 0, 'pending', null, null,
          null, null, '{"prompt":"raw-sentinel-pending-dispatch"}')`,
    `insert into workflow_step_runs (trigger_run_id, step_id, ordinal, status, output)
      select '${runId(1)}', 'extra-' || n, n + 1, 'succeeded', '{"output":"raw-sentinel-extra"}'
      from generate_series(1, 52) n`,
    `insert into agent_executions
       (id, organization_id, project_id, configuration_revision_id, workflow_step_run_id,
        status, completed_at, completed_by_agent_at, result, trigger_context, output_context,
        launch_intent, reaction_state, completion_token_hash)
       values
        ('${EXECUTION}', '${ORG}', '${PROJECT}', '${REVISION}', '${AGENT_STEP}', 'succeeded',
          '${OLD}', null,
          '{"completion":"inferred_from_turn_end","output":{"text":"raw-sentinel-result"}}',
          '{"text":"raw-sentinel-execution-trigger"}', '{"text":"raw-sentinel-execution-output"}',
          '{"prompt":"launch-intent-kept"}', '{"phase":"kept"}', 'kept-hash'),
        ('${LEGACY_EXECUTION}', '${ORG}', '${PROJECT}', '${REVISION}', null, 'succeeded', '${OLD}', '${OLD}',
          '{"output":"raw-sentinel-legacy-result"}', '{"text":"raw-sentinel-legacy-trigger"}', '{"text":"raw-sentinel-legacy-output"}',
          '{"kind":"launch_machine","triggerRunId":"${runId(1)}","prompt":"legacy-intent-kept"}', null, null)`,
    `update workflow_step_runs set agent_execution_id = '${EXECUTION}' where id = '${AGENT_STEP}'`,
    `insert into workflow_wakeups (trigger_run_id, available_at) values ('${runId(6)}','${OLD}')`,
    `update trigger_runs set terminal_notification_pending_at = '${OLD}' where id in ('${runId(1)}','${runId(7)}')`,
    `insert into run_progress_messages (trigger_run_id, organization_id, provider, state, settle_at, external_ref)
       values ('${runId(1)}', '${ORG}', 'github', 'finished', null,
          '{"repository":"owner/repo","issueNumber":9,"commentId":8,"credential":"private-binding"}'),
        ('${runId(8)}', '${ORG}', 'github', 'finished', '${OLD}', null)`,
  ])
    await runtime.query(sql);
}

async function assertProtectedReads(database: Database) {
  const activity = await database.findProjectActivityRun(PROJECT, runId(1));
  assert.ok(activity);
  assert.equal(activity.run.payloadExpiredAt?.toISOString(), NOW.toISOString());
  const execution = await database.findAgentExecutionById(EXECUTION);
  const legacyExecution = await database.findAgentExecutionById(LEGACY_EXECUTION);
  assert.equal(execution?.result, null);
  assert.equal(legacyExecution?.triggerContext, null);
  const detail = activityRunDetailView(activity, [undefined, execution]);
  assert.doesNotMatch(JSON.stringify({ activity, detail }), marker);
  assert.equal(activity.receipt.payload, null);
  assert.equal(detail.run.payloadExpiredAt, NOW.toISOString());
  assert.equal(detail.steps[0]?.output, null);
  assert.equal(detail.steps[0]?.outputExpired, true);
  const list = await database.listProjectActivityRuns(PROJECT, 100);
  assert.equal(list.find(({ run }) => run.id === runId(1))?.webhookActor, undefined);
  assert.equal(list.find(({ run }) => run.id === runId(2))?.webhookActor, "raw-sentinel-actor");
  const live = await database.findProjectActivityRun(PROJECT, runId(2));
  assert.ok(live);
  assert.match(JSON.stringify(live), /raw-sentinel-receipt/u);
}

async function seedCompletedExecutionOutput(runtime: QueryHandle) {
  await runtime.query(
    "insert into agent_sessions (id, organization_id, project_id, data) values ($1, $2, $3, '{}')",
    [SESSION, ORG, PROJECT],
  );
  await runtime.query(
    "update agent_executions set agent_session_id = $2, output_delivery_attempts = $3, deadline_at = $4 where id = $1",
    [
      EXECUTION,
      SESSION,
      {
        [COMPLETED_ATTEMPT]: {
          id: COMPLETED_ATTEMPT,
          outputType: "reply",
          status: "succeeded",
          startedAt: OLD,
          leaseExpiresAt: NOW.toISOString(),
          completedAt: OLD,
        },
      },
      NOW,
    ],
  );
}

function assertProjectedExecution(execution: AgentExecutionRecord | undefined) {
  assert.equal(execution?.id, EXECUTION);
  assert.equal(execution?.status, "succeeded");
  assert.deepEqual(execution?.deadlineAt, NOW);
  assert.equal(execution?.result, null);
  assert.equal(execution?.triggerContext, null);
  assert.equal(execution?.outputContext, null);
}

async function assertProtectedExecutionReaders(database: Database, runtime: QueryHandle) {
  const raw = await runtime.query(
    "select result, trigger_context, output_context from agent_executions where id = $1",
    [EXECUTION],
  );
  assert.match(JSON.stringify(raw.rows), /raw-sentinel-result/u);
  const sessionExecutions = await database.listAgentSessionExecutions(SESSION);
  assert.equal(sessionExecutions.length, 1);
  assertProjectedExecution(sessionExecutions[0]);
  assertProjectedExecution(
    await database.completeAgentExecutionOutput(EXECUTION, COMPLETED_ATTEMPT, NOW),
  );
  assertProjectedExecution(await database.setAgentExecutionIdleDeadline(EXECUTION, NOW, NOW, NOW));
  assertProjectedExecution(
    await database.recordAgentExecutionHubAcknowledgement(EXECUTION, {
      kind: "terminal",
      observedAt: NOW,
    }),
  );
  await enrollTestDaemon(database, ORG);
  assertProjectedExecution(
    await database.attachAgentToExecution(EXECUTION, TEST_DAEMON_ID, "agent"),
  );
}

async function drain(retention: RunPayloadRetention) {
  for (let index = 0; index < 12; index++) {
    const result = await retention.runBatch(NOW);
    if (result.complete) return result;
  }
  throw new Error("expiry did not finish");
}

type TerminalClaim = NonNullable<
  Awaited<ReturnType<Database["claimPendingWorkflowRunTerminalNotification"]>>
>;
type RetentionRuntime = Parameters<typeof createDatabase>[0];
type RetentionLocks = Parameters<typeof createDatabase>[1];

async function assertFencedWrites(database: Database, first: TerminalClaim, second: TerminalClaim) {
  assert.equal(
    await database.setWorkflowScriptStepOutput(STEP, { text: "raw-sentinel-late-cleanup" }),
    undefined,
  );
  assert.equal(
    (
      await database.updateWorkflowScriptStep(STEP, {
        status: "succeeded",
        at: NOW,
        output: { text: "raw-sentinel-late-step" },
      })
    )?.output,
    null,
  );
  assert.equal(
    await database.acquireRunProgressLease({
      triggerRunId: first.id,
      organizationId: ORG,
      now: NOW,
      owner: "stale",
    }),
    undefined,
  );
  assert.deepEqual(
    await database.appendRunTimelineEvent({
      triggerRunId: first.id,
      organizationId: ORG,
      kind: "turn_started",
      at: NOW,
      origin: "captured",
      data: {},
    }),
    { reason: "expired" },
  );
  await database.markWorkflowRunTerminalNotificationDelivered(
    second.id,
    second.terminalNotificationGeneration,
    NOW,
    { late: "raw-sentinel-sender" },
  );
  const replay = await database.createAcceptedTriggerRun({
    organizationId: ORG,
    projectId: PROJECT,
    configurationRevisionId: REVISION,
    providerEventReceiptId: RECEIPT,
    configuredTriggerName: "workflow-eligible",
    prompt: "raw-sentinel-replay",
    inputs: {},
    triggerContext: {},
    outputContext: {},
    deadlineAt: NOW,
    stepIds: ["must-not-insert"],
    createdAt: NOW,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, first.id);
  assert.equal((await database.listWorkflowStepRunsForTriggerRun(first.id)).length, 54);
}

async function resumeExpiry(runtime: RetentionRuntime, locks: RetentionLocks, firstId: string) {
  const replanned = { mode: "on" as const, retentionDays: 30, maxRunsPerPass: 50 };
  const restarted = createDatabase(runtime, locks);
  const resumed = new RunPayloadRetention(restarted, {
    ...replanned,
    retentionDays: 365,
    maxRunsPerPass: 1,
  });
  assert.equal((await drain(resumed)).expired, 1);
  assert.equal((await drain(new RunPayloadRetention(restarted, replanned))).expired, 1);
  const stored = await runtime.query(
    `select to_jsonb(run) as run,
    (select jsonb_agg(step) from workflow_step_runs step where step.trigger_run_id = run.id) as steps,
    (select jsonb_agg(execution order by execution.id) from agent_executions execution where id in ($2, $3)) as executions
   from trigger_runs run where run.id = $1`,
    [firstId, EXECUTION, LEGACY_EXECUTION],
  );
  assert.doesNotMatch(JSON.stringify(stored.rows), marker);
  assert.match(JSON.stringify(stored.rows), /launch-intent-kept.*legacy-intent-kept/u);
  return restarted;
}

async function assertFinishedSummaries(restarted: Database, firstId: string) {
  const finished = await restarted.findTriggerRunById(firstId);
  assert.equal(finished?.payloadExpiryState, "expired");
  assert.equal(finished?.payloadSummary?.timelineCounts?.events, 1);
  assert.equal(
    finished?.payloadSummary?.progress.link,
    "https://github.com/owner/repo/issues/9#issuecomment-8",
  );
}

async function assertStepSummaries(restarted: Database) {
  const step = await restarted.findWorkflowStepRunById(STEP);
  assert.equal(step?.payloadSummary?.exitCode, 7);
  assert.equal(step?.payloadSummary?.truncated, true);
  assert.equal(
    (await restarted.findWorkflowStepRunById(AGENT_STEP))?.payloadSummary?.model,
    "gpt-5",
  );
}

async function assertExecutionCompletions(restarted: Database) {
  assert.equal(
    (await restarted.findAgentExecutionById(EXECUTION))?.payloadCompletion,
    "inferred_from_turn_end",
  );
  assert.equal(
    (await restarted.findAgentExecutionById(LEGACY_EXECUTION))?.payloadCompletion,
    "explicit_finish",
  );
}

async function assertRejectedAndBlocked(
  runtime: RetentionRuntime,
  restarted: Database,
  firstId: string,
) {
  const rejected = await restarted.findTriggerRunById(runId(12));
  assert.ok(rejected?.outcome === "rejected");
  assert.deepEqual(rejected.rejection, {
    code: "invalid_choice",
    inputName: "value",
    value: null,
    choices: [],
  });
  const blocked = await runtime.query(
    `select id, prompt, payload_expired_at from trigger_runs
  where id <> $1 and id <> $2 order by id`,
    [firstId, runId(12)],
  );
  assert.equal(blocked.rowCount, 12);
  assert.ok(
    blocked.rows.every(
      (row) => row["payload_expired_at"] === null && row["prompt"] === "raw-sentinel-prompt",
    ),
  );
}

describe("run payload expiry", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it.each(["embedded", "postgres"])(
    "%s fences reads and resumes bounded redaction",
    async (driver) => {
      const directory = await mkdtemp(join(tmpdir(), "hub-run-payload-"));
      const { runtime, locks } =
        driver === "embedded"
          ? await embeddedDatabaseRuntime(directory)
          : await createPostgresTestRuntime(postgres.getConnectionUri());
      try {
        await runtime.migrate();
        await seed(runtime);
        await seedCompletedExecutionOutput(runtime);
        const database = createDatabase(runtime, locks);
        const first = await database.claimPendingWorkflowRunTerminalNotification(new Date(OLD), 1);
        assert.ok(first);
        assert.equal(first.id, runId(1));
        assert.equal(await database.expireRunPayloadChunk(first.id, CUTOFF, NOW), "skipped");
        const second = await database.claimPendingWorkflowRunTerminalNotification(NOW, 10);
        assert.ok(second);
        assert.equal(second.id, first.id);
        assert.equal(
          await database.ownsWorkflowRunTerminalNotification(
            first.id,
            first.terminalNotificationGeneration,
            NOW,
          ),
          false,
        );
        await database.markWorkflowRunTerminalNotificationDelivered(
          first.id,
          first.terminalNotificationGeneration,
          NOW,
          { late: "raw-sentinel-sender" },
        );
        assert.equal((await database.findTriggerRunById(first.id))?.status, "failed");
        await database.markWorkflowRunTerminalNotificationDelivered(
          second.id,
          second.terminalNotificationGeneration,
          NOW,
          { phase: "kept" },
        );
        await database.appendRunTimelineEvent({
          triggerRunId: first.id,
          organizationId: ORG,
          kind: "turn_started",
          at: new Date(OLD),
          origin: "captured",
          data: {},
        });
        const countSettings = { mode: "count" as const, retentionDays: 30, maxRunsPerPass: 50 };
        const initial = await drain(new RunPayloadRetention(database, countSettings));
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(initial.counts).map(([key, value]) => [key, value.count]),
          ),
          {
            eligible: 2,
            live: 5,
            not_old_enough: 2,
            missing_completion: 1,
            cleanup_blocked: 1,
            notification_pending: 1,
            reporter_pending: 1,
            fan_out_unresolved: 1,
          },
        );
        const replanned = { mode: "on" as const, retentionDays: 30, maxRunsPerPass: 50 };
        const firstWorker = new RunPayloadRetention(database, replanned);
        assert.equal((await firstWorker.runBatch(NOW)).complete, false);
        assert.equal((await database.findTriggerRunById(first.id))?.payloadExpiryState, "expiring");
        await assertProtectedReads(database);
        await assertProtectedExecutionReaders(database, runtime);
        await assertFencedWrites(database, first, second);
        const restarted = await resumeExpiry(runtime, locks, first.id);
        await assertFinishedSummaries(restarted, first.id);
        await assertStepSummaries(restarted);
        await assertExecutionCompletions(restarted);
        await assertRejectedAndBlocked(runtime, restarted, first.id);
        await assertProtectedReads(restarted);
      } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
  it("uses a bounded first PostgreSQL candidate page on a populated database", async () => {
    const admin = await createPostgresTestRuntime(postgres.getConnectionUri());
    try {
      await admin.runtime.query("create database payload_plan");
    } finally {
      await admin.runtime.close();
    }
    const url = new URL(postgres.getConnectionUri());
    url.pathname = "/payload_plan";
    const { runtime } = await createPostgresTestRuntime(url.toString());
    try {
      await seed(runtime);
      await runtime.query(
        `insert into trigger_runs (organization_id, project_id, configuration_revision_id,
        provider_event_receipt_id, configured_trigger_name, status, completed_at, prompt, deadline_at)
        select f.organization_id, f.project_id, f.configuration_revision_id, f.provider_event_receipt_id,
          'plan-' || n, 'succeeded', case when n % 10 = 0 then $2::timestamptz else $3::timestamptz end,
          '', $3 from trigger_runs f cross join generate_series(1, 12000) n where f.id = $1`,
        [runId(1), new Date(OLD), NOW],
      );
      await runtime.query("analyze trigger_runs");
      const plan: string[] = [];
      const explained: QueryHandle = {
        async query<Row extends QueryRow>(sql: string, params?: readonly unknown[]) {
          const result = await runtime.query<{ "QUERY PLAN": string }>(
            `explain (analyze, buffers, timing off) ${sql}`,
            params,
          );
          for (const row of result.rows) plan.push(row["QUERY PLAN"]);
          return runtime.query<Row>(sql, params);
        },
      };
      const first = await scanRunPayloads(explained, null, CUTOFF, 50, false);
      assert.equal(first.length, 50);
      const second = await scanRunPayloads(explained, first.at(-1)!.id, CUTOFF, 50, false);
      assert.equal(second.length, 50);
      assert.ok(second[0]!.id > first.at(-1)!.id);
      assert.ok(plan.some((line) => line.includes("trigger_runs_pkey")));
      assert.ok(plan.some((line) => /Limit .*actual rows=50 loops=1/u.test(line)));
      const metrics = plan.filter((line) => /Index Scan.*trigger_runs|Execution Time/u.test(line));
      process.stdout.write(`Payload scan plan (12,000 seeded runs):
${metrics.join("\n")}
`);
    } finally {
      await runtime.close();
    }
  }, 120_000);
});

it("serializes a script cleanup write and run expiry in both orders on separate PostgreSQL connections", async () => {
  const harness = await createTimelinePostgresHarness();
  const operations: Promise<unknown>[] = [];
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const run = await harness.createRun();
    const step = await harness.database.findWorkflowStepRunByTriggerRun(run.id);
    assert.ok(step);
    await harness.database.failWorkflowRun(run.id, "failed", "failure");
    await harness.runtime.query(
      `update trigger_runs set completed_at = $2, terminal_notification_delivered_at = $2 where id = $1`,
      [run.id, new Date(OLD)],
    );
    assert.ok(
      await harness.database.setWorkflowScriptStepOutput(step.id, {
        exit_code: 1,
        output_tail: "raw-sentinel-cleanup-race",
        truncated: false,
        cleanup: { daemon_id: "daemon", name: "script", cwd: "/tmp" },
      }),
    );
    assert.equal(await harness.database.expireRunPayloadChunk(run.id, CUTOFF, NOW), "skipped");
    assert.equal((await harness.database.findWorkflowStepRunById(step.id))?.output !== null, true);
    assert.ok(
      await harness.database.setWorkflowScriptStepOutput(step.id, {
        exit_code: 1,
        output_tail: "raw-sentinel-cleanup-race",
        truncated: false,
      }),
    );

    const expiry = await harness.connect({
      afterQuery: async (sql) => {
        if (!sql.includes("payload_expiry_state is distinct from 'expired' for update skip locked"))
          return;
        locked.resolve();
        await release.promise;
      },
    });
    const writer = await harness.connect();
    const expiring = expiry.database.expireRunPayloadChunk(run.id, CUTOFF, NOW);
    operations.push(expiring);
    await Promise.race([
      locked.promise,
      expiring.then(() => {
        throw new Error("expiry did not lock the run");
      }),
    ]);
    const writing = writer.database.setWorkflowScriptStepOutput(step.id, {
      body: "raw-sentinel-late-cleanup",
    });
    operations.push(writing);
    assert.equal(await harness.waitForLockOrRead(writer.pid), "blocked");
    release.resolve();
    assert.equal(await expiring, "expiring");
    assert.equal(await writing, undefined);
    assert.equal((await writer.database.findWorkflowStepRunById(step.id))?.output, null);
  } finally {
    release.resolve();
    await Promise.allSettled(operations);
    await harness.close();
  }
}, 120_000);
