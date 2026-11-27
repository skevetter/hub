import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { AgentSessions } from "../agent-sessions/index.js";
import {
  build14Selection,
  credentialHistories,
  upgradedSelection,
  type CredentialHistory,
} from "../agent-sessions/credential-test-fixtures.js";
import type { AgentSessionRecord } from "../agent-sessions/types.js";
import { TestAgents } from "../agent-sessions/test-utils.js";
import { createDatabase } from "../db/pg.js";
import {
  postgresDatabaseRuntime,
  type DatabaseRuntime,
  type QueryHandle,
  type QueryRow,
} from "../db/runtime/index.js";
import type { Database } from "../db/types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { OutputExecutorRegistry, replyOutputTool } from "../execution-capabilities/outputs.js";
import { createExecutionCapabilityServer } from "../execution-capabilities/server.js";
import { RunPayloadRetention } from "./index.js";

const NOW = new Date("2026-11-18T00:00:00Z");
const CUTOFF = new Date("2026-10-19T00:00:00Z");
const OLD = new Date("2026-10-10T00:00:00Z");
const ORG = "launch-expiry";
const PROJECT = "00000000-0000-4000-8000-100000000001";
const REVISION = "00000000-0000-4000-8000-200000000001";
const DAEMON = "00000000-0000-4000-8000-300000000001";
const MACHINE = "00000000-0000-4000-8000-400000000001";
const LAUNCH_MARKERS = [
  "launch-prompt",
  "launch-title",
  "launch-env",
  "launch-trigger",
  "launch-output",
  "launch-config",
];
const SESSION_MARKERS = ["session-title", "session-env", "session-provider"];
const KEEP_MARKERS = [
  "machine-context",
  "machine-specs",
  "machine-shutdown",
  "unbound-title",
  "unknown-launch",
];
const settings = { mode: "on", retentionDays: 30, maxRunsPerPass: 50 } as const;

async function drain(retention: RunPayloadRetention) {
  for (let batch = 0; batch < 100; batch++) {
    const result = await retention.runBatch(NOW);
    if (result.complete) return result;
  }
  throw new Error("Sweep did not finish");
}

async function seed(runtime: QueryHandle) {
  for (const sql of [
    `insert into organization (id, name, slug) values ('${ORG}', 'Launch', '${ORG}')`,
    `insert into projects (id, organization_id, name, slug) values ('${PROJECT}', '${ORG}', 'Launch', 'launch')`,
    `insert into project_configuration_revisions
      (id, project_id, organization_id, version, source_kind, source_evidence, normalized_configuration, content_hash)
      values ('${REVISION}', '${PROJECT}', '${ORG}', 1, 'manual', '{}', '{}', 'launch')`,
    `insert into machines (id, org_id, source, status) values ('${MACHINE}', '${ORG}', '{"kind":"manual"}', 'alive')`,
    `insert into daemons (id, slug, machine_id, organization_id, server_id, daemon_public_key,
        credential_verifier, status, idempotency_key, enrollment_verifier, scopes)
      values ('${DAEMON}', 'fixture', '${MACHINE}', '${ORG}', 'fixture', 'public', 'verifier',
        'active', 'fixture', 'fixture', '[]')`,
    `insert into machines (org_id, source, status, started_at, terminated_at, trigger_context, specs, shutdown_reason)
      values ('${ORG}', '{"kind":"manual"}', 'terminated', '${OLD.toISOString()}', '${OLD.toISOString()}',
        '{"body":"machine-context"}', '{"body":"machine-specs"}', 'machine-shutdown')`,
  ])
    await runtime.query(sql);
}

async function seedReceiptStages(runtime: QueryHandle) {
  await runtime.query(
    `insert into provider_event_receipts (organization_id, provider, source, delivery_id,
        payload, received_at, connection_id, dropped_reason, pre_routing_drop)
      values ($1,'github','github.unknown','drop-delivery','{"body":"old-dropped-body"}',
        $2, $3,'no_trigger_for_source','no_trigger_for_source'),
        ($1,'github','github.unknown','pending-delivery','{"body":"pending-drop-body"}',
        $2, $3,null,null)`,
    [ORG, OLD, DAEMON],
  );
  await runtime.query(
    `insert into github_installation_syncs
       (kind, provider_application_id, installation_id, delivery_id, signature_hash,
        source, payload, received_at, retry_at, settled_at, audit_link)
     values ('webhook','app',1,'old-sync','old-signature','github.installation',
         '{"body":"old-sync-body"}',$1,null,$1,'{"kind":"none"}'),
       ('webhook','app',2,'pending-sync','pending-signature','github.installation',
         '{"body":"pending-sync-body"}',$1,$1,null,null)`,
    [OLD],
  );
  await runtime.query(
    `insert into github_notification_cursors
       (source, since, next_poll_at, last_error, last_error_at)
     values ('old-cursor',$1,$2,'old-cursor-body',$1),
       ('recent-cursor',$1,$2,'recent-cursor-body',$2)`,
    [OLD, NOW],
  );
}

async function migrateToBuild14(runtime: DatabaseRuntime) {
  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" }).slice(0, 58);
  await runtime.transaction(async (client) => {
    await client.query("create schema drizzle");
    await client.query(
      "create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)",
    );
    for (const migration of migrations) {
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query(
        "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
        [migration.hash, migration.folderMillis],
      );
    }
  });
}

async function newRun(runtime: QueryHandle) {
  const receipt = randomUUID();
  const id = randomUUID();
  await runtime.query(
    `insert into provider_event_receipts (id, organization_id, provider, delivery_id, source, payload)
      values ($1, $2, 'manual', $1::uuid::text, 'webhook.received', '{}')`,
    [receipt, ORG],
  );
  await runtime.query(
    `insert into trigger_runs (
      id, organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
      configured_trigger_name, status, created_at, prompt, deadline_at
    ) values ($1, $2, $3, $4, $5, 'fixture', 'running', $6, '', $7)`,
    [id, ORG, PROJECT, REVISION, receipt, OLD, NOW],
  );
  return id;
}

function arrivals(database: Database) {
  const connection = new TestAgents();
  const outputs = new OutputExecutorRegistry();
  const replies: unknown[] = [];
  outputs.register({
    type: "test.reply",
    tool: replyOutputTool,
    execute: async (input) => {
      replies.push(input.outputContext);
    },
  });
  const sessions = new AgentSessions(database, "fixture-secret", "https://hub.test", {
    outputs,
    now: () => OLD.getTime(),
  });
  const mcp = createExecutionCapabilityServer({
    database,
    outputs,
    completionTokenSecret: "fixture-secret",
    completeExecution: async ({ executionId }) =>
      (await database.transitionAgentExecution(executionId, "succeeded")).execution,
  });
  async function arrival(
    options: {
      runId?: string;
      key?: string;
      label?: string;
      credentialed?: boolean;
      step?: string;
    } = {},
  ) {
    const id = randomUUID();
    const label = options.label ?? "session";
    const intent: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId: ORG,
      projectId: PROJECT,
      configurationRevisionId: REVISION,
      triggerRunId: options.runId ?? randomUUID(),
      triggerName: "fixture",
      environmentName: "fixture",
      environment: { kind: "daemon", daemonId: DAEMON, authoredSlug: "fixture", cwd: "/repo" },
      agent: { provider: "codex", model: "gpt-5" },
      continuation: { key: options.key ?? "same-key", compatibility: "fixture" },
      allowOutputs: [{ type: "test.reply", max: 1 }],
      background: false,
      autoArchive: true,
      prompt: "launch-prompt",
      title: "launch-title",
      env: {
        BODY: "launch-env",
        ...(options.credentialed ? { TOKEN: "${{ paseo.connections.installation.token }}" } : {}),
      },
      triggerContext: { body: "launch-trigger" },
      outputContext: { body: "launch-output", executionId: id },
      hubConfig: { body: "launch-config" },
    };
    const storedIntent = { ...intent };
    if (options.runId === undefined) Reflect.deleteProperty(storedIntent, "triggerRunId");
    await database.insertAgentExecution({
      id,
      organizationId: ORG,
      projectId: PROJECT,
      configurationRevisionId: REVISION,
      machineId: MACHINE,
      daemonId: DAEMON,
      startedAt: OLD,
      triggerContext: {},
      outputContext: intent.outputContext,
      launchIntent: storedIntent,
      ...(options.step === undefined ? {} : { workflowStepRunId: options.step }),
    });
    return {
      id,
      dispatch: () =>
        sessions.dispatch({
          executionId: id,
          intent,
          connection,
          onEvent: () => {},
          createOptions: async () => ({
            provider: "codex",
            model: "gpt-5",
            cwd: "/repo",
            workspaceTitle: label + "-title",
            env: { BODY: label + "-env" },
            providerOptions: { text: label + "-provider" },
            toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "reply" }] },
          }),
        }),
      finish: async (runtime: QueryHandle) => {
        const { execution } = await database.transitionAgentExecution(id, "succeeded");
        assert.ok(execution.agentSessionId);
        await runtime.query("update agent_executions set completed_at = $2 where id = $1", [
          id,
          OLD,
        ]);
        const session = await database.findAgentSession(execution.agentSessionId);
        assert.ok(session);
        return { execution, session };
      },
    };
  }
  return { arrival, connection, sessions, mcp, replies };
}

async function tableHashes(runtime: QueryHandle) {
  const { rows } = await runtime.query<{ tablename: string; schemaname: string }>(
    `select schemaname, tablename from pg_tables
     where schemaname in ('public','drizzle') order by schemaname, tablename`,
  );
  const hashes = new Map<string, string>();
  for (const { tablename, schemaname } of rows) {
    assert.match(tablename, /^[a-z0-9_]+$/u);
    assert.match(schemaname, /^[a-z0-9_]+$/u);
    const name = `"${schemaname}"."${tablename}"`;
    const { rows: values } = await runtime.query<{ hash: string }>(
      `select md5(coalesce(string_agg(row.xmin::text || row::text, ',' order by row::text), '')) as hash from ${name} row`,
    );
    hashes.set(name, values[0]!.hash);
  }
  return hashes;
}

function interceptTransaction(
  database: DatabaseRuntime,
  afterQuery: (statement: string) => Promise<void>,
): DatabaseRuntime {
  return {
    query: database.query.bind(database),
    drizzle: database.drizzle.bind(database),
    migrate: database.migrate.bind(database),
    close: database.close.bind(database),
    transaction: (operation) =>
      database.transaction((transaction) =>
        operation({
          drizzle: transaction.drizzle.bind(transaction),
          rollback: transaction.rollback.bind(transaction),
          async query<Row extends QueryRow>(statement: string, params?: readonly unknown[]) {
            const result = await transaction.query<Row>(statement, params);
            await afterQuery(statement);
            return result;
          },
        }),
      ),
  };
}

function pauseAfter(runtime: DatabaseRuntime, matches: (statement: string) => boolean) {
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const database = interceptTransaction(runtime, async (statement) => {
    if (!matches(statement)) return;
    held.resolve();
    await release.promise;
  });
  return { database, held: held.promise, release: release.resolve };
}

async function seedCredentialHistory(runtime: QueryHandle, history: CredentialHistory) {
  const ids = history.intents
    .map(() => randomUUID())
    .sort((left, right) => left.localeCompare(right));
  const before = [];
  for (const [index, intent] of history.intents.entries()) {
    const result = await runtime.query<{ launch_intent: LaunchMachineIntent | null }>(
      `insert into agent_executions (id, organization_id, project_id, configuration_revision_id,
                status, completed_at, started_at, launch_intent)
             values ($1, $2, $3, $4, 'succeeded', $5, $5, $6::jsonb)
             returning launch_intent`,
      [ids[index], ORG, PROJECT, REVISION, OLD, intent === null ? null : JSON.stringify(intent)],
    );
    before.push(result.rows[0]!.launch_intent);
  }
  assert.equal(build14Selection(before), history.build14, history.key);
  return ids;
}

function assertLaunchAuxiliaryCounts(counted: Awaited<ReturnType<typeof drain>>) {
  assert.equal(counted.auxiliaryCounts.launchIntent.live_owner?.count, 1);
  assert.equal(counted.auxiliaryCounts.launchIntent.flag_unknown?.count, 1);
  assert.equal(counted.auxiliaryCounts.session.eligible?.count, 1);
  assert.equal(counted.auxiliaryCounts.session.unbound_session?.count, 1);
  assert.equal(counted.auxiliaryCounts.session.unused_session?.count, 1);
  assert.deepEqual(counted.auxiliaryCounts.session.incomplete_bootstrap, {
    count: 1,
    oldestAgeMs: NOW.getTime() - OLD.getTime(),
  });
  assert.deepEqual(counted.auxiliaryCounts.machine.machine_legacy, {
    count: 1,
    oldestAgeMs: NOW.getTime() - OLD.getTime(),
  });
}

async function verifyRedactedLaunch(
  database: Database,
  {
    dump,
    name,
    expiredMarkers,
    retainedMarkers,
    session,
    old,
  }: {
    dump: (name: string) => Promise<string>;
    name: string;
    expiredMarkers: string[];
    retainedMarkers: string[];
    session: AgentSessionRecord;
    old: { id: string };
  },
) {
  const after = await dump(name);
  for (const marker of expiredMarkers) assert.ok(!after.includes(marker), marker);
  for (const marker of retainedMarkers) assert.ok(after.includes(marker), marker);
  const reduced = await database.findAgentSession(session.id);
  assert.ok(reduced?.optionsReducedAt);
  assert.deepEqual(reduced.creationOptions, {
    provider: "codex",
    model: "gpt-5",
    toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "reply" }] },
  });
  const execution = await database.findAgentExecutionById(old.id);
  assert.equal(execution?.launchIntent, null);
  assert.equal(execution.usedTemporaryCredentials, true);
  assert.deepEqual(execution.launchAgent, { provider: "codex", model: "gpt-5" });
  assert.equal(execution.outputContext, null);
}

describe("launch and session expiry in PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  async function freshDatabase(
    migrate: (runtime: DatabaseRuntime) => Promise<void> = (runtime) => runtime.migrate(),
  ) {
    const name = "launch_" + randomUUID().replaceAll("-", "");
    const created = await postgres.exec(["createdb", "-U", postgres.getUsername(), name]);
    assert.equal(created.exitCode, 0, created.output);
    const url = new URL(postgres.getConnectionUri());
    url.pathname = "/" + name;
    const bundle = await postgresDatabaseRuntime(url.toString());
    await migrate(bundle.runtime);
    await seed(bundle.runtime);
    return {
      ...bundle,
      database: createDatabase(bundle.runtime, bundle.locks),
      name,
      url: url.toString(),
    };
  }

  async function dump(name: string) {
    const result = await postgres.exec([
      "pg_dump",
      "-U",
      postgres.getUsername(),
      "--data-only",
      name,
    ]);
    assert.equal(result.exitCode, 0, result.output);
    return result.output;
  }

  it("preserves credential selection across migration, backfill and launch redaction", async () => {
    const { runtime, database, url } = await freshDatabase(migrateToBuild14);
    try {
      const cases = [];
      for (const history of credentialHistories) {
        const ids = await seedCredentialHistory(runtime, history);
        cases.push({ history, ids });
      }

      await runtime.migrate();
      const fixture = arrivals(database);
      const sessions = [];
      for (const { history, ids } of cases) {
        const actual = await Promise.all(ids.map((id) => database.findAgentExecutionById(id)));
        assert.deepEqual(
          actual.map((execution) => execution?.usedTemporaryCredentials),
          history.migrated,
          history.key,
        );
        const starter = await fixture.arrival({ key: history.key });
        await starter.dispatch();
        const { session } = await starter.finish(runtime);
        for (const id of ids) await database.attachExecutionToSession(id, session.id, "created");
        await runtime.query("delete from agent_executions where id = $1", [starter.id]);
        sessions.push({ history, ids, session });
      }

      async function checkArrival(
        history: CredentialHistory,
        session: AgentSessionRecord,
        ids: readonly string[],
      ) {
        const { key } = history;
        const historical = await database.listAgentSessionExecutions(session.id);
        assert.deepEqual(
          historical.map(({ id }) => id),
          ids,
          key,
        );
        const next = await fixture.arrival({ key });
        const expected = upgradedSelection(history);
        const selected = await next.dispatch();
        assert.equal(selected.action, expected, key);
        assert.equal(selected.agentId === session.agentId, expected === "continued", key);
        const attached = (await database.findAgentExecutionById(next.id))?.agentSessionId;
        await runtime.query("delete from agent_executions where id = $1", [next.id]);
        if (attached != null && attached !== session.id) {
          await runtime.query("delete from agent_sessions where id = $1", [attached]);
          await runtime.query(
            `update agent_sessions set continuation_key = $2,
              data = jsonb_set(data, '{continuationKey}', to_jsonb($2::text)) where id = $1`,
            [session.id, key],
          );
        }
      }
      for (const { history, session, ids } of sessions) {
        await checkArrival(history, session, ids);
      }

      const credentialRows = () =>
        runtime.query(`select to_jsonb(execution) - 'used_temporary_credentials' as row
          from agent_executions execution order by id`);
      const beforeCredentials = await credentialRows();
      const hashes = await tableHashes(runtime);
      const off = await drain(new RunPayloadRetention(database, { ...settings, mode: "off" }));
      assert.equal(off.credentialFactsBackfilled, 0);
      assert.deepEqual(await tableHashes(runtime), hashes);

      const count = await drain(
        new RunPayloadRetention(database, { ...settings, mode: "count", maxRunsPerPass: 1 }),
      );
      assert.equal(count.credentialFactsBackfilled, 1);
      assert.equal(count.launchIntentsExpired, 0);
      assert.equal(count.sessionsReduced, 0);
      const afterCount = await tableHashes(runtime);
      assert.deepEqual(await credentialRows(), beforeCredentials);
      assert.deepEqual(
        [...afterCount].filter(([name, hash]) => hash !== hashes.get(name)).map(([name]) => name),
        ['"public"."agent_executions"'],
      );
      const unredacted = await runtime.query<{ all_unmarked: boolean }>(
        "select bool_and(launch_intent_expired_at is null) as all_unmarked from agent_executions",
      );
      assert.equal(unredacted.rows[0]?.all_unmarked, true);

      const restarted = await postgresDatabaseRuntime(url);
      try {
        const next = createDatabase(restarted.runtime, restarted.locks);
        const settledCount = await drain(
          new RunPayloadRetention(next, { ...settings, mode: "count" }),
        );
        assert.equal(settledCount.credentialFactsBackfilled, 14);
        assert.equal(settledCount.launchIntentsExpired, 0);
        for (const { history, session, ids } of sessions) {
          const actual = await next.listAgentSessionExecutions(session.id);
          assert.deepEqual(
            actual.map((execution) => execution.usedTemporaryCredentials),
            history.backfilled,
            history.key,
          );
          assert.ok(
            actual.every((execution) => execution.launchIntentExpiredAt == null),
            history.key,
          );
          await checkArrival(history, session, ids);
        }
        const applied = await drain(new RunPayloadRetention(next, settings));
        assert.equal(applied.credentialFactsBackfilled, 0);
        assert.equal(applied.launchIntentsExpired, 21);
        assert.equal(applied.sessionsReduced, 16);
        assert.equal(applied.auxiliaryCounts.launchIntent.flag_unknown?.count, 7);
        for (const { history, session, ids } of sessions) {
          const actual = await Promise.all(ids.map((id) => next.findAgentExecutionById(id)));
          assert.deepEqual(
            actual.map((execution) => execution?.usedTemporaryCredentials),
            history.backfilled,
            history.key,
          );
          assert.deepEqual(
            actual.map((execution) => execution?.launchIntentExpiredAt != null),
            history.backfilled.map((fact) => fact !== null),
            history.key,
          );
          await checkArrival(history, session, ids);
        }
      } finally {
        await restarted.runtime.close();
      }
    } finally {
      await runtime.close();
    }
  }, 120_000);

  it("counts without writes and removes only eligible markers from a full dump", async () => {
    const { runtime, database, name } = await freshDatabase();
    try {
      const run = await newRun(runtime);
      const fixture = arrivals(database);
      const old = await fixture.arrival({ runId: run, credentialed: true });
      await old.dispatch();
      const { session } = await old.finish(runtime);
      const mcpOptions = fixture.connection.creates[0]?.mcpServers?.["hub"];
      assert.ok(mcpOptions?.headers?.["Authorization"]);
      const bearer = mcpOptions.headers["Authorization"];
      const unbound = {
        ...session,
        id: randomUUID(),
        continuationKey: "unbound",
        agentId: null,
        workspaceId: null,
        creationOptions: {
          provider: "codex",
          cwd: "/repo",
          env: {},
          workspaceTitle: "unbound-title",
        },
      };
      assert.ok(session.optionsReducedAt == null);
      await database.saveAgentSession({ ...unbound, optionsReducedAt: null });
      const unused = {
        ...session,
        id: randomUUID(),
        continuationKey: "unused",
        creationOptions: {
          provider: "codex",
          cwd: "/repo",
          env: {},
          workspaceTitle: "unused-title",
        },
      };
      const incomplete = {
        ...unused,
        id: randomUUID(),
        continuationKey: "incomplete",
        creationOptions: { ...unused.creationOptions, workspaceTitle: "incomplete-title" },
      };
      await database.saveAgentSession(unused);
      await database.saveAgentSession(incomplete);
      await runtime.query(
        `insert into agent_executions
          (organization_id, project_id, configuration_revision_id, status, completed_at,
           agent_session_id, used_temporary_credentials)
          values ($1, $2, $3, 'failed', $4, $5, false)`,
        [ORG, PROJECT, REVISION, OLD, incomplete.id],
      );
      await runtime.query(
        `insert into agent_executions
          (organization_id, project_id, configuration_revision_id, status, completed_at, launch_intent)
          values ($1, $2, $3, 'succeeded', $4, '{"prompt":"unknown-launch"}')`,
        [ORG, PROJECT, REVISION, OLD],
      );
      await runtime.query(
        "update trigger_runs set status = 'succeeded', completed_at = $2 where id = $1",
        [run, OLD],
      );
      await seedReceiptStages(runtime);
      const expiredMarkers = [
        ...LAUNCH_MARKERS,
        ...SESSION_MARKERS,
        bearer,
        "old-dropped-body",
        "old-sync-body",
        "old-cursor-body",
      ];
      const retainedMarkers = [
        ...KEEP_MARKERS,
        "pending-drop-body",
        "pending-sync-body",
        "recent-cursor-body",
        "drop-delivery",
        "old-signature",
      ];
      const before = await dump(name);
      for (const marker of [...expiredMarkers, ...retainedMarkers])
        assert.ok(before.includes(marker), marker);
      const hashes = await tableHashes(runtime);
      const counted = await drain(
        new RunPayloadRetention(database, { ...settings, mode: "count" }),
      );
      assertLaunchAuxiliaryCounts(counted);
      assert.deepEqual(await tableHashes(runtime), hashes);
      const applied = await drain(new RunPayloadRetention(database, settings));
      assert.equal(applied.expired, 1);
      assert.equal(applied.launchIntentsExpired, 1);
      assert.equal(applied.sessionsReduced, 1);
      assert.equal(applied.auxiliaryCounts.machine.machine_legacy, undefined);
      assert.deepEqual(applied.receiptCounts, counted.receiptCounts);
      assert.equal(applied.receiptApply.receipt.applied, 1);
      assert.equal(applied.receiptApply.installationSync.applied, 1);
      assert.equal(applied.receiptApply.cursorDiagnostic.applied, 1);
      assert.equal((await database.findAgentExecutionById(old.id))?.launchRunId, run);
      assert.equal((await database.findAgentSession(incomplete.id))?.optionsReducedAt, null);
      assert.equal((await database.findAgentSession(unused.id))?.optionsReducedAt, null);
      await database.saveAgentSession(session);
      await verifyRedactedLaunch(database, {
        dump,
        name,
        expiredMarkers,
        retainedMarkers,
        session,
        old,
      });
      const newer = await fixture.arrival({ credentialed: true, label: "rotated" });
      assert.equal((await newer.dispatch()).action, "created");
      assert.equal(fixture.connection.creates.length, 2);
      assert.equal((await database.findAgentSession(session.id))?.continuationKey, null);
    } finally {
      await runtime.close();
    }
  });

  it("rolls back both option copies on interruption and completes once across two sweepers", async () => {
    const { runtime, locks, database, url } = await freshDatabase();
    const fixture = arrivals(database);
    const old = await fixture.arrival();
    const original = await old.dispatch();
    const { session } = await old.finish(runtime);
    const interrupted = interceptTransaction(runtime, async (statement) => {
      if (statement.includes("set creation_options")) throw new Error("interrupted reduction");
    });
    try {
      await assert.rejects(
        drain(new RunPayloadRetention(createDatabase(interrupted, locks), settings)),
        /interrupted reduction/u,
      );
      const during = await database.findAgentSession(session.id);
      assert.equal(during?.optionsReducedAt, null);
      assert.match(JSON.stringify(during?.creationOptions), /session-title/u);
      assert.equal((await database.findAgentExecutionById(old.id))?.launchIntent, null);
    } finally {
      await runtime.close();
    }
    const workers = await Promise.all([postgresDatabaseRuntime(url), postgresDatabaseRuntime(url)]);
    try {
      const firstWorker = workers[0];
      const restarted = createDatabase(firstWorker.runtime, firstWorker.locks);
      const standalone = await arrivals(restarted).arrival({ label: "other" });
      await restarted.transitionAgentExecution(standalone.id, "failed");
      await firstWorker.runtime.query(
        "update agent_executions set completed_at = $2 where id = $1",
        [standalone.id, OLD],
      );
      const reports = await Promise.all(
        workers.map(({ runtime: worker, locks: workerLocks }) =>
          drain(new RunPayloadRetention(createDatabase(worker, workerLocks), settings)),
        ),
      );
      assert.equal(reports[0]!.sessionsReduced + reports[1]!.sessionsReduced, 1);
      assert.equal(reports[0]!.launchIntentsExpired + reports[1]!.launchIntentsExpired, 1);
      assert.equal((await restarted.findAgentExecutionById(standalone.id))?.launchIntent, null);
      const reduced = await restarted.findAgentSession(session.id);
      assert.equal(reduced?.agentId, original.agentId);
      assert.ok(reduced?.optionsReducedAt);
      const copies = await firstWorker.runtime.query(
        "select creation_options = data -> 'creationOptions' as equal from agent_sessions where id = $1",
        [session.id],
      );
      assert.equal(copies.rows[0]?.["equal"], true);
    } finally {
      await Promise.all(workers.map(({ runtime: worker }) => worker.close()));
    }
  });

  it("retains bootstrap retry options until an unbound session can create its agent", async () => {
    const { runtime, database } = await freshDatabase();
    try {
      const fixture = arrivals(database);
      const first = await fixture.arrival({ label: "unbound" });
      const create = vi
        .spyOn(fixture.connection, "create")
        .mockRejectedValueOnce(new Error("lost create"));
      await assert.rejects(first.dispatch(), /lost create/u);
      const report = await drain(new RunPayloadRetention(database, settings));
      assert.equal(report.auxiliaryCounts.session.unbound_session?.count, 1);
      assert.equal(report.sessionsReduced, 0);
      assert.equal((await first.dispatch()).action, "created");
      assert.deepEqual(create.mock.calls[0]?.[1], create.mock.calls[1]?.[1]);
      assert.equal(create.mock.calls[1]?.[1].workspaceTitle, "unbound-title");
    } finally {
      await runtime.close();
    }
  });

  it("rotates a cap of one across run, launch, session, receipt, sync and diagnostic expiry", async () => {
    const { runtime, database } = await freshDatabase();
    try {
      const run = await newRun(runtime);
      const first = await arrivals(database).arrival({ runId: run });
      await first.dispatch();
      await first.finish(runtime);
      await runtime.query(
        "update trigger_runs set status = 'succeeded', completed_at = $2 where id = $1",
        [run, OLD],
      );
      await seedReceiptStages(runtime);
      const sweep = new RunPayloadRetention(database, { ...settings, maxRunsPerPass: 1 });
      const totals: number[][] = [];
      for (let pass = 0; pass < 6; pass++) {
        const result = await drain(sweep);
        totals.push([
          result.expired,
          result.launchIntentsExpired,
          result.sessionsReduced,
          result.receiptApply.receipt.applied,
          result.receiptApply.installationSync.applied,
          result.receiptApply.cursorDiagnostic.applied,
        ]);
      }
      assert.deepEqual(totals, [
        [1, 0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 0, 0, 1, 0, 0],
        [0, 0, 0, 0, 1, 0],
        [0, 0, 0, 0, 0, 1],
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("serializes reduction before a same-key restore and preserves session tools and authority", async () => {
    const { runtime, locks, database, url } = await freshDatabase();
    const other = await postgresDatabaseRuntime(url);
    const atReduction = pauseAfter(runtime, (statement) =>
      statement.includes("pg_try_advisory_xact_lock"),
    );
    try {
      const fixture = arrivals(createDatabase(other.runtime, other.locks));
      const first = await fixture.arrival();
      const original = await first.dispatch();
      const { session, execution } = await first.finish(runtime);
      await fixture.sessions.control(execution, fixture.connection, "archive");
      const next = await fixture.arrival({ label: "fresh" });
      const reducing = createDatabase(atReduction.database, locks).reduceSessionOptions(
        session.id,
        CUTOFF,
        NOW,
      );
      await atReduction.held;
      const restoring = next.dispatch();
      try {
        await vi.waitFor(async () => {
          const result = await runtime.query<{ waiting: boolean }>(
            "select exists (select 1 from pg_locks where locktype = 'advisory' and not granted) as waiting",
          );
          assert.equal(result.rows[0]?.waiting, true);
        });
      } finally {
        atReduction.release();
        await Promise.allSettled([reducing, restoring]);
      }
      assert.equal(await reducing, true);
      assert.deepEqual(
        { ...(await restoring), unsubscribe: undefined },
        {
          agentId: original.agentId,
          action: "restored",
          unsubscribe: undefined,
        },
      );
      assert.equal(fixture.connection.restorations, 1);
      assert.equal(fixture.connection.creates.length, 1);
      const options = fixture.connection.creates[0]?.mcpServers?.["hub"];
      assert.ok(options);
      const call = async (method: string, params: object, headers = options.headers) =>
        fixture.mcp.handleSession(
          new Request(options.url, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          }),
          session.id,
        );
      assert.equal(
        (await call("tools/list", {}, { Authorization: "Bearer incorrect" })).status,
        401,
      );
      const list = await call("tools/list", {});
      assert.equal(list.status, 200);
      assert.match(await list.text(), /"name":"reply"/u);
      const reply = await call("tools/call", {
        name: "reply",
        arguments: { executionId: next.id, content: "hello" },
      });
      assert.match(await reply.text(), /Output sent/u);
      assert.deepEqual(fixture.replies, [{ body: "launch-output", executionId: next.id }]);
      const releases: string[] = [];
      const release = async (id: string) => {
        releases.push(id);
      };
      await fixture.sessions.releaseAuthority(execution, release);
      assert.deepEqual(releases, []);
      const finished = await next.finish(runtime);
      await fixture.sessions.releaseAuthority(finished.execution, release);
      assert.equal(releases.length, 2);
      assert.deepEqual(new Set(releases), new Set([first.id, next.id]));
      assert.ok((await database.findAgentSession(session.id))?.optionsReducedAt);
      const later = await fixture.arrival();
      const continued = await later.dispatch();
      assert.equal(continued.agentId, original.agentId);
      assert.equal(continued.action, "continued");
      assert.equal(fixture.connection.creates.length, 1);
    } finally {
      atReduction.release();
      await Promise.all([runtime.close(), other.runtime.close()]);
    }
  });

  it("lets a same-key arrival win and defers reduction while that execution is live", async () => {
    const { runtime, database, url } = await freshDatabase();
    const other = await postgresDatabaseRuntime(url);
    const inSend = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const fixture = arrivals(createDatabase(other.runtime, other.locks));
      const first = await fixture.arrival();
      const original = await first.dispatch();
      const { session } = await first.finish(runtime);
      const send = fixture.connection.send.bind(fixture.connection);
      vi.spyOn(fixture.connection, "send").mockImplementationOnce(async (...args) => {
        inSend.resolve();
        await release.promise;
        await send(...args);
      });
      const next = await fixture.arrival();
      const dispatch = next.dispatch();
      await inSend.promise;
      try {
        assert.equal(await database.reduceSessionOptions(session.id, CUTOFF, NOW), false);
      } finally {
        release.resolve();
        await dispatch;
      }
      const continuing = await dispatch;
      assert.equal(continuing.agentId, original.agentId);
      assert.equal(continuing.action, "continued");
      assert.equal(await database.reduceSessionOptions(session.id, CUTOFF, NOW), false);
      await next.finish(runtime);
      assert.equal(await database.reduceSessionOptions(session.id, CUTOFF, NOW), true);
    } finally {
      release.resolve();
      await Promise.all([runtime.close(), other.runtime.close()]);
    }
  });

  it.each(["completion", "expiry"] as const)(
    "avoids a run completion lock cycle with %s first",
    async (first) => {
      const { runtime, locks, database, url } = await freshDatabase();
      const other = await postgresDatabaseRuntime(url);
      try {
        const run = await newRun(runtime);
        const step = randomUUID();
        await runtime.query(
          `insert into workflow_step_runs (id, trigger_run_id, step_id, ordinal, status, started_at)
           values ($1, $2, 'agent', 0, 'running', $3)`,
          [step, run, OLD],
        );
        const fixture = arrivals(database);
        const old = await fixture.arrival({ runId: run, step });
        await runtime.query("update workflow_step_runs set agent_execution_id = $2 where id = $1", [
          step,
          old.id,
        ]);
        if (first === "completion") {
          await runtime.query(
            "update agent_executions set launch_intent = launch_intent - 'agent' where id = $1",
            [old.id],
          );
          await runtime.query(
            `update workflow_step_runs set dispatch_intent = '{"agent":{"provider":"codex","model":"gpt-5"}}' where id = $1`,
            [step],
          );
        }
        const complete = (owner: Database) =>
          owner.completeWorkflowAgentExecution({
            executionId: old.id,
            executionStatus: "failed",
            stepStatus: "failed",
            observedAt: OLD,
            result: { status: "failed" },
            stepOutput: { status: "failed" },
            hubAction: null,
          });
        assert.equal(await database.expireLaunchIntent(old.id, CUTOFF, NOW), false);
        assert.equal((await complete(database)).transitioned, true);
        await runtime.query(
          "update trigger_runs set terminal_notification_delivered_at = $2 where id = $1",
          [run, OLD],
        );
        for (let chunk = 0; chunk < 8; chunk++) {
          if ((await database.expireRunPayloadChunk(run, CUTOFF, NOW)) === "expired") break;
        }
        assert.equal((await database.findTriggerRunById(run))?.payloadExpiryState, "expired");
        const paused = pauseAfter(runtime, (statement) =>
          first === "completion"
            ? statement.includes("from agent_executions where id = $1 for update")
            : statement.includes("launch_intent is not null") && statement.includes("skip locked"),
        );
        const firstStore = createDatabase(paused.database, locks);
        const secondStore = createDatabase(other.runtime, other.locks);
        if (first === "completion") {
          const completion = complete(firstStore);
          await paused.held;
          try {
            assert.equal(await secondStore.expireLaunchIntent(old.id, CUTOFF, NOW), false);
          } finally {
            paused.release();
            assert.equal((await completion).transitioned, false);
          }
          assert.equal(await secondStore.expireLaunchIntent(old.id, CUTOFF, NOW), true);
        } else {
          const expiry = firstStore.expireLaunchIntent(old.id, CUTOFF, NOW);
          await paused.held;
          const completion = complete(secondStore);
          try {
            await vi.waitFor(async () => {
              const result = await runtime.query<{ waiting: boolean }>(
                "select exists (select 1 from pg_locks where locktype = 'transactionid' and not granted) as waiting",
              );
              assert.equal(result.rows[0]?.waiting, true);
            });
          } finally {
            paused.release();
            await Promise.allSettled([expiry, completion]);
          }
          assert.equal(await expiry, true);
          assert.equal((await completion).transitioned, false);
        }
        assert.equal((await database.findAgentExecutionById(old.id))?.launchIntent, null);
        const runs = await database.listOrganizationRunsSince(ORG, OLD, 10);
        assert.deepEqual(runs[0]?.agent, { provider: "codex", model: "gpt-5" });
      } finally {
        await Promise.all([runtime.close(), other.runtime.close()]);
      }
    },
  );

  it.each(["link", "expiry"] as const)(
    "serializes reverse-only workflow ownership with %s first",
    async (first) => {
      const { runtime, locks, database, url } = await freshDatabase();
      const other = await postgresDatabaseRuntime(url);
      const paused = pauseAfter(runtime, (statement) =>
        first === "link"
          ? statement === "select * from agent_executions where id = $1 for update"
          : statement.includes('owners."runId", execution.launch_intent'),
      );
      const firstStore = createDatabase(paused.database, locks);
      const secondStore = createDatabase(other.runtime, other.locks);
      try {
        const run = await newRun(runtime);
        const step = randomUUID();
        await runtime.query(
          `insert into workflow_step_runs (id, trigger_run_id, step_id, ordinal, status)
           values ($1, $2, 'agent', 0, 'pending')`,
          [step, run],
        );
        const old = await arrivals(database).arrival();
        await database.transitionAgentExecution(old.id, "succeeded");
        await runtime.query("update agent_executions set completed_at = $2 where id = $1", [
          old.id,
          OLD,
        ]);
        if (first === "link") {
          const linking = firstStore.linkWorkflowStepRunExecution(step, old.id);
          await paused.held;
          try {
            assert.equal(await secondStore.expireLaunchIntent(old.id, CUTOFF, NOW), false);
          } finally {
            paused.release();
            assert.equal((await linking).agentExecutionId, old.id);
          }
          assert.equal(await secondStore.expireLaunchIntent(old.id, CUTOFF, NOW), false);
          assert.ok((await database.findAgentExecutionById(old.id))?.launchIntent);
        } else {
          const expiring = firstStore.expireLaunchIntent(old.id, CUTOFF, NOW);
          await paused.held;
          const rejected = assert.rejects(
            secondStore.linkWorkflowStepRunExecution(step, old.id),
            /launch intent expired/u,
          );
          try {
            await vi.waitFor(async () => {
              const result = await other.runtime.query<{ waiting: boolean }>(
                "select exists (select 1 from pg_locks where locktype = 'transactionid' and not granted) as waiting",
              );
              assert.equal(result.rows[0]?.waiting, true);
            });
          } finally {
            paused.release();
            await Promise.allSettled([expiring, rejected]);
          }
          assert.equal(await expiring, true);
          await rejected;
          const untouched = await database.findWorkflowStepRunById(step);
          assert.equal(untouched?.status, "pending");
          assert.equal(untouched.agentExecutionId, null);
          assert.equal((await database.findAgentExecutionById(old.id))?.launchIntent, null);
        }
      } finally {
        paused.release();
        await Promise.all([runtime.close(), other.runtime.close()]);
      }
    },
  );

  it("keeps a nonarchiving launch while its finish acknowledgement is pending", async () => {
    const { runtime, database } = await freshDatabase();
    try {
      const { id } = await arrivals(database).arrival();
      await runtime.query(
        `update agent_executions
         set launch_intent = (launch_intent - 'continuation') || '{"autoArchive": false}' where id = $1`,
        [id],
      );
      const observation = { kind: "finish_execution", callId: "fixture-call" } as const;
      await database.recordAgentExecutionHubAcknowledgement(id, {
        ...observation,
        status: "running",
        observedAt: OLD,
      });
      await database.transitionAgentExecution(id, "succeeded", {
        completedByAgent: true,
        hubAction: null,
      });
      await runtime.query("update agent_executions set completed_at = $2 where id = $1", [id, OLD]);
      const report = await drain(new RunPayloadRetention(database, settings));
      assert.equal(report.auxiliaryCounts.launchIntent.pending_hub_action?.count, 1);
      assert.equal(report.launchIntentsExpired, 0);
      assert.equal(await database.expireLaunchIntent(id, CUTOFF, NOW), false);
      const acknowledged = await database.recordAgentExecutionHubAcknowledgement(id, {
        ...observation,
        status: "completed",
        observedAt: NOW,
      });
      assert.equal(
        acknowledged?.hubActionAcknowledgements.finishExecutionCall?.status,
        "completed",
      );
      assert.equal(await database.expireLaunchIntent(id, CUTOFF, NOW), true);
    } finally {
      await runtime.close();
    }
  });
});
