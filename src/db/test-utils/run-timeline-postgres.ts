import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase } from "../pg.js";
import { postgresDatabaseRuntime } from "../runtime/index.js";
import type { DatabaseRuntime, QueryHandle, QueryResult, QueryRow } from "../runtime/index.js";
import { createPostgresTestRuntime } from "./runtime.js";
import type { AppendRunTimelineEventInput } from "../../run-timeline/store.js";
import type { AcceptedTriggerRunRecord, Database } from "../types.js";

export const TIMELINE_ORGANIZATION = "pooled-timeline-organization";

export interface TimelineQueryHooks {
  beforeQuery?: (sql: string) => Promise<void>;
  afterQuery?: (sql: string) => Promise<void>;
}

export interface TimelinePostgresConnection {
  runtime: DatabaseRuntime;
  database: Database;
  pid: number;
}

export interface TimelinePostgresHarness {
  runtime: DatabaseRuntime;
  database: Database;
  createRun(): Promise<AcceptedTriggerRunRecord>;
  connect(hooks?: TimelineQueryHooks): Promise<TimelinePostgresConnection>;
  waitForLockOrRead(pid: number, wasRead?: () => boolean): Promise<"blocked" | "read">;
  close(): Promise<void>;
}

function observedRuntime(runtime: DatabaseRuntime, hooks: TimelineQueryHooks): DatabaseRuntime {
  async function query<Row extends QueryRow>(
    target: QueryHandle,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    await hooks.beforeQuery?.(sql);
    const result = await target.query<Row>(sql, params);
    await hooks.afterQuery?.(sql);
    return result;
  }
  return {
    query: (sql, params) => query(runtime, sql, params),
    drizzle: () => runtime.drizzle(),
    migrate: () => runtime.migrate(),
    close: () => runtime.close(),
    transaction: (operation) =>
      runtime.transaction((transaction) =>
        operation({
          query: (sql, params) => query(transaction, sql, params),
          drizzle: () => transaction.drizzle(),
          rollback: (result) => transaction.rollback(result),
        }),
      ),
  };
}

export async function createTimelinePostgresHarness(): Promise<TimelinePostgresHarness> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const connections: DatabaseRuntime[] = [];
  try {
    const root = await createPostgresTestRuntime(container.getConnectionUri());
    connections.push(root.runtime);
    await root.runtime.query(
      "insert into organization (id, name, slug) values ($1, 'Timeline', 'timeline')",
      [TIMELINE_ORGANIZATION],
    );
    const project = await root.database.createProject({
      organizationId: TIMELINE_ORGANIZATION,
      name: "Pooled timeline contracts",
      slug: "pooled-timeline-contracts",
      createdByUserId: null,
    });
    return {
      runtime: root.runtime,
      database: root.database,
      async createRun() {
        const revision = await root.database.insertProjectConfigurationRevision({
          projectId: project.id,
          sourceKind: "manual",
          sourceEvidence: { kind: "test" },
          normalizedConfiguration: { environments: [], triggers: [] },
          contentHash: "pooled-timeline-configuration",
        });
        await root.database.activateProjectConfigurationRevision(project.id, revision.id, []);
        const receipt = await root.database.persistManualEvent({
          organizationId: TIMELINE_ORGANIZATION,
          projectId: project.id,
          deliveryId: randomUUID(),
          source: "manual.run",
          payload: {},
          receivedAt: new Date(),
        });
        assert.equal(receipt.status, "accepted");
        if (receipt.status !== "accepted") throw new Error("Manual receipt was not accepted");
        return (
          await root.database.createAcceptedTriggerRun({
            organizationId: TIMELINE_ORGANIZATION,
            projectId: project.id,
            configurationRevisionId: revision.id,
            providerEventReceiptId: receipt.event.providerEventReceiptId,
            configuredTriggerName: "timeline",
            prompt: "",
            inputs: {},
            triggerContext: {},
            outputContext: {},
            deadlineAt: new Date(Date.now() + 3600000),
            stepIds: ["work"],
          })
        ).run;
      },
      async connect(hooks: TimelineQueryHooks = {}) {
        const bundle = await postgresDatabaseRuntime(container.getConnectionUri(), { max: 1 });
        connections.push(bundle.runtime);
        const { rows } = await bundle.runtime.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        const runtime = observedRuntime(bundle.runtime, hooks);
        return { runtime, pid: rows[0]!.pid, database: createDatabase(runtime, bundle.locks) };
      },
      async waitForLockOrRead(pid: number, wasRead: () => boolean = () => false) {
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) {
          if (wasRead()) return "read" as const;
          const result = await root.runtime.query<{ blocked: boolean }>(
            "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
            [pid],
          );
          if (result.rows[0]!.blocked) return "blocked" as const;
          await delay(5);
        }
        throw new Error("PostgreSQL did not reach the expected lock wait or state read");
      },
      async close() {
        await Promise.all(connections.map((runtime) => runtime.close()));
        await container.stop();
      },
    };
  } catch (error) {
    await Promise.all(connections.map((runtime) => runtime.close()));
    await container.stop();
    throw error;
  }
}

export function pooledTimelineEvent(
  runId: string,
  patch: Partial<AppendRunTimelineEventInput> = {},
): AppendRunTimelineEventInput {
  return {
    triggerRunId: runId,
    organizationId: TIMELINE_ORGANIZATION,
    kind: "turn_started",
    origin: "captured",
    at: new Date(),
    data: {},
    ...patch,
  };
}
