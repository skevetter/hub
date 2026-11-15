import { randomUUID } from "node:crypto";
import type { DatabaseRuntime, QueryHandle, QueryRow } from "../../../db/runtime/index.js";
import type { Locks } from "../../../db/runtime/locks/index.js";
import { acceptWorkflowRun } from "../../../db/workflow-intake.js";
import { parseCompiledHubConfig } from "../../../config/compiler.js";
import { defaultInputs } from "../../invocation.js";
import { matchesNotification } from "../match.js";
import {
  notificationDeliveryId,
  type NotificationPayload,
  toNotificationPayload,
} from "../notification.js";
import type {
  DeliveryBatch,
  DeliveryOutcome,
  GitHubNotificationStore,
  NotificationCursor,
  NotificationPollStatus,
} from "../poller.js";

const SOURCE = "notifications";
const LOCK_KEY = "github-notifications:poll";
export const NOTIFICATION_EVENT = "github.notification";

interface CursorRow extends QueryRow {
  last_modified: string | null;
  since: Date;
  next_poll_at: Date;
}

interface StatusRow extends QueryRow {
  last_success_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  next_poll_at: Date;
}

interface TriggerRow extends QueryRow {
  organization_id: string;
  runtime_project_id: string;
  configuration_revision_id: string;
  normalized_configuration: unknown;
}

export class GitHubNotificationRepository implements GitHubNotificationStore {
  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
  ) {}

  /** Only one process polls at a time; a second one waits, then finds the cursor not yet due. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.locks.withLock(LOCK_KEY, operation);
  }

  async readCursor(): Promise<NotificationCursor | undefined> {
    const result = await this.runtime.query<CursorRow>(
      "select last_modified, since, next_poll_at from github_notification_cursors where source = $1",
      [SOURCE],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { lastModified: row.last_modified, since: row.since, nextPollAt: row.next_poll_at };
  }

  async saveCursor(cursor: NotificationCursor, now: Date): Promise<void> {
    await writeCursor(this.runtime, cursor, now);
  }

  /** The cursor row exists after the first poll, so a call before that updates nothing. */
  async recordSuccess(now: Date): Promise<void> {
    await this.runtime.query(
      "update github_notification_cursors set last_success_at = $2, last_error = null where source = $1",
      [SOURCE, now],
    );
  }

  async recordFailure(now: Date, message: string): Promise<void> {
    await this.runtime.query(
      "update github_notification_cursors set last_error = $2, last_error_at = $3 where source = $1",
      [SOURCE, message, now],
    );
  }

  async readStatus(): Promise<NotificationPollStatus> {
    const result = await this.runtime.query<StatusRow>(
      "select last_success_at, last_error, last_error_at, next_poll_at from github_notification_cursors where source = $1",
      [SOURCE],
    );
    const row = result.rows[0];
    return {
      lastSuccessAt: row?.last_success_at ?? null,
      lastError: row?.last_error ?? null,
      lastErrorAt: row?.last_error_at ?? null,
      nextPollAt: row?.next_poll_at ?? null,
    };
  }

  async countDelivered(organizationId: string, since: Date): Promise<number> {
    const result = await this.runtime.query<{ count: number }>(
      `select count(*)::integer as count from provider_event_receipts
      where organization_id = $1 and provider = 'github_notification' and received_at >= $2`,
      [organizationId, since],
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Receipts, runs and the cursor commit together, so a failed delivery is polled again. Threads
   * are handled oldest first. Once `limit` threads have started runs, the next thread that would
   * start one stops delivery and the cursor is set to resume behind the last delivered thread.
   */
  async deliver(batch: DeliveryBatch, now: Date): Promise<DeliveryOutcome> {
    return this.runtime.transaction(async (transaction) => {
      const triggers = await listTriggers(transaction);
      let started = 0;
      let delivered = 0;
      let lastDelivered: Date | undefined;
      let deferred = false;
      for (const thread of batch.threads) {
        const payload = toNotificationPayload(thread);
        const matches = matchingTriggers(triggers, payload);
        const fresh = await organizationsWithoutReceipt(transaction, matches, payload);
        if (fresh.size === 0) continue;
        if (delivered >= batch.limit) {
          deferred = true;
          break;
        }
        started += await deliverThread(transaction, matches, fresh, payload, now);
        delivered++;
        const updated = Date.parse(thread.updated_at);
        lastDelivered = Number.isFinite(updated) ? new Date(updated) : undefined;
      }
      await writeCursor(
        transaction,
        deferred ? batch.stoppedCursor(lastDelivered) : batch.cursor,
        now,
      );
      return { started, deferred };
    });
  }
}

async function writeCursor(
  handle: QueryHandle,
  cursor: NotificationCursor,
  now: Date,
): Promise<void> {
  await handle.query(
    `insert into github_notification_cursors (source, last_modified, since, next_poll_at, updated_at)
    values ($1, $2, $3, $4, $5)
    on conflict (source) do update
    set last_modified = excluded.last_modified, since = excluded.since,
        next_poll_at = excluded.next_poll_at, updated_at = excluded.updated_at`,
    [SOURCE, cursor.lastModified, cursor.since, cursor.nextPollAt, now],
  );
}

/** Same selection as the schedule source: the owning project's active configuration revision. */
async function listTriggers(transaction: QueryHandle): Promise<TriggerRow[]> {
  const result = await transaction.query<TriggerRow>(
    `select t.organization_id, t.runtime_project_id,
      p.active_configuration_revision_id as configuration_revision_id, r.normalized_configuration
    from organization_triggers t
    join projects p on p.id = t.runtime_project_id
    join project_configuration_revisions r on r.id = p.active_configuration_revision_id
    where t.enabled and r.normalized_configuration @> $1::jsonb
    order by t.organization_id, t.id`,
    [JSON.stringify({ triggers: [{ on: NOTIFICATION_EVENT }] })],
  );
  return result.rows;
}

interface TriggerMatch {
  row: TriggerRow;
  trigger: CompiledTrigger;
}

type CompiledTrigger = ReturnType<typeof parseCompiledHubConfig>["triggers"][number];

function matchingTriggers(
  triggers: readonly TriggerRow[],
  payload: NotificationPayload,
): TriggerMatch[] {
  return triggers.flatMap((row) => {
    const trigger = parseCompiledHubConfig(row.normalized_configuration).triggers.find(
      ({ on }) => on === NOTIFICATION_EVENT,
    );
    return trigger !== undefined && matchesNotification(payload, trigger.filters)
      ? [{ row, trigger }]
      : [];
  });
}

/** Organizations with a matching trigger that have not yet received this thread update. */
async function organizationsWithoutReceipt(
  transaction: QueryHandle,
  matches: readonly TriggerMatch[],
  payload: NotificationPayload,
): Promise<Set<string>> {
  const organizations = [...new Set(matches.map(({ row }) => row.organization_id))];
  if (organizations.length === 0) return new Set();
  const received = await transaction.query<{ organization_id: string }>(
    `select organization_id from provider_event_receipts
    where organization_id = any($1::text[]) and delivery_id = $2`,
    [organizations, notificationDeliveryId(payload)],
  );
  const have = new Set(received.rows.map((row) => row.organization_id));
  return new Set(organizations.filter((organizationId) => !have.has(organizationId)));
}

async function deliverThread(
  transaction: QueryHandle,
  matches: readonly TriggerMatch[],
  organizations: ReadonlySet<string>,
  payload: NotificationPayload,
  now: Date,
): Promise<number> {
  let started = 0;
  for (const organizationId of organizations) {
    const own = matches.filter(({ row }) => row.organization_id === organizationId);
    const deliveryId = notificationDeliveryId(payload);
    const event = { github_notification: payload };
    const receiptId = randomUUID();
    const inserted = await transaction.query(
      `insert into provider_event_receipts
      (id, organization_id, provider, delivery_id, source, repo, payload, received_at, accepted_routes)
      values ($1, $2, 'github_notification', $3, $4, $5, $6, $7, $8)
      on conflict (organization_id, delivery_id) do nothing`,
      [
        receiptId,
        organizationId,
        deliveryId,
        NOTIFICATION_EVENT,
        payload.repo,
        event,
        now,
        JSON.stringify(
          own.map(({ row }) => ({
            projectId: row.runtime_project_id,
            configurationRevisionId: row.configuration_revision_id,
            connectionId: null,
            resourceId: null,
          })),
        ),
      ],
    );
    // The organization already received this thread update on an earlier or overlapping poll.
    if (inserted.rowCount === 0) continue;
    for (const { row, trigger } of own) {
      await acceptWorkflowRun(transaction, {
        organizationId,
        projectId: row.runtime_project_id,
        configurationRevisionId: row.configuration_revision_id,
        providerEventReceiptId: receiptId,
        configuredTriggerName: trigger.name,
        prompt: "",
        inputs: defaultInputs(trigger.inputs),
        triggerContext: { provider: "github_notification", deliveryId, event },
        outputContext: { provider: "github_notification" },
        conversation: null,
        deadlineAt: new Date(now.getTime() + trigger.maxRuntimeMs),
        stepIds: trigger.steps.map(({ id }) => id),
        createdAt: now,
      });
      started++;
    }
  }
  return started;
}
